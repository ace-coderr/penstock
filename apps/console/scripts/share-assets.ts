/**
 * Share assets, generated at build time so they are served from the same origin as the page:
 *   favicon.svg      the sluice-gate mark
 *   social-card.png  1200x630 Open Graph / Twitter card, drawn as SVG and rendered to PNG
 * Text on the card is converted to outlines from the bundled @fontsource files, so rendering does
 * not depend on fonts installed on the build machine.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import opentype from "opentype.js";
import { Resvg } from "@resvg/resvg-js";

const require = createRequire(import.meta.url);
const BG = "#0a0b0d";
const TEXT = "#ecebe6";
const TEXT_2 = "#a8adb4";
const TEXT_3 = "#868b93";
const LINE = "#24272c";
const ACCENT = "#4fd1c5";

const MARK = `<g fill="none" stroke-linecap="round"><path d="M2 6 C9 6 9 14 15 14 M2 14 H15 M2 22 C9 22 9 14 15 14" stroke="${ACCENT}" stroke-width="1.8"/><rect x="15" y="7.5" width="5" height="13" rx="1" stroke="${TEXT}" stroke-width="1.6"/><path d="M20 14 H27" stroke="${TEXT}" stroke-width="1.8"/></g>`;

export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" rx="6" fill="${BG}"/>${MARK}</svg>\n`;
}

function font(pkg: string, file: string): opentype.Font {
  const dir = join(dirname(require.resolve(`${pkg}/package.json`)), "files");
  const buf = readFileSync(join(dir, file));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** Text as an SVG path, so the card renders the same everywhere. */
function text(f: opentype.Font, s: string, x: number, y: number, size: number, fill: string, tracking = 0): string {
  if (!tracking) return `<path fill="${fill}" d="${f.getPath(s, x, y, size).toPathData(2)}"/>`;
  let cx = x;
  const parts: string[] = [];
  for (const ch of s) {
    parts.push(f.getPath(ch, cx, y, size).toPathData(2));
    cx += f.getAdvanceWidth(ch, size) + tracking;
  }
  return `<path fill="${fill}" d="${parts.join(" ")}"/>`;
}

function width(f: opentype.Font, s: string, size: number, tracking = 0): number {
  return f.getAdvanceWidth(s, size) + tracking * Math.max(0, [...s].length - 1);
}

export function socialCardSvg(): string {
  const serif = font("@fontsource/newsreader", "newsreader-latin-400-normal.woff");
  const serifItalic = font("@fontsource/newsreader", "newsreader-latin-400-italic.woff");
  const sans = font("@fontsource/geist-sans", "geist-sans-latin-500-normal.woff");
  const mono = font("@fontsource/jetbrains-mono", "jetbrains-mono-latin-500-normal.woff");

  const grid: string[] = [];
  for (let x = 0; x <= 1200; x += 48) grid.push(`M${x} 0V630`);
  for (let y = 6; y <= 630; y += 48) grid.push(`M0 ${y}H1200`);

  // Six chain intakes converging through one gate into one account (right side).
  const chains = ["Base", "Arbitrum", "Solana", "Ethereum", "Bitcoin", "Optimism"];
  const gate = { x: 994, y: 315 };
  const flows = chains
    .map((name, i) => {
      const y = 150 + i * 66;
      const d = `M${874} ${y} C ${940} ${y}, ${940} ${gate.y}, ${gate.x - 8} ${gate.y}`;
      return `<path d="${d}" fill="none" stroke="${ACCENT}" stroke-opacity="${0.35 + i * 0.06}" stroke-width="${1.6 + (i % 3)}"/>` +
        `<rect x="${762}" y="${y - 19}" width="112" height="38" rx="8" fill="#14161a" stroke="${LINE}"/>` +
        text(mono, name, 774, y + 6, 14, TEXT);
    })
    .join("");

  const chip = (label: string, x: number, accent = false) => {
    const w = width(mono, label, 15, 0.6) + 28;
    return {
      w,
      svg: `<rect x="${x}" y="514" width="${w}" height="38" rx="19" fill="${accent ? "#11302e" : "#14161a"}" stroke="${accent ? ACCENT : LINE}" stroke-opacity="${accent ? 0.6 : 1}"/>` +
        text(mono, label, x + 14, 538, 15, accent ? ACCENT : TEXT, 0.6),
    };
  };
  let cx = 72;
  const chips = [["HTTP 402", false], ["NEAR Intents · 1Click", false], ["USDC on NEAR", true]].map(([l, a]) => {
    const c = chip(l as string, cx, a as boolean);
    cx += c.w + 12;
    return c.svg;
  }).join("");

  const line1 = "Let any agent pay you,";
  const line2 = "from any chain.";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${ACCENT}" stop-opacity="0.32"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="${BG}"/>
  <path d="${grid.join("")}" stroke="${LINE}" stroke-width="1" opacity="0.55"/>
  <circle cx="${gate.x + 40}" cy="${gate.y}" r="260" fill="url(#glow)"/>
  <rect x="740" y="96" width="420" height="438" rx="20" fill="#111317" fill-opacity="0.55" stroke="${LINE}"/>
  ${flows}
  <rect x="${gate.x - 8}" y="${gate.y - 46}" width="22" height="92" rx="4" fill="#14161a" stroke="${TEXT}" stroke-width="2"/>
  <path d="M${gate.x + 14} ${gate.y} H1030" stroke="${ACCENT}" stroke-width="5" stroke-linecap="round"/>
  <rect x="1030" y="${gate.y - 44}" width="116" height="88" rx="12" fill="#11302e" stroke="${ACCENT}" stroke-opacity="0.7"/>
  ${text(mono, "USDC · NEAR", 1042, gate.y - 6, 14, ACCENT)}
  ${text(mono, "one account", 1042, gate.y + 20, 12, TEXT_2)}
  <g transform="translate(72 70) scale(2)">${MARK}</g>
  ${text(serif, "Penstock", 140, 112, 40, TEXT)}
  ${text(serif, line1, 72, 256, 58, TEXT, -0.6)}
  ${text(serifItalic, line2, 72, 326, 58, TEXT, -0.6)}
  ${text(sans, "An x402 paywall for any API or MCP tool.", 72, 392, 23, TEXT_2)}
  ${text(sans, "Agents pay with any token on any chain;", 72, 424, 23, TEXT_2)}
  ${text(sans, "you receive USDC on NEAR.", 72, 456, 23, TEXT_2)}
  ${chips}
  ${text(mono, "OPEN SOURCE · MIT", 72, 596, 13, TEXT_3, 1.2)}
</svg>
`;
}

export function socialCardPng(): Buffer {
  return Buffer.from(new Resvg(socialCardSvg(), { fitTo: { mode: "width", value: 1200 }, font: { loadSystemFonts: false } }).render().asPng());
}
