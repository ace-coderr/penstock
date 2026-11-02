# Live runbook

How Penstock is run on NEAR mainnet with real funds, for the one-off proof in [PROOF.md](PROOF.md). Every fact below was checked on 2026-11-02 against the official NEAR Intents docs ([docs.near-intents.org](https://docs.near-intents.org/)), mainnet RPC reads, or live `dry: true` 1Click quotes. Where the docs are silent, this file says so instead of guessing.

## Ground rules

- **No testnet.** NEAR Intents has no testnet ("Swap SDK" page; hackathon Q-007). Testing happens on mainnet.
- **Separate dev accounts.** The seller is the dev account `acedevv.near`. The payer is a separate Solana wallet used only for this. Neither is anyone's main wallet.
- **Tiny amounts.** Every real send is capped by `LIVE_MAX_USD` (default 1). The cap is enforced in code, not only here.
- **`dry: true` first.** Every route and amount is checked with a dry quote (no deposit address, nothing can be sent) before any real quote.
- **A human says yes before every send.** The exact quote (amount in, amount out, recipient, route, fees) is shown first. Nothing is signed without an explicit "yes" in chat.
- **Keys stay in `.env`.** `.env` is gitignored. Keys are never printed or logged (the logger redacts key, JWT and secret fields; there is a test for it).

## Variables (`.env`)

| Variable | Needed for | Format |
| --- | --- | --- |
| `MODE` | `dry` until the live run, then `live` | |
| `SELLER_NEAR_ACCOUNT` | payout account | `acedevv.near` |
| `OPERATION_TOKEN_SECRET`, `ADMIN_TOKEN` | required in live mode | random, generated locally |
| `ONECLICK_JWT` | optional | partner JWT from [partners.near-intents.org](https://partners.near-intents.org). Without it 1Click adds 0.25% to each quote ("Fees" page); confidential quotes need it. Sent as `X-API-Key`. |
| `PAYER_SOLANA_ADDRESS` | refund address, balance checks | base58 Ed25519 public key ("Supported Chains" page) |
| `PAYER_SOLANA_PRIVATE_KEY` | signing the deposit transfer | base58 64-byte secret key, the export format of Phantom and Solflare (a wallet convention, not from the NEAR docs) |
| `SOLANA_RPC_URL` | Solana reads and sends | default `https://api.mainnet-beta.solana.com` |
| `SELLER_NEAR_PRIVATE_KEY` | the one storage registration | `ed25519:...` full-access key of `acedevv.near` |
| `NEAR_RPC_URL` | NEAR reads and sends | default `https://rpc.mainnet.fastnear.com` |
| `LIVE_MAX_USD` | spend cap per send | default `1` |

## 1. Seller account

Read on 2026-11-02 (`view_account`, finality `final`): `acedevv.near` **exists**, holds **0 NEAR**, and uses 182 bytes of storage. It is a zero-balance account (NEAR allows small accounts with no balance), so it cannot pay gas for any transaction yet.

Penstock checks the payout account before every quote (`view_account`), because 1Click answers a quote to a non-existent NEAR account with HTTP 400 "Internal server error" (seen live, SPEC-NOTES section 5).

## 2. USDC storage registration

- USDC on NEAR is the NEP-141 contract `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`.
- `storage_balance_bounds` returns `min = max = 1250000000000000000000` yoctoNEAR (**0.00125 NEAR**).
- `storage_balance_of({ account_id: "acedevv.near" })` returns `null`: **not registered**.
- Registration is `storage_deposit({ account_id: "acedevv.near", registration_only: true })` with 0.00125 NEAR attached, plus gas. NEP-145 lets any account pay it for any `account_id`, but the signer needs native NEAR.
- Why register: the standard x402 `exact` scheme on NEAR (`@x402/near`) refuses to settle to a `payTo` without storage (`storage_balance_of(payTo)` must not be null; SPEC-NOTES section 3). Whether 1Click registers storage for an unregistered recipient when it delivers is **not documented**; registering first removes the question.
- `pnpm live:check` reads all of this and, with `--register` and a human "yes", sends the registration signed by `SELLER_NEAR_PRIVATE_KEY`.

## 3. Funding the seller (one tiny swap)

`acedevv.near` needs native NEAR for gas and the 0.00125 NEAR deposit. Plan: one 1Click swap from the payer, USDC on Solana → wNEAR (`nep141:wrap.near`, the only NEAR-native asset in the 1Click token list), recipient `acedevv.near`, refund to the payer on Solana.

Dry quote, 2026-11-02 (`EXACT_INPUT`, 0.30 USDC): out **0.07650 wNEAR** (about $0.298), `timeEstimate` 22 s, keyless `appFees` 20 bps added by 1Click, `refundFee` 244919 (0.245 USDC), signature verified.

**Open question, not answered by the docs:** whether a swap to `nep141:wrap.near` with a NEAR recipient arrives as **native NEAR** or as **wNEAR tokens**. The docs say wrapping is handled for you on the deposit side ("Using NEAR Tokens"); the withdrawal side lists both `ft_withdraw` (token) and `NativeWithdraw` (native NEAR) without saying which 1Click uses. After the swap, `live:check` reads both `view_account.amount` and `wrap.near` `ft_balance_of`. If it arrived as wNEAR, the account still has no gas: the fallback is to send about 0.01 NEAR to `acedevv.near` from any wallet or exchange, then unwrap and register.

## 4. Payer wallet (Solana)

- Holds USDC (mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, the asset 1Click lists as `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near`) and a little SOL for fees.
- The deposit is an SPL USDC transfer to the 1Click `depositAddress`. If the deposit address has no USDC token account yet, the sender creates it (associated token account rent, about 0.002 SOL; Solana convention, checked at send time).

## 5. The live 1Click flow

From "Making a Request" and the API reference (OpenAPI `info.version` 0.1.10):

1. `POST /v0/quote` with `dry: false`, `swapType: EXACT_OUTPUT`, `depositType: ORIGIN_CHAIN`, `amount` = the price in NEAR USDC base units, `recipient` = `acedevv.near`, `recipientType: DESTINATION_CHAIN`, `refundTo` = `PAYER_SOLANA_ADDRESS`, `refundType: ORIGIN_CHAIN`, `deadline` = the refund deadline.
2. Verify the quote's ed25519 signature (Penstock refuses a quote that fails).
3. Send exactly `amountIn` of the origin asset to `depositAddress`.
4. Optionally `POST /v0/deposit/submit` with `{ txHash, depositAddress }` (faster detection).
5. Poll `GET /v0/status?depositAddress=...` until `SUCCESS`, `REFUNDED` or `FAILED`. `KNOWN_DEPOSIT_TX`, `PENDING_DEPOSIT`, `PROCESSING` and `INCOMPLETE_DEPOSIT` are not final. The docs say to allow up to 15 minutes.
6. `swapDetails.originChainTxHashes` and `destinationChainTxHashes` give the explorer links for PROOF.md; Penstock then signs its receipt.

**Route minimum (changed).** On 2026-11-01 the Solana route's minimum for delivering USDC to NEAR was 94115 base units ($0.094). On 2026-11-02 dry quotes answer "Amount is too low for bridge, try at least 240015" for `EXACT_OUTPUT` (244919 for `EXACT_INPUT`): about **$0.24**. Minimums move with origin-chain fees, which is why Penstock reads them from 1Click's errors instead of a constant. The live payment must be at least this, and stays under `LIVE_MAX_USD`.

## 6. Refund path

- 1Click refunds to `refundTo` on the origin chain; no facilitator holds funds ("Making a Request", status `REFUNDED`).
- `EXACT_OUTPUT`: a deposit below `minAmountIn` is refunded by the deadline; a deposit above `amountIn` is processed and the excess refunded (OpenAPI `swapType` description). `INCOMPLETE_DEPOSIT` means below the required amount.
- `quote.refundFee` is "fee charged for refunding assets to the refund address", in origin base units. On Solana it is currently 244919 (0.245 USDC), so a small refund returns little: an under-deposit of 0.30 USDC would come back as about 0.055 USDC.
- A quote that expires unpaid sends nothing on chain: it costs nothing, but it also leaves no transaction to show.

## 7. The `exact` path (USDC already on NEAR)

The standard x402 `exact` scheme on NEAR uses NEP-366 signed delegate actions: the payer signs, and a relayer submits and pays gas. That needs an x402 facilitator. The reference one is [fastnear/x402-facilitator](https://github.com/fastnear/x402-facilitator) (`https://x402.mikedotexe.com` for `near:mainnet`); its `/verify` and `/settle` need an API key approved by hand (`FACILITATOR_URL`, `FACILITATOR_API_KEY`). The cross-chain proof in this runbook uses 1Click and needs **no** relayer or facilitator.

## 8. Order of operations

1. `pnpm live:check`: reads `.env`, checks the seller account, storage, payer balances, and gets a real dry quote. Moves nothing.
2. Funding swap (section 3): quote shown, human "yes", send, record.
3. `pnpm live:check --register`: shown, human "yes", register storage, record.
4. One live payment through the proxy (section 5): quote shown, human "yes", send, record.
5. A refund case only if it can be done safely within the cap (section 6).
6. Every transaction goes into [PROOF.md](PROOF.md) with explorer links.
