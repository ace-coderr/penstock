/**
 * `pnpm audit:static`: checks the hosted demo build in apps/console/dist (run `pnpm build:static`
 * first). Exits non-zero on any failure. Checks:
 *   - no keys, tokens, credentials or personal data in any shipped file;
 *   - no data: URIs (the CSP allows same-origin assets only) and no server API code;
 *   - the only network call sites are same-origin (module preload, /demo-snapshot.json);
 *   - _headers carries the CSP with connect-src 'self'; _redirects rewrites /app routes;
 *   - reduced-motion rules made it into the bundled CSS;
 *   - share basics: SVG favicon, 1200x630 social card PNG, title, description, Open Graph and Twitter tags;
 *   - every snapshot row is flagged simulated and every hash is a "sim" value.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "..", "apps", "console", "dist");
const failures: string[] = [];
const notes: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  (ok ? notes : failures).push(`${ok ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

let files: string[];
try {
  files = walk(dist);
} catch {
  console.error("apps/console/dist is missing: run `pnpm build:static` first");
  process.exit(1);
}
const text = files.filter((f) => [".js", ".css", ".html", ".json", ""].includes(extname(f)) || /_headers|_redirects/.test(f));
const read = (f: string) => readFileSync(f, "utf8");

const SECRETS: [string, RegExp][] = [
  ["private key", /BEGIN [A-Z ]*PRIVATE KEY/],
  ["session secret hash", /secretHash|secret_hash/],
  ["operation token secret", /OPERATION_TOKEN_SECRET|operationTokenSecret/],
  ["admin / facilitator / 1Click credentials", /ADMIN_TOKEN=|FACILITATOR_API_KEY|ONECLICK_JWT|RESALE_NEAR_KEY/],
  ["JWT", /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
  // Anchored to a token boundary: receipt signatures are long base64url strings that can contain "sk-".
  ["GitHub / API key shapes", /(?<![A-Za-z0-9_-])(ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/],
  ["NEAR secret key", /ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/],
  ["email address", /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9.-]+\.(com|org|net|io|dev)\b/],
];
for (const [label, re] of SECRETS) {
  const hits = text.filter((f) => re.test(read(f))).map((f) => relative(dist, f));
  check(hits.length === 0, `no ${label}`, hits.join(", "));
}

const assets = text.filter((f) => /assets[\\/].+\.(js|css)$/.test(f));
const bundle = assets.map(read).join("\n");
check(!/url\(data:/.test(bundle), "no data: URIs in CSS");
check(!/\/api\/(admin|public)/.test(bundle), "no server API paths in the bundle");
check(!/Bearer /.test(bundle) && !/localStorage/.test(bundle), "no token handling or browser storage in the bundle");
const fetches = [...bundle.matchAll(/fetch\(([^)]{0,80})\)/g)].map((m) => m[1]!);
const sameOrigin = (a: string) => /^`\/[^/]/.test(a) || /^"\/[^/]/.test(a) || /^[a-z]\.href,/.test(a) || /^[a-z]{1,2}\.href/.test(a);
check(fetches.length > 0 && fetches.every(sameOrigin), "every fetch() is same-origin", fetches.join(" | "));
check(!/new WebSocket|sendBeacon|new EventSource|XMLHttpRequest/.test(bundle), "no WebSocket, beacon, EventSource or XHR");

const headers = read(join(dist, "_headers"));
check(/connect-src 'self'/.test(headers) && /default-src 'self'/.test(headers) && /font-src 'self'/.test(headers), "_headers sets a same-origin CSP");
const redirects = read(join(dist, "_redirects"));
check(/^\/app\s+\/\s+200/m.test(redirects) && /^\/app\/\*\s+\/\s+200/m.test(redirects), "_redirects rewrites /app routes to the app shell");
check(!files.some((f) => /404\.html$/.test(f)), "no 404.html, so single-page-application not_found_handling applies");

const css = assets.filter((f) => f.endsWith(".css")).map(read).join("\n");
const reduce = (css.match(/prefers-reduced-motion:\s*reduce/g) ?? []).length;
check(reduce >= 3, "reduced-motion rules are in the bundled CSS", `${reduce} blocks`);
check(/animation-duration:\s*\.?0?\.001ms\s*!important/.test(css), "reduced motion stops all animations");

const html = read(join(dist, "index.html"));
const card = readFileSync(join(dist, "social-card.png"));
const pngSize = card.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? [card.readUInt32BE(16), card.readUInt32BE(20)] : [0, 0];
check(pngSize[0] === 1200 && pngSize[1] === 630, "social card is a 1200x630 PNG", pngSize.join("x"));
check(html.includes('<link rel="icon" type="image/svg+xml" href="/favicon.svg"') && read(join(dist, "favicon.svg")).startsWith("<svg"), "SVG favicon served from the same origin");
const meta = ["og:title", "og:description", "og:image", "twitter:card", "twitter:image", "description", "theme-color"];
const missing = meta.filter((m) => !new RegExp(`(property|name)="${m}" content="[^"]+"`).test(html));
check(missing.length === 0, "title, description, theme-color, Open Graph and Twitter tags", missing.join(", "));
const images = [...html.matchAll(/(?:og|twitter):image" content="([^"]+)"/g)].map((m) => m[1]!);
check(images.every((u) => u.endsWith("/social-card.png") && !u.includes("%")), "card URL points at the same-origin social-card.png", images.join(" | "));

const snap = JSON.parse(read(join(dist, "demo-snapshot.json"))) as { payments: { simulated: boolean; originTx: string | null; destTx: string | null }[]; sessions: { simulated: boolean }[] };
check(snap.payments.every((p) => p.simulated) && snap.sessions.every((s) => s.simulated), "every snapshot row is flagged simulated", `${snap.payments.length} payments`);
check(snap.payments.every((p) => [p.originTx, p.destTx].every((h) => h === null || h.startsWith("sim"))), "every transaction hash is a sim value");

console.log(`hosted demo audit: ${files.length} files in apps/console/dist\n`);
for (const n of notes) console.log(`  ${n}`);
for (const f of failures) console.log(`  ${f}`);
console.log(failures.length ? `\nFAIL (${failures.length})` : "\nPASS");
process.exit(failures.length ? 1 : 0);
