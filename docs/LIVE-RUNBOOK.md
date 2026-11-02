# Live runbook

How Penstock is run on NEAR mainnet with real funds, for the one-off proof in [PROOF.md](PROOF.md). Every fact below was checked on 2026-11-02 against the official NEAR Intents docs ([docs.near-intents.org](https://docs.near-intents.org/)), mainnet RPC reads, or live `dry: true` 1Click quotes. Where the docs are silent, this file says so instead of guessing.

## Ground rules

- **No testnet.** NEAR Intents has no testnet ("Swap SDK" page; hackathon Q-007). Testing happens on mainnet.
- **Separate dev accounts.** The seller is the dev account `acedevv.near`. The payer is a separate Solana wallet used only for this. Neither is anyone's main wallet.
- **Tiny amounts.** Every real send is capped by `LIVE_MAX_USD` (default 1). The cap is enforced in code, not only here.
- **`dry: true` first.** Every route and amount is checked with a dry quote (no deposit address, nothing can be sent) before any real quote.
- **A human says yes before every send.** The exact quote (amount in, amount out, recipient, route, fees) is shown first. Nothing is signed without an explicit "yes" in chat.
- **Only the payer key.** No seller key is used anywhere in the live run (section 2).
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
| `NEAR_RPC_URL` | NEAR reads and sends | default `https://rpc.mainnet.fastnear.com` |
| `LIVE_MAX_USD` | spend cap per send | default `1` |

## 1. Seller account

Read on 2026-11-02 (`view_account`, finality `final`): `acedevv.near` **exists**, holds **0 NEAR**, and uses 182 bytes of storage. It is a zero-balance account (NEAR allows small accounts with no balance), so it cannot pay gas for any transaction yet.

Penstock checks the payout account before every quote (`view_account`), because 1Click answers a quote to a non-existent NEAR account with HTTP 400 "Internal server error" (seen live, SPEC-NOTES section 5).

## 2. USDC storage registration: no seller key needed

- USDC on NEAR is the NEP-141 contract `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`. `storage_balance_bounds` returns `min = max = 1250000000000000000000` yoctoNEAR (**0.00125 NEAR**). On 2026-11-02 `storage_balance_of("acedevv.near")` is `null`: not registered.
- **1Click registers it on delivery.** Dry quotes for the same delivery (0.30 USDC on Solana → 0.30 USDC on NEAR) differ only by the recipient's registration: to the unregistered `acedevv.near`, `withdrawFee` is **4890** (0.00489 USDC, about 0.00125 NEAR at the day's price) and `amountIn` is higher by exactly that; to the registered accounts `near` and `relay.tg`, `withdrawFee` is **0**. The OpenAPI document defines `withdrawFee` as the fee "for withdrawing assets to the recipient", and the intents contract's `FtWithdraw` has an optional `storage_deposit` that registers `receiver_id` on the token, paid in wNEAR. The docs do not state this behaviour in words. **Confirmed live on 2026-11-02:** the first delivery to `acedevv.near` ([Ggb5B734…](https://nearblocks.io/txns/Ggb5B734pfQVDefs12eJ3xsE6sLbeRjcN3j56a7Ac3MA)) ran `storage_deposit` (0.00125 NEAR) on the USDC contract before the `ft_transfer`, and `storage_balance_of` turned non-null.
- **What it costs:** about 0.005 USDC, once, included in the payer's first payment. No seller transaction, no seller NEAR, no seller key.
- **If it did not register:** the USDC withdrawal would fail and 1Click's refund path applies (section 6). The fallback is section 3.
- Why registration matters: the standard x402 `exact` scheme on NEAR (`@x402/near`) refuses to settle to a `payTo` without storage (SPEC-NOTES section 3). After the first 1Click delivery, that holds too.

**Options that were checked and rejected:**
- *A function-call access key limited to `storage_deposit`:* not possible. NEAR function-call keys "do not allow to attach NEAR tokens to the call" (docs.near.org, Access Keys), and `storage_deposit` needs 0.00125 NEAR attached. Adding such a key would also need a full-access key signature.
- *A full-access seller key in `.env`:* avoidable, so not used.

## 3. Fallback: register from your own wallet (one action)

NEP-145 `storage_deposit` takes an `account_id`, so **any** NEAR account can pay to register `acedevv.near`; the seller does not sign. From any NEAR wallet that can call a contract method:

- contract: `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`
- method: `storage_deposit`, arguments `{"account_id": "acedevv.near", "registration_only": true}`
- attach exactly **0.00125 NEAR**, gas 30 TGas (the unused part of gas is refunded)

Cost: 0.00125 NEAR plus a small gas fee, about $0.005 in total at the day's price. Nothing in Penstock signs this; it is your wallet action.

The funding swap considered earlier (USDC on Solana → NEAR for the seller) is **not needed**: the seller never pays gas in either path. A dry quote showed 0.30 USDC would buy about 0.0765 NEAR, but whether such a swap arrives as native NEAR or as wNEAR is not documented.

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

**Route minimum (changed).** On 2026-11-01 the Solana route's minimum for delivering USDC to NEAR was 94115 base units ($0.094). On 2026-11-02, keyless dry quotes answer "Amount is too low for bridge, try at least 240015" for `EXACT_OUTPUT` (244919 for `EXACT_INPUT`): about $0.24. With a partner JWT (`ONECLICK_JWT`), the same day's dry quote accepted a 0.01 USDC delivery: 0.01501 USDC in, refund fee 0.00998 USDC, including the 0.0049 USDC storage registration. Minimums move with origin-chain fees and authentication, which is why Penstock reads them from 1Click's errors instead of a constant. The live payment stays under `LIVE_MAX_USD`.

## 6. Refund path

- 1Click refunds to `refundTo` on the origin chain; no facilitator holds funds ("Making a Request", status `REFUNDED`).
- `EXACT_OUTPUT`: a deposit below `minAmountIn` is refunded by the deadline; a deposit above `amountIn` is processed and the excess refunded (OpenAPI `swapType` description). `INCOMPLETE_DEPOSIT` means below the required amount.
- `quote.refundFee` is "fee charged for refunding assets to the refund address", in origin base units. On Solana on 2026-11-02 it was 244919 (0.245 USDC) on keyless quotes and 9980 (0.00998 USDC) with a partner JWT.
- A quote that expires unpaid sends nothing on chain: it costs nothing, but it also leaves no transaction to show.

## 7. The `exact` path (USDC already on NEAR)

The standard x402 `exact` scheme on NEAR uses NEP-366 signed delegate actions: the payer signs, and a relayer submits and pays gas. That needs an x402 facilitator. The reference one is [fastnear/x402-facilitator](https://github.com/fastnear/x402-facilitator) (`https://x402.mikedotexe.com` for `near:mainnet`); its `/verify` and `/settle` need an API key approved by hand (`FACILITATOR_URL`, `FACILITATOR_API_KEY`). The cross-chain proof in this runbook uses 1Click and needs **no** relayer or facilitator.

## 8. Order of operations

1. `pnpm live:check`: reads `.env`, checks the seller account and storage, the payer key and balances, and gets a real signed dry quote (including any storage `withdrawFee`). Moves nothing. Needs no seller key.
2. One live payment through the proxy (section 5): the quote is shown, a human says "yes", then it is sent and recorded. If the seller had no storage, this delivery registers it (section 2).
3. A refund case only if it can be done safely within the cap (section 6).
4. Every transaction goes into [PROOF.md](PROOF.md) with explorer links.
