import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Example upstream services that sellers put behind Penstock. They know nothing about payments:
 * Penstock only forwards a request here after it has been paid for. Outputs are deterministic
 * so the demo is reproducible; they are sample data, not real forecasts.
 */

const HARBOURS: Record<string, { name: string; lat: number; lon: number; locode: string; m2: number; phase: number }> = {
  rotterdam: { name: "Rotterdam", lat: 51.95, lon: 4.14, locode: "NLRTM", m2: 0.92, phase: 1.1 },
  singapore: { name: "Singapore", lat: 1.26, lon: 103.84, locode: "SGSIN", m2: 1.28, phase: 2.4 },
  lagos: { name: "Lagos", lat: 6.43, lon: 3.4, locode: "NGLOS", m2: 0.61, phase: 0.3 },
  valparaiso: { name: "Valparaiso", lat: -33.03, lon: -71.63, locode: "CLVAP", m2: 0.55, phase: 3.0 },
  halifax: { name: "Halifax", lat: 44.65, lon: -63.57, locode: "CAHAL", m2: 0.73, phase: 4.2 },
  mombasa: { name: "Mombasa", lat: -4.06, lon: 39.67, locode: "KEMBA", m2: 1.42, phase: 5.1 },
};

const M2_PERIOD_H = 12.4206;

function harbour(q: string | null) {
  const key = (q ?? "rotterdam").toLowerCase().replace(/[^a-z]/g, "");
  return HARBOURS[key] ? { key, ...HARBOURS[key]! } : null;
}

function tides(key: string, fromMs: number) {
  const h = HARBOURS[key]!;
  const events: { type: "high" | "low"; at: string; heightM: number }[] = [];
  const startH = fromMs / 3_600_000;
  // Extremes of A*cos(2π t/T + φ) occur every T/2.
  let k = Math.ceil(((startH * 2 * Math.PI) / M2_PERIOD_H + h.phase) / Math.PI);
  while (events.length < 4) {
    const tH = ((k * Math.PI - h.phase) * M2_PERIOD_H) / (2 * Math.PI);
    const high = k % 2 === 0;
    events.push({ type: high ? "high" : "low", at: new Date(Math.round(tH * 3_600_000)).toISOString(), heightM: Number(((high ? 1 : -1) * h.m2 + 1.6).toFixed(2)) });
    k++;
  }
  return events;
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const PHRASES: Record<string, Record<string, string>> = {
  es: { "berth closed": "atracadero cerrado", "pilot required": "práctico obligatorio", "strong winds": "vientos fuertes", "harbour open": "puerto abierto" },
  fr: { "berth closed": "poste fermé", "pilot required": "pilote obligatoire", "strong winds": "vents forts", "harbour open": "port ouvert" },
  de: { "berth closed": "Liegeplatz gesperrt", "pilot required": "Lotsenpflicht", "strong winds": "starker Wind", "harbour open": "Hafen offen" },
};

function translate(text: string, to: string): string {
  const table = PHRASES[to] ?? PHRASES.es!;
  let out = text.toLowerCase();
  for (const [en, tr] of Object.entries(table)) out = out.split(en).join(tr);
  return out;
}

function weather(lat: number, lon: number, nowMs: number) {
  const seed = Math.abs(Math.sin(lat * 12.9898 + lon * 78.233 + Math.floor(nowMs / 3_600_000)) * 43758.5453) % 1;
  return { windKt: Math.round(6 + seed * 24), swellM: Number((0.4 + seed * 2.8).toFixed(1)), visibilityNm: Math.round(3 + (1 - seed) * 9), issuedAt: new Date(Math.floor(nowMs / 3_600_000) * 3_600_000).toISOString() };
}

function summarize(text: string): string[] {
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.slice(0, 3).map((s) => (s.length > 140 ? s.slice(0, 137) + "…" : s));
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const msg = JSON.parse(await readBody(req)) as { id?: number | string; method: string; params?: { name?: string; arguments?: { text?: string } } };
  const reply = (result: unknown) => send(res, 200, { jsonrpc: "2.0", id: msg.id ?? null, result });
  if (msg.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tidewater-summarize", version: "0.1.0" } });
  if (msg.method === "tools/list") return reply({ tools: [{ name: "summarize", description: "Summarise a notice to mariners into three lines.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
  if (msg.method === "tools/call" && msg.params?.name === "summarize") {
    const lines = summarize(String(msg.params.arguments?.text ?? ""));
    return reply({ content: [{ type: "text", text: lines.join("\n") }], structuredContent: { lines } });
  }
  send(res, 200, { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32601, message: "method not found" } });
}

export function createUpstreamServer(): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://upstream.local");
      const now = Date.now();
      switch (url.pathname) {
        case "/healthz":
          return send(res, 200, { ok: true });
        case "/tides": {
          const h = harbour(url.searchParams.get("harbor") ?? url.searchParams.get("harbour"));
          if (!h) return send(res, 404, { error: "unknown harbour", known: Object.keys(HARBOURS) });
          return send(res, 200, { harbour: h.name, locode: h.locode, datum: "LAT", events: tides(h.key, now), sample: true });
        }
        case "/geocode": {
          const h = harbour(url.searchParams.get("q"));
          if (!h) return send(res, 404, { error: "unknown harbour", known: Object.keys(HARBOURS) });
          return send(res, 200, { name: h.name, lat: h.lat, lon: h.lon, locode: h.locode });
        }
        case "/weather": {
          const lat = Number(url.searchParams.get("lat") ?? 51.95);
          const lon = Number(url.searchParams.get("lon") ?? 4.14);
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { error: "lat/lon out of range" });
          return send(res, 200, { lat, lon, ...weather(lat, lon, now), sample: true });
        }
        case "/translate": {
          const body = req.method === "POST" ? (JSON.parse((await readBody(req)) || "{}") as { text?: string; to?: string }) : {};
          const text = String(body.text ?? url.searchParams.get("text") ?? "").slice(0, 500);
          const to = String(body.to ?? url.searchParams.get("to") ?? "es");
          return send(res, 200, { to, text: translate(text, to) });
        }
        case "/filing":
          return send(res, 200, { ticker: (url.searchParams.get("ticker") ?? "ACME").toUpperCase().slice(0, 8), revenueUsdM: 412.7, netIncomeUsdM: 38.1, period: "FY2025", sample: true });
        case "/caption":
          return send(res, 200, { caption: "A container ship leaving port at dusk.", sample: true });
        case "/brief": {
          // Composer for the resale endpoint: Penstock pays the upstream sellers and passes their results here.
          const body = JSON.parse((await readBody(req)) || "{}") as { query?: Record<string, string>; upstream?: { url: string; status: number; body: unknown }[] };
          const h = harbour(body.query?.harbor ?? body.query?.harbour ?? url.searchParams.get("harbor")) ?? harbour("rotterdam")!;
          return send(res, 200, {
            harbour: h.name, locode: h.locode, tides: tides(h.key, now).slice(0, 2),
            weather: body.upstream?.[0]?.body ?? null, notice: body.upstream?.[1]?.body ?? null, sample: true,
          });
        }
        case "/mcp":
          if (req.method !== "POST") return send(res, 405, { error: "POST only" });
          return await handleMcp(req, res);
        default:
          return send(res, 404, { error: "not found" });
      }
    } catch (e) {
      send(res, 400, { error: (e as Error).message });
    }
  });
}

export { HARBOURS };
