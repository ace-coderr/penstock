# Spec notes

What Penstock relies on, checked against the primary sources on 2026-11-01. Every wire shape used in the code comes from this file. If a source changes, update this file first, then the code.

## 1. Hackathon rules (nearhackathon.com/HACKATHON.md)

- Window: 2026-11-01T00:00:00Z to 2026-11-14T23:59:00Z. The repository must be public by the deadline.
- Track ids that fit Penstock: `realworld` (Real-World Money) and `privacy` (Privacy & Private AI). `agents` (Agent Economy) also fits.
- Q-005: libraries and AI-assisted code are allowed, but they must be listed in the README.
- Q-006: a 1Click JWT is optional. Without one, 1Click charges a 0.2% fee. Partner registration is at partners.near-intents.org.
- Q-007: NEAR Intents has no testnet. Use mainnet, separate dev accounts, tiny amounts and `dry: true` quotes.
- Q-012: a local-only demo is fine if the README reproduces it and the X post has a video.
- Q-014: any license works. Add a LICENSE file. MIT is the choice here.
- Q-017: automated agents screen first (reproducibility, feature check), and humans decide. So the README must use "do X, see Y" steps.
- Never without the human's confirmation: submitting, posting, pushing, making the repo public, signing transactions, or committing secrets.

## 2. x402 v2 core and HTTP transport

Sources: `x402-foundation/x402` `specs/transports-v2/http.md`, `specs/transports-v2/mcp.md`, and the types of the npm package `@x402/core@2.29.0`.

Headers. Each one is base64 of UTF-8 JSON.

| Header | Direction | Body |
| --- | --- | --- |
| `PAYMENT-REQUIRED` | server → client, on HTTP 402 | `PaymentRequired` |
| `PAYMENT-SIGNATURE` | client → server | `PaymentPayload` |
| `PAYMENT-RESPONSE` | server → client | `SettleResponse` |

The v1 names `X-PAYMENT` and `X-PAYMENT-RESPONSE` still exist in `@x402/core`. Penstock does not accept them.

Types, verbatim from `@x402/core/types`:

```ts
type Network = `${string}:${string}`;           // CAIP-2
type PaymentRequirements = { scheme: string; network: Network; asset: string; amount: string;
  payTo: string; maxTimeoutSeconds: number; extra: Record<string, unknown> };
type PaymentRequired = { x402Version: number; error?: string; resource: ResourceInfo;
  accepts: PaymentRequirements[]; extensions?: Record<string, unknown> };
type PaymentPayload = { x402Version: number; resource?: ResourceInfo; accepted: PaymentRequirements;
  payload: Record<string, unknown>; extensions?: Record<string, unknown> };
type VerifyResponse = { isValid: boolean; invalidReason?: string; invalidMessage?: string; payer?: string;
  extensions?: Record<string, unknown>; extra?: Record<string, unknown> };
type SettleResponse = { success: boolean; errorReason?: string; errorMessage?: string; payer?: string;
  transaction: string; network: Network; amount?: string; extensions?: Record<string, unknown>;
  extra?: Record<string, unknown> };
interface ResourceInfo { url: string; description?: string; mimeType?: string; serviceName?: string;
  tags?: string[]; iconUrl?: string }
```

Header encoding in `@x402/core/http`: `encodePaymentRequiredHeader` is `base64(JSON.stringify(x))`. Decoding checks the value against a base64 regex before it calls `JSON.parse`. `encodePaymentResponseHeader` removes `extensionResponses` before encoding.

Browsers: none of the three headers is CORS-safelisted. A browser-facing server must list `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` in `Access-Control-Expose-Headers` and `PAYMENT-SIGNATURE` in `Access-Control-Allow-Headers`.

MCP transport (`transports-v2/mcp.md`):
- Payment required: a tool result with `isError: true`, where `structuredContent` is the `PaymentRequired` object and `content[0].text` is `JSON.stringify` of the same object.
- Client payment: `params._meta["x402/payment"]` holds the `PaymentPayload`.
- Settlement result: `result._meta["x402/payment-response"]` holds the `SettleResponse`.
- If settlement fails after the tool ran, return only the payment error, not the tool output.

## 3. Standard NEAR `exact` scheme (`@x402/near`)

Sources: `specs/schemes/exact/scheme_exact_near.md`, and the npm package `@x402/near@2.29.0` (latest on 2026-11-01, Apache-2.0, x402 Foundation).

- Networks: `near:mainnet` and `near:testnet`.
- `asset` is the NEP-141 contract account id. `payTo` is the recipient account id. `amount` is in base units. The scheme needs no `extra` fields.
- Payload: `{ "signedDelegateAction": "<base64 Borsh NEP-366 SignedDelegate>" }`. It carries exactly one `ft_transfer` to `payTo` for exactly `amount`, with 1 yoctoNEAR attached. The payer needs no NEAR for gas, because a facilitator relayer sponsors the transaction.
- Replay protection: the on-chain access-key nonce plus `max_block_height`, where `timeoutBlocks = max(1, ceil(maxTimeoutSeconds / 1))`. A full-access key is required.
- Preflight: account exists, token code is deployed, `ft_balance_of` is checked, and `storage_balance_of(payTo)` is not null. Every check fails closed.
- Settlement succeeds only when the inner `ft_transfer` receipt succeeds. Duplicate key: hex SHA-256 of the decoded `signedDelegateAction` bytes (`settlementCacheKey`).
- Package entry points: `@x402/near` (signers, helpers, `DEFAULT_ASSETS`, `decodeSignedDelegateB64`, `settlementCacheKey`), `@x402/near/exact/client`, `@x402/near/exact/server` and `@x402/near/exact/facilitator`. Each exports `ExactNearScheme`.
- Register with `x402ResourceServer` / `x402Facilitator` / `x402Client` from `@x402/core/server|facilitator|client`.
- Default USDC contracts (`DEFAULT_ASSETS`, 6 decimals):
  - `near:mainnet`: `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`
  - `near:testnet`: `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`
- Default RPC: FastNEAR keyless public endpoints. Override them with `rpcUrls`.

## 4. fastnear/x402-facilitator (reference facilitator)

Source: the repository README and `examples/resource-server` on 2026-11-01.

- A Rust facilitator for `exact` USDC on `near:mainnet`, `near:testnet` and Base, using NEP-366 delegate actions with one `ft_transfer`. It is v2 only on NEAR.
- Reference instances: `https://x402.mikedotexe.com` (`near:mainnet`) and `https://test.x402.mikedotexe.com` (`near:testnet`). Neither has an SLA.
- HTTP endpoints: `GET /supported`, `/healthz`, `/readyz`, `/openapi.yaml`, `/llms.txt`, `/discovery/resources`, plus `POST /verify` and `POST /settle`. The two POSTs need an API key, sent as `X-API-Key` or `Authorization: Bearer`.
- A payment rejection is HTTP 200 with an x402 body. Auth, policy and malformed input errors are HTTP errors.
- API keys are approved by hand, per resource server and per payee. Penstock live mode therefore takes `FACILITATOR_URL` and `FACILITATOR_API_KEY` from the environment. Penstock never ships a key.
- The example resource server pins `@x402/* 2.28.0`. It keeps a separate delivery-idempotency journal, because facilitator idempotency alone does not prevent duplicate application delivery. Penstock does the same.

## 5. near-intents method for `exact` (draft, x402-foundation/x402 PR #3370)

Source: PR #3370 "specs(exact): add near-intents `upfront` method" by Iker (GitHub `IkerAlus`). Open, last updated 2026-10-02. File `specs/schemes/exact/scheme_exact_nearintents.md`, read at head commit `2e9dded9aaeb9c58ae93be42705a2bcf5cc19f87`. Penstock pins to this commit and calls it **spec version `nearintents-draft-2e9dded`**. The spec belongs to its authors. Penstock implements it and does not claim it.

Key points:

- This is not a new scheme. It is `scheme: "exact"` with `extra.assetTransferMethod: "near-intents"` and `extra.paymentFlow: "upfront"`.
- `network` is the **origin** network (CAIP-2), with one `accepts[]` entry per offered origin. `asset` is the origin asset.
- Unquoted entry (first 402): `amount: ""` and `payTo: ""`, plus `extra.indicativeAmount`, which is not binding and comes from a cached `dry: true` quote. It also carries `extra.destination = { network, asset, amount, recipient }`.
- Quote payload (client → server): `payload = { type: "quote", refundTo, slippageTolerance? }`, where `accepted` is the unquoted entry. A quote payload never unlocks the resource.
- The facilitator `/verify` mints a quote with one `POST /v0/quote` call: `dry: false`, `swapType: EXACT_OUTPUT`, `depositType: ORIGIN_CHAIN`, `depositMode: MEMO|SIMPLE`, `amount = destination.amount`, `recipient = destination.recipient`, `recipientType: DESTINATION_CHAIN`, `refundTo = payload.refundTo`, `refundType: ORIGIN_CHAIN`, `deadline = now + maxTimeoutSeconds` (this is the refund deadline). Destination terms come from the server's own requirements, never from the payload.
- `VerifyResponse.extra = { depositAddress, amountIn, refundDeadline, operationToken, depositMemo? }`.
- Quoted entry (second 402): `amount = amountIn`, `payTo = depositAddress`, `extra.refundDeadline`, `extra.operationToken`, and `extra.depositMemo` when there is one.
- Deposit payload: `payload = { type: "deposit", operationToken, depositAddress, depositMemo?, txHash }`, where `accepted` is the unquoted entry.
- `operationToken = <keyId>.<expiry>.<mac>`:
  - `expiry` = refundDeadline + at least 24 hours, in Unix seconds.
  - `mac` = unpadded base64url of `HMAC-SHA256(key, network:depositAddress[:depositMemo]:resource:destinationHash:expiry)`.
  - `destinationHash` = lowercase hex SHA-256 of `network:asset:amount:recipient` from `paymentRequirements.extra.destination`.
  - The token needs no storage. It is a bearer credential and must never appear on chain or in receipts.
- `/settle` steps: structural checks → token check (expired, then MAC) → return the recorded result if one exists → `GET /v0/status` and compare `quoteResponse.quoteRequest` recipient, asset and amount against the destination → claim exactly once (the claim expires) → check the deposit tx → optional `POST /v0/deposit/submit` → poll status.
  - Valid only when `status == SUCCESS` and `txHash` is in `swapDetails.originChainTxHashes[].hash`.
  - `REFUNDED` and `FAILED` are terminal failures.
  - `KNOWN_DEPOSIT_TX`, `PENDING_DEPOSIT`, `PROCESSING` and `INCOMPLETE_DEPOSIT` are not terminal. In that case return `success:false, errorReason:"settlement_pending"`, release the claim, and the client retries with the same token.
- Success response: `network`/`transaction` are the destination delivery. `extra = { originNetwork, originTxHash }`, and `amount = destination.amount`.
- Error codes: `invalid_exact_near_intents_quote_unavailable`, `_token_invalid`, `_token_expired`, `_quote_mismatch`, `_deposit_not_found`, `exact_near_intents_insufficient_deposit`, `exact_near_intents_payment_failed`, `exact_near_intents_operation_executed`.
- Resource server: records each quoted operation for at least 24 hours after `refundDeadline`. It executes the handler once per operation, marked atomically.
- Refunds: 1Click refunds `refundTo` on the origin chain directly. No facilitator holds client funds.
- Trust: settlement is not trustless. The 1Click backend holds funds between deposit and delivery.

## 6. 1Click API (NEAR Intents)

Sources: `https://1click.chaindefuser.com/docs/v0/openapi.yaml` (`info.version: 0.1.10`), docs.near-intents.org pages "Swap Types", "Confidential Swaps" and "Verify Quote Signatures", and live calls made on 2026-11-01.

- Base URL: `https://1click.chaindefuser.com`. Auth is optional: header `X-API-Key` or `Authorization: Bearer <JWT>`.
- `GET /v0/tokens` → `TokenResponse[]`: `{ assetId, decimals, blockchain, symbol, price, priceUpdatedAt, contractAddress?, coingeckoId? }`. Live on 2026-11-01: 210 tokens on 38 chains.
- `POST /v0/quote`: body `QuoteRequest`.
  - Required: `dry, swapType (EXACT_INPUT|EXACT_OUTPUT|FLEX_INPUT|ANY_INPUT), slippageTolerance (bps), originAsset, depositType (ORIGIN_CHAIN|INTENTS|CONFIDENTIAL_INTENTS), destinationAsset, amount (base-unit integer string), refundTo, refundType, recipient, recipientType (DESTINATION_CHAIN|INTENTS|CONFIDENTIAL_INTENTS), deadline (ISO)`.
  - Optional: `depositMode (SIMPLE|MEMO)`, `confidentiality (public|basic|advanced)`, `appFees[{recipient, fee bps}]`, `referral`, `quoteWaitingTimeMs`, `insured`, `connectedWallets`, `sessionId`.
- `QuoteResponse`: `{ correlationId, timestamp, signature, quoteRequest, quote }`.
  - `quote`: `{ depositAddress?, depositMemo?, amountIn, amountInFormatted, amountInUsd, minAmountIn, amountOut, amountOutFormatted, amountOutUsd, minAmountOut, deadline?, timeWhenInactive?, timeEstimate (s), refundFee?, withdrawFee? }`.
  - With `dry: true` there is no `depositAddress`, `timeWhenInactive` or `deadline`.
- `GET /v0/status?depositAddress=&depositMemo=` → `{ correlationId, quoteResponse, status, updatedAt, swapDetails }`. `status` is one of `KNOWN_DEPOSIT_TX, PENDING_DEPOSIT, INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED`.
  - `swapDetails`: `{ intentHashes[], nearTxHashes[], amountIn?, amountOut?, originChainTxHashes[{hash, explorerUrl}], destinationChainTxHashes[{hash, explorerUrl}], refundedAmount?, refundReason?, depositedAmount?, ... }`.
  - Unknown address → HTTP 404 `{ message, error: "Not Found", statusCode: 404, ... }` (seen live).
- `POST /v0/deposit/submit`: `{ txHash, depositAddress, nearSenderAccount?, memo? }`. Responds with the same shape as status.
- Quote signature: `signature` is `ed25519:<base58>` over base58(SHA-256(stable-stringify({...quoteRequest, ...quote, timestamp}))). `verifyQuoteSignature()` in `@defuse-protocol/one-click-sdk-typescript` ≥ 0.1.24 checks it.
- USDC asset ids (live token list): NEAR `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, Arbitrum `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near`, Base `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`, Ethereum `nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near`, Solana `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near`. Native: `nep141:eth.omft.near`, `nep141:sol.omft.near`, `nep141:btc.omft.near`, `nep141:wrap.near`.

Observed live, 2026-11-01:
- A dry `EXACT_OUTPUT` quote, Arbitrum USDC → 1.000000 NEAR USDC, without a key → HTTP 201: `amountIn 1010224`, `minAmountIn 1000121`, `timeEstimate 25`, `refundFee 5300`. 1Click added `appFees:[{fee:1}]` to the echoed request. The docs say the keyless fee is 0.2%, so Penstock shows fees from `amountInUsd - amountOutUsd`, not from a constant.
- Dry quote, SOL → 1 NEAR USDC → `amountIn 10602517` lamports, `timeEstimate 20`. Here 1Click added `appFees:[{fee:20}]` (0.2%), which matches the documented keyless fee. The fee added varies by route.
- A `recipient` NEAR account that does not exist → HTTP 400 `{"message":"Internal server error"}`. Penstock checks the seller account before it quotes.
- `confidentiality: "basic"` without auth → HTTP 401 "User authentication is required for confidential intent quotes". The confidential route needs a 1Click JWT.

Recorded responses are stored as contract-test fixtures in `packages/intents-adapter/fixtures/`.

## 7. Confidential routes (shielded-payer mode)

- Confidential Intents, foreign-to-foreign: a normal `ORIGIN_CHAIN` → `DESTINATION_CHAIN` quote with `confidentiality: basic|advanced`. The deposit and the withdrawal cannot be linked. This needs an authenticated 1Click call (see above).
- What it hides: the link between the payer's origin deposit and the delivery. What it does not hide: the delivery to the seller on NEAR is still a public transfer, so seller revenue stays visible.
- Aurora: an EVM chain on NEAR (doc.aurora.dev). Penstock treats an Aurora confidentiality route as an optional adapter behind the same interface. It is disabled unless configured, and the UI then shows "not enabled".

## 8. What Penstock adds on top (not in any spec)

These are Penstock's own design choices. None of them change the wire shapes above.

- Prepaid sessions: a normal x402 payment that opens a metered session.
- `/.well-known/penstock.json` discovery.
- A buyer MCP tool.
- Resale margins.
- A probe-to-purchase funnel.
