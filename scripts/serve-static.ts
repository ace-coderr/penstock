/**
 * `pnpm serve:static`: serves apps/console/dist the way Cloudflare static assets do, for checking the
 * hosted demo locally. It applies _headers (including the Content-Security-Policy), the 200
 * rewrites in _redirects, and single-page-application not_found_handling (unknown paths get the
 * app shell). Port 4032 by default (STATIC_PORT).
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "apps", "console", "dist");
const port = Number(process.env.STATIC_PORT ?? 4032);
if (!existsSync(join(root, "index.html"))) {
  console.error("apps/console/dist is missing: run `pnpm build:static` first");
  process.exit(1);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png",
};

/** Headers from the "/*" block of _headers (the only block the demo uses). */
function loadHeaders(): Record<string, string> {
  const file = join(root, "_headers");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  let inAll = false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      inAll = line.trim() === "/*";
      continue;
    }
    const i = line.indexOf(":");
    if (inAll && i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** 200 rewrites from _redirects: [pattern, target]; a trailing "*" matches any suffix. */
function loadRewrites(): [string, string][] {
  const file = join(root, "_redirects");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/)).filter((p) => p[2] === "200").map((p) => [p[0]!, p[1]!]);
}

const headers = loadHeaders();
const rewrites = loadRewrites();

function resolveFile(pathname: string): string | null {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const full = join(root, safe);
  if (!full.startsWith(root)) return null;
  if (existsSync(full) && statSync(full).isFile()) return full;
  if (existsSync(join(full, "index.html"))) return join(full, "index.html");
  return null;
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://static.local");
  let path = url.pathname;
  for (const [pattern, target] of rewrites) {
    const hit = pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
    if (hit) {
      path = target;
      break;
    }
  }
  let file = resolveFile(path);
  // not_found_handling = "single-page-application": any path that is not an asset gets the app shell.
  if (!file && !extname(path)) file = join(root, "index.html");
  if (!file) {
    res.writeHead(404, { ...headers, "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { ...headers, "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => {
  console.log(`hosted demo (static) on http://localhost:${port}/  (rewrites: ${rewrites.length}, headers: ${Object.keys(headers).length})`);
});
