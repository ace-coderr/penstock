# Penstock

Penstock lets you get paid by AI agents from any chain. It puts an x402 paywall in front of any HTTP API or MCP tool. Agents pay with whatever token they hold on whatever chain they are on, and the seller always receives USDC in one NEAR account, with clean books.

Built for NEAR HACKATHON (2026-11-01 to 2026-11-14). Tracks: `realworld` (Real-World Money) and `privacy` (Privacy & Private AI); it also fits `agents`.

## The problem it solves

An API seller who wants per-call payments from agents faces three problems:

1. Every agent holds a different asset on a different chain.
2. Bridging to the seller's chain is the agent's problem, so most agents simply leave.
3. The seller ends up with fragments on many chains and no ledger an accountant can read.

Penstock fixes all three at once. A seller protects an endpoint. An agent finds it, gets an HTTP 402, and pays from the wrong chain with the wrong token through NEAR Intents. The seller sees one inflow of USDC on NEAR, with per-payment signed receipts, refunds, a CSV export and a probe-to-purchase funnel.

## What is real and what is simulated

| | demo (default) | dry | live |
| --- | --- | --- | --- |
| x402 v2 headers, 402 flow, MCP transport | real | real | real |
| `exact` NEAR payment verification (`@x402/near`) | real verification, **simulated** chain state and relay | same as demo | real, through an x402 facilitator |
| 1Click quotes | **simulated** (priced from the recorded 1Click token list) | **real** 1Click dry quotes | real |
| Deposit addresses, deposits, swap status, refunds | **simulated** | **simulated** | real 1Click |
| Seed history (sellers, 450+ payments, 1,000+ probes) | **simulated** | **simulated** | none |
| Network, keys, funds needed | none | network only | yes (tiny amounts) |

Everything simulated is labelled "simulated" in the console, the API responses (`simulated: true`), the receipts and the terminal. Simulated hashes and addresses start with `sim`, so they cannot be mistaken for chain data.

## Try it: do X, see Y

You need Node 22.13+ (Node 24 recommended) and pnpm 9 (`corepack enable` provides it). Ports 4020, 4021 and 4030 must be free.

1. **Clone and install.**
   ```bash
   git clone https://github.com/ace-coderr/penstock.git
   ```
   ```bash
   cd penstock
   ```
   ```bash
   pnpm install
   ```
   You should see `Done` with no errors.

2. **Start the demo.** No keys, no funds, no network.
   ```bash
   pnpm demo
   ```
   You should see a banner that starts `PENSTOCK  demo mode: every quote, deposit and settlement is SIMULATED`. Under it are the URLs, followed by `agent  paid …` lines every 7 seconds from a simulated buyer agent. Your browser opens the seller console at http://localhost:4021/app. If it does not open, open the URL yourself (or use `pnpm dev`, which never opens a browser). The product's landing page is at http://localhost:4021/.

3. **Read the console in ten seconds.** On **01 Ledger** (http://localhost:4021/app) you should see:
   - the heading "What came in, and from where";
   - a large "Received into your account" total in USDC;
   - teal flow lines from about eight chains converging on one box, `USDC · NEAR tidewater-data.near`;
   - an amber `DEMO · SIMULATED` badge and banner.

   Each line's thickness is the USDC that arrived from that chain. Every tab opens with a heading that says what it is for.

   The landing page at http://localhost:4021/ shows the same flow as an isometric diagram. Its three large numbers are read live from the demo ledger, and each is labelled "simulated demo data".

4. **Watch the paywall refuse an unpaid call.**
   ```bash
   curl -i "http://localhost:4020/p/tidewater/tides?harbor=rotterdam"
   ```
   You should see `HTTP/1.1 402 Payment Required` and a `PAYMENT-REQUIRED` header (base64 x402 v2). The JSON body has 19 `accepts` entries: one `exact` entry for USDC on NEAR, plus one `near-intents` entry per origin asset (Base, Arbitrum, Solana, Ethereum, Bitcoin, and more).

5. **Pay it like an agent would.**
   ```bash
   pnpm selftest http://localhost:4020/p/tidewater/tides
   ```
   You should see eight ✓ lines and `PASS`. The price is $0.004, which is below every 1Click bridge minimum, so the self-test agent (holding USDC on Base and SOL on Solana) funds a prepaid session from SOL and is metered per call.

6. **Pay per call from another chain.**
   ```bash
   pnpm selftest "http://localhost:4020/p/tidewater/voyage-plan?harbor=lagos"
   ```
   This endpoint costs $0.25, which is above the Base route minimum. You should see `Cheapest route quoted: USDC on Base … fee … ~25s`, then `Paid and got the resource: HTTP 200 via near-intents from USDC on base [simulated]`, then `Signed receipt verifies`.

7. **Open the receipt.** In the console, go to **02 Payments** and click the newest receipt id. A drawer shows:
   - what you received and what the buyer paid, on which chain;
   - the route fee and the deposit address;
   - both transaction hashes, each tagged `simulated`;
   - `✓ Signature valid · ed25519` with the signed JSON.

8. **Export the books.** On **02 Payments**, the **Refunds** filter shows every payment the route returned to its payer. Click **Export CSV (30 days)**. You get `penstock-tidewater-….csv`, with one row per sale, session funding and session refund. The columns are gross, refund, upstream cost, net, what the buyer paid and on which chain, the route fee, and both hashes. Spreadsheet formula injection is neutralised.

9. **See where buyers dropped off.** On **03 Funnel** you should see probed → quoted → deposited → paid bars, and a "Why buyers stopped" table marked **INFERRED**. Reasons are inferred from behaviour, never stated by the buyer.

10. **See prepaid sessions.** **04 Sessions** lists the funded, spent and refunded amounts, and states the trust model.

11. **Protect a new endpoint.** On **05 Endpoints**, use "Protect an endpoint". Try upstream `http://169.254.169.254/latest`: it is refused. Try `https://api.example.com/fx`: you get a paid URL that answers 402.

12. **Check a payout account.** On **05 Endpoints**, enter `ghost-seller-123.near` under "Payout account check". You get a red "not found" message. In live mode this is a real NEAR RPC lookup; 1Click would otherwise reject the quote with an opaque error.

13. **Watch one agent pay another.**
    ```bash
    pnpm selftest "http://localhost:4020/p/tidewater/harbor-brief?harbor=halifax"
    ```
    This should PASS. Tidewater's `harbor-brief` endpoint ($0.025) buys from two other Penstock sellers before it answers: Northwind's marine weather ($0.006) and Quillfeed's translation ($0.008). It pays them from its own NEAR account. On **05 Endpoints**, `harbor-brief` shows "Margin / call $0.0110 after $0.0140 upstream". Its receipt drawer lists both upstream receipts as signed.

14. **Turn on shielded-payer mode.** Stop the demo (Ctrl+C), then run:
    ```bash
    pnpm demo --shielded
    ```
    The banner says `shielded    Confidential Intents route ON (simulated)`. On **05 Endpoints → Shielded payer routes** you should see:
    - Confidential Intents: **enabled**.
    - Aurora private chain: **not enabled**, with the reason.
    - What is hidden and what is not.

    New near-intents payments are booked as shielded. Without `--shielded`, both routes show "not enabled" and everything else works the same.

15. **Run the tests.**
    ```bash
    pnpm test
    ```
    You should see `Tests 109 passed`. `pnpm lint` and `pnpm typecheck` are also clean, and `pnpm check` runs all three.

16. **Use the buyer as an MCP server.** With the demo running, add this to any MCP client:
    ```json
    { "mcpServers": { "penstock-buyer": { "command": "pnpm", "args": ["-s", "--dir", "/path/to/penstock", "buyer-mcp"] } } }
    ```
    It exposes four tools:
    - `penstock_search`: find sellers by capability and price.
    - `penstock_routes`: rank the agent's holdings by cost.
    - `penstock_call`: handles 402s automatically; picks the cheapest chain, or funds a session.
    - `penstock_resume`: finish a payment after a deposit the agent made itself.

    Configure it with `PENSTOCK_DIRECTORIES`, `PENSTOCK_HOLDINGS`, `PENSTOCK_SIMULATED`, `PENSTOCK_NEAR_ACCOUNT` and `PENSTOCK_NEAR_KEY`.

17. **Dry mode: real 1Click quotes, no funds.**
    ```bash
    pnpm start:dry
    ```
    Then:
    ```bash
    pnpm selftest "http://localhost:4020/p/tidewater/voyage-plan?harbor=lagos"
    ```
    The route line now says `[1click-dry-quote]`, with live amounts and fees from `https://1click.chaindefuser.com`. Deposits and settlement are still simulated.

    Dry mode sends quotes to the existing NEAR account `near` unless you set `SELLER_NEAR_ACCOUNT`. 1Click rejects accounts that do not exist, and the demo name does not exist. The other demo sellers have made-up accounts, so their routes answer with the account message.

18. **Live mode: tiny amounts only.** Copy `.env.example` to `.env` and set:
    - `SELLER_NEAR_ACCOUNT`: an existing NEAR account that can hold USDC.
    - `OPERATION_TOKEN_SECRET`: 32+ random bytes.
    - `ADMIN_TOKEN`: 24+ characters.
    - `RESALE_NEAR_KEY`: only for resale endpoints. It is a full-access key of your payout account, used to pay upstream sellers. Resale endpoints refuse payment until it is set.
    - `FACILITATOR_URL` and `FACILITATOR_API_KEY`: an x402 facilitator for `near:mainnet`, such as an instance of [fastnear/x402-facilitator](https://github.com/fastnear/x402-facilitator). Its keys are approved by hand per payee.
    - Optionally `ONECLICK_JWT`: a partner JWT from [partners.near-intents.org](https://partners.near-intents.org). Without it 1Click adds 0.25% to every quote; with it the partner fee schedule applies and confidential quotes work. It is sent as the `X-API-Key` header and never logged.

    Then run:
    ```bash
    pnpm start:live
    ```
    In live mode the self-test makes a real 1Click dry quote and moves no funds:
    ```bash
    pnpm selftest https://your-host/p/<seller>/<slug>
    ```
    `--pay` with `PENSTOCK_NEAR_ACCOUNT` and `PENSTOCK_NEAR_KEY` pays one call in USDC on NEAR. It refuses anything above $0.05.

## Hosted demo (static, Cloudflare Workers static assets)

There is also a fully static build of the landing page and the console, for hosting. It makes **no server calls**:

- Every console request is answered in the browser by a simulated API with the same response shapes as the real admin API (`apps/console/src/static`).
- That API is fed by a snapshot of the seed data, generated at build time by the real seed generator.
- A parity test (`apps/proxy/test/static-parity.test.ts`) checks the in-browser responses against the real API for the same ledger.
- A simulated agent "pays" every few seconds, so the console stays live.

Every page carries a persistent banner: "Hosted demo: everything here is simulated. Run it locally for the real flow." Anything that needs the proxy or an admin token is removed or disabled: there is no token field, "Protect an endpoint" is disabled with a note, and the CSV is built in the browser. A `_headers` file sets a Content-Security-Policy with `connect-src 'self'`, so the browser itself blocks requests to other origins.

**Build and preview it locally:**
```bash
pnpm build:static
```
```bash
pnpm --filter @penstock/console preview:static
```
Open http://localhost:4031/ (landing) and http://localhost:4031/app (console). The output is in `apps/console/dist`.

To serve it with Cloudflare's static-assets rules (the `_headers` CSP and the `_redirects` rewrites) and audit the bundle:
```bash
pnpm serve:static
```
```bash
pnpm audit:static
```
`serve:static` serves http://localhost:4032/. `audit:static` checks the build: no secrets or personal data, no `data:` URIs, only same-origin requests, the CSP and rewrites in place, reduced-motion rules present, every row simulated. It prints `PASS` or the failures.

**Deployment.** The hosted demo is deployed as a **Cloudflare Workers static-assets site**: a Worker with no server code that serves `apps/console/dist`. The repository-root `wrangler.toml` declares it:

```toml
name = "penstock"
compatibility_date = "2026-11-01"

[assets]
directory = "./apps/console/dist"
not_found_handling = "single-page-application"
```

**Cloudflare dashboard values** (Workers & Pages → Create → Workers → import this repository):

| Setting | Value |
| --- | --- |
| Build command | `pnpm build:static` |
| Deploy command | `npx wrangler deploy` |
| Root directory | *(leave empty: the repository root)* |
| Variable | `NODE_VERSION` = `22` |
| Variable | `PNPM_VERSION` = `9.15.9` |
| Variable (optional) | `SITE_URL` = the site address, e.g. `https://penstock.<your-subdomain>.workers.dev` |

The build command writes the site to `apps/console/dist`. `npx wrangler deploy` then reads `wrangler.toml` and uploads that directory as the Worker's static assets.

Workers static assets apply the `_headers` and `_redirects` files in that directory, both copied from `apps/console/static-public/`:
- `_headers` sets the CSP and security headers.
- `_redirects` rewrites `/app` and `/app/*` to the app shell with 200 proxying.
- `not_found_handling = "single-page-application"` also serves `index.html` for any other navigation, so refreshing a console route works.

The build also writes `favicon.svg` and a 1200x630 `social-card.png` (drawn as SVG and rendered at build time) next to `index.html`, so link previews load from the same origin under the strict CSP. Set `SITE_URL` to make the Open Graph and Twitter image URLs absolute; without it they are root-relative, which some link unfurlers ignore.

No secrets are needed or used: the only build variables are the two versions above and the optional public `SITE_URL`.

## Integration: NEAR Intents 1Click Swap API

Cross-chain settlement uses the documented [1Click Swap API](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api) from NEAR Intents. The client in `packages/intents-adapter/src/oneclick.ts` is written against the official OpenAPI document, `info.version` **0.1.10**, and was re-checked field by field against [docs.near-intents.org](https://docs.near-intents.org/) on 2026-11-02 (the list is in [docs/SPEC-NOTES.md](docs/SPEC-NOTES.md#5-1click-swap-api-the-documented-integration)).

| Call | Used for |
| --- | --- |
| `GET /v0/tokens` | supported assets and indicative prices |
| `POST /v0/quote` | `dry: true` for indicative prices and route minimums; `dry: false` (`EXACT_OUTPUT`, `ORIGIN_CHAIN` deposit, recipient = the seller's NEAR account, `refundTo` = the payer on the origin chain) for a real deposit address |
| `GET /v0/status` | deposit detection, delivery proof, refunds |
| `POST /v0/deposit/submit` | optional faster deposit detection |

- Every quote's ed25519 `signature` is verified before Penstock uses its deposit address or amounts, the same check as `verifyQuoteSignature()` in the official TypeScript SDK (`@defuse-protocol/one-click-sdk-typescript` 0.1.26, which Penstock mirrors with `node:crypto` instead of depending on).
- The optional partner JWT goes in `X-API-Key`, the header the OpenAPI document recommends.
- NEAR Intents has no testnet. Live testing uses separate dev accounts, tiny amounts and `dry: true` quotes wherever possible ([docs/LIVE-RUNBOOK.md](docs/LIVE-RUNBOOK.md)).

**The x402 side.** How a cross-chain payment is expressed in x402 terms (`scheme: "exact"` with `extra.assetTransferMethod: "near-intents"`, a quoted second 402, an operation token) follows an **unofficial community draft** of an x402 near-intents transfer method, where it helps interoperability. It is not an official x402 scheme, Penstock makes no conformance claim, and everything draft-specific stays inside `packages/intents-adapter`. The standard `exact` scheme on NEAR (`@x402/near`) is the official x402 path for USDC already on NEAR.

## How a payment works

```
 agent (any chain)            Penstock proxy                         1Click / NEAR            seller API
 ─────────────────            ──────────────                         ─────────────            ──────────
 GET /p/tidewater/tides  ──▶  402 PAYMENT-REQUIRED
                              accepts: exact USDC on NEAR
                                     + near-intents, one per origin
 a) USDC on NEAR:
    PAYMENT-SIGNATURE (signed NEP-366 delegate, one ft_transfer to the seller)
                         ──▶  verify + settle (@x402/near) ──────────▶ relayer submits ft_transfer
                              mark executed once ───────────────────────────────────────────────▶ forward
                         ◀──  200 + PAYMENT-RESPONSE + PENSTOCK-RECEIPT (ed25519)
 b) any other chain and token:
    PAYMENT-SIGNATURE {type:"quote", refundTo}
                         ──▶  1Click POST /v0/quote (EXACT_OUTPUT, recipient = seller) ──▶
                         ◀──  402 with quoted entry: payTo = single-use deposit address,
                              amount, refundDeadline, operationToken (HMAC, stateless)
    deposit on the origin chain ──────────────────────────────────────▶ deposit address
    PAYMENT-SIGNATURE {type:"deposit", operationToken, depositAddress, txHash}
                         ──▶  verify token, check quote terms, claim once,
                              poll GET /v0/status until SUCCESS ◀──── USDC delivered to the seller
                              mark executed once ───────────────────────────────────────────────▶ forward
                         ◀──  200 + PAYMENT-RESPONSE + receipt
                              on REFUNDED/FAILED: 1Click returns funds to refundTo; refund is booked
 c) price below the route's bridge minimum:
    fund a prepaid session once (a or b), then send PENSTOCK-SESSION on each call (metered)
```

Single payments are non-custodial. USDC goes from 1Click, or from the buyer's own `ft_transfer`, straight to the seller's NEAR account. Penstock never holds funds.

## Architecture

```
apps/proxy              Node HTTP server: paywall (HTTP + MCP), sessions, discovery, public routes API,
                        admin API for the console, simulated-deposit endpoint (demo/dry only)
apps/console            React + Vite: landing page at / and seller console at /app (ledger, payments, receipts,
                        funnel, sessions, endpoints); design tokens in src/tokens.css, illustrations drawn in code
packages/core           types, chain registry, money math, config/modes, SQLite ledger (node:sqlite),
                        ed25519 receipts, redacting logger, deterministic seed data
packages/intents-adapter  the ONLY module that knows the 1Click API and the near-intents wire shape: 1Click
                        client (official API 0.1.10, quote signatures verified), simulated and dry backends,
                        operation tokens, the near-intents payment method (unofficial draft shape), route
                        planner, buyer payload helpers
packages/buyer-mcp      buyer library (discovery search, route ranking, automatic 402 handling,
                        automatic sessions) and its stdio MCP server
packages/selftest       `pnpm selftest <url>`
packages/shielded       shielded-payer routes: Confidential Intents and Aurora private chain
examples/upstream-apis  sample upstream APIs the demo sellers protect (tides, geocode, weather,
                        translate, MCP summarize tool); deterministic sample data
docs/SPEC-NOTES.md      every external wire shape Penstock relies on, with sources and live observations
```

Discovery is at `GET /.well-known/penstock.json`. It lists sellers, endpoints, capabilities, prices, accepted origin chains and assets, session URLs, and the spec versions in use.

## Prepaid sessions and their trust model

1Click has per-route bridge minimums, observed live from $0.005 on Arbitrum to $0.15 on Base and $6.45 on Bitcoin. Most chains therefore cannot pay a $0.004 call on its own. Sessions solve this:

- One x402 payment (any rail) funds a session. `POST /s/<seller>/<slug>/open/<amount>` answers 402 for that amount. The hard cap is $5 by default (`SESSION_CAP_USD`).
- Calls carry `PENSTOCK-SESSION: <token>` and are metered atomically. A session can never be overspent, even under concurrent calls.
- Spend is settled in batches of 25 calls, by a sweeper every 30 seconds, and on close.
- Unused balance is refunded on `POST /s/<seller>/<slug>/close` or after 24 hours.

**Trust model, plainly:** the funding payment goes to the seller's account, so **the seller holds session funds, up to the cap, until close**. The buyer gets a **signed session receipt** (ed25519) at open, on `GET /s/…/status` and at close. The receipt shows funded, spent, settled, refund and refund state. In demo and dry mode, refunds are simulated. In live mode Penstock holds no keys, so refunds are listed in the console as "owed" for the seller to send. An escrow contract would remove the trust in the seller; it is not built.

## Agent-to-agent resale

A Penstock seller can resell other Penstock sellers' endpoints with a margin. An endpoint with `resaleOf` URLs works like this:

1. It takes the buyer's payment.
2. It pays each upstream Penstock endpoint as an ordinary agent would, in USDC on NEAR from the seller's own account.
3. It passes their results to its own composer upstream.

What it paid is booked as `upstreamCost`, so the console shows the margin per call, and the receipt drawer lists the signed upstream receipts. In the demo, `harbor-brief` buys `northwind.marine-weather` and `quillfeed.translate`.

Safeguards: chains are limited to 3 hops, an endpoint cannot resell itself, and upstream URLs pass the same checks as any upstream.

## Shielded-payer mode

There are two routes behind one interface (`packages/shielded`). Neither is required.

- **Confidential Intents.** Near-intents quotes ask 1Click for `confidentiality: "basic"`, so the payer's deposit and the delivery cannot be linked. Real 1Click requires authentication for these quotes (HTTP 401 without `ONECLICK_JWT`, seen live), so the route is enabled only with `SHIELDED_CONFIDENTIAL_INTENTS=true` plus a JWT. In demo mode it runs against the simulated backend. If 1Click still refuses, the route turns itself off and payments continue with public quotes instead of failing.
- **Aurora private chain.** With `SHIELDED_AURORA_RPC_URL` set, Penstock connects to an Aurora Cloud private chain and verifies it. It reports **not enabled for payments**, because 1Click lists no assets on such a chain. Penstock does not pretend otherwise.

**Privacy scope, plainly:**

- Shielded mode hides the payer's origin wallet and route.
- It does **not** hide the settlement: the USDC delivery to the seller's NEAR account is a public transfer.
- The seller's revenue is **not** hidden.

## Security

The audit and its results are in [docs/AUDIT.md](docs/AUDIT.md). Main measures:

- **Upstreams come from seller config only.** The proxy is not open. Paths are checked for traversal, and redirects are not followed. Private, metadata and loopback addresses are refused at connect time in live mode, which defeats DNS rebinding.
- **Server terms come from the server's own offers.** A tampered price, payee or asset in `accepted` is refused.
- **Replays are refused.** Each operation is claimed and executed exactly once through database constraints, keyed by the signed-delegate hash or the deposit instrument.
- **Operation tokens are bound to everything that matters.** They are HMAC-bound to the deposit address, resource, destination terms and expiry, and checked in constant time.
- **Abuse is limited.** Rate limits apply per buyer and per action. The admin API needs a token. Logs redact secrets, and buyers are recorded only as keyed hashes, never IP addresses.

## Honest limits

- **The Aurora route cannot pay yet.** It verifies the private chain, but 1Click has no route from it. Confidential Intents needs your own 1Click JWT outside demo mode.
- **Resale is upfront.** If an upstream seller fails after the buyer has paid, the buyer gets a 502 with the receipt; there is no automatic refund.
- **Penstock does not observe origin chains itself.** For near-intents, deposit detection and delivery proof come from 1Click `GET /v0/status`; the unofficial draft asks the facilitator to observe the origin chain.
- **Quote signatures depend on one published key.** Penstock verifies every 1Click quote with the manager key published in the official SDK. If 1Click rotates that key, quotes fail closed (no payment proceeds) until the key is updated.
- **The 402 header is about 10 KB,** because it lists 19 origin entries. That is fine for Node and most clients, but reverse proxies with 4–8 KB header buffers need a larger limit. The same object is also in the response body.
- **The facilitator and the ledger are single-node.** Claims are exactly-once within one SQLite ledger, so a multi-instance deployment needs a shared database.
- **Live deposits on origin chains need the agent's own wallet.** The MCP server returns deposit instructions and `penstock_resume` finishes the payment. No origin-chain wallets are bundled.
- **Live mode has not been run end to end.** It was not run against mainnet with funds during development. Dry mode was run against the real 1Click API.

## Credits and sources

- **NEAR Intents 1Click Swap API** ([docs](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api)): the documented integration for quotes, deposit addresses, status and refunds, API 0.1.10.
- **The near-intents x402 wire shape** follows an unofficial community draft of an x402 near-intents transfer method by Iker ([IkerAlus](https://github.com/IkerAlus)), discussed in the [x402 repository](https://github.com/x402-foundation/x402). It is not an official x402 scheme; Penstock follows it where it helps and makes no conformance claim. The idea is theirs.
- **x402** is by the [x402 Foundation](https://github.com/x402-foundation/x402). Penstock uses `@x402/core` and `@x402/near` 2.29.0 (Apache-2.0).
- **[fastnear/x402-facilitator](https://github.com/fastnear/x402-facilitator)** is the reference NEAR facilitator used for live `exact` settlement.
- **Libraries:** React, Vite, `@near-js/*`, Newsreader, Geist and JetBrains Mono fonts via `@fontsource`, `@resvg/resvg-js` and `opentype.js` (build-time social card), Vitest, ESLint, TypeScript and tsx. All were written by others and used under their licenses. There is no pre-hackathon code: the repository was started on 2026-11-01.

Parts of this codebase were written with AI assistance.

## License

MIT. See [LICENSE](LICENSE).
