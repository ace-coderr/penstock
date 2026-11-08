# Retry test: one purchase, one payment

The double-payment path was found by running LLM agents against Penstock with Clearance (https://github.com/Selliksss/clearance), an outside agent-testing project. In that run, settlement was Penstock's own demo simulation. The fix and our scripted before/after are described here.

An outside test of LLM agents against the buyer MCP found that, after the first paid call hit an error, most agents called again, which opened a new quote and a new deposit: the seller received two payments while the agent reported one. This file describes the scripted reproduction and the fix. It runs in demo mode only.

## What is injected, plainly

**The failure is injected.** The harness (`packages/buyer-mcp/test/retry-harness.test.ts`) lets the real payment settle in simulated demo settlement, then makes the agent's next answer wrong. Three real-world equivalents:

1. **A lost response**: a timeout or transport error after the seller already settled.
2. **A wrong or stale text reaching the agent**: refund wording, "retry the call", "settlement pending, retry with the same payload", "network congestion, funds not deducted", a bare `HTTP 402`.
3. **The seller's upstream failing after payment** (and a seller-side error after settlement).

**Demo settlement is simulated.** In live mode, the same buyer path on the code before this change sends a new quote and a new deposit on a retry; in this harness the second deposit is a simulated one. The numbers below are about the buyer's behaviour, not about real funds.

## Scripted agents

- **naive**: retries on any error, up to 3 calls.
- **balance-checker**: reads what left its wallet before and after each attempt and stops retrying once money left; then asks for the payment id if a status tool exists.
- **control**: no failure, one call.

Assertions per run: seller ledger rows for the purchase, seller-side deposits, wallet deposits, and that the agent's final message can carry the payment id of the one payment.

## Results (deposits for one $0.25 purchase)

| Scenario | naive, before → after | balance-checker, before → after |
| --- | --- | --- |
| control (no failure) | 1 → 1 | 1 → 1 |
| (a) response lost after settlement | 2 → 1 | 1 → 1 |
| (b) refund text shown | 2 → 1 | 1 → 1 |
| (b) refund text plus "Retry the call." | 2 → 1 | 1 → 1 |
| (b) pending / PROCESSING text | 2 → 1 | 1 → 1 |
| (b) "network congestion" text | 2 → 1 | 1 → 1 |
| (b) bare HTTP 402 | 2 → 1 | 1 → 1 |
| (c) upstream failure after settlement | 2 → 1 | 1 → 1 |
| (c) seller error after settlement | 2 → 1 | 1 → 1 (before: ledger rows 0, the sale was never booked) |

Before the fix, the naive agent's two deposits were 0.507272 USDC for a 0.25 USDC price. The balance-checker avoided the second deposit before the fix too, but in the seller-error case the payment was never booked (0 ledger rows) and it could name no payment id. After the fix, every run in the 18-case matrix ends with exactly one ledger row, and the agent's final message carries that payment's id.

## What changed

See "Buyer retry safety" in the README: the operation journal, repeat-call semantics, `penstock_status`, the result envelope, server-side quote idempotency, and `maxUsd` covering price plus route fee.

## Honest limits

The journal's HMAC chain detects corruption, torn writes and naive edits; it is not protection against a malicious local user, who can read the key stored beside it. Replay within 10 minutes is a guess that an identical call is a retry. Upstream failure after payment is reported clearly but not refunded automatically.
