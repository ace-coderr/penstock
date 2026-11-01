import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = "error") {
    super(message);
  }
}

export async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "request body too large", "body_too_large");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "request body too large", "body_too_large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T>(req: IncomingMessage, limit?: number): Promise<T> {
  const raw = await readBody(req, limit);
  if (raw.length === 0) return {} as T;
  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "body is not valid JSON", "invalid_json");
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** Header values set by Penstock are ASCII without CR/LF; anything else is dropped. */
function safeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^[A-Za-z0-9-]+$/.test(k) && /^[\x20-\x7e]*$/.test(v)) out[k] = v;
  }
  return out;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", ...safeHeaders(headers) });
  res.end(JSON.stringify(body));
}

export function sendRaw(res: ServerResponse, status: number, body: Buffer | string, headers: Record<string, string>): void {
  if (res.headersSent) return;
  res.writeHead(status, { ...SECURITY_HEADERS, ...safeHeaders(headers) });
  res.end(body);
}

/** Client address from the socket. X-Forwarded-For is only honoured when TRUST_PROXY=true. */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first && /^[0-9a-fA-F:.]{2,45}$/.test(first)) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
