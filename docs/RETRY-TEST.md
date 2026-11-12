# Retry test: one purchase, one payment

The double-payment path was found by running LLM agents against Penstock with Clearance (https://github.com/Selliksss/clearance), an outside agent-testing project. In that run, settlement was Penstock's own demo simulation. The fix and our scripted before/after are described here.

An outside test of LLM agents against the buyer MCP found that, after the first paid call hit an error, most agents called again, which opened a new quote and a new deposit: the seller received two payments while the agent reported one. This file describes the scripted reproduction and the fix. It runs in demo mode only.

## If a payment is not confirmed (for whoever is on call)

A tool result can say that a payment was sent but is not confirmed, or that it settled but the seller's upstream failed. Those results are real and the money may have moved. Two examples, copied from real demo-mode runs (simulated settlement; ids as they came out):

**Deposit sent, not confirmed**

```json
{
  "state": "confirming",
  "money_moved": "yes",
  "do_not_retry": true,
  "operation_id": "op_1f201918aa294902",
  "payment_id": null,
  "next_action": "Operation op_1f201918aa294902: Deposit sent (tx sim:0x4404d6bc097a2fb86f3ffb596714f846cf0f6e25239d91a3df65fe468ccc4287); the seller has not confirmed delivery yet. Do not retry: a retry pays again. Call penstock_status with operation_id op_1f201918aa294902 in a few seconds."
}
```

**Settled, upstream failed**

```json
{
  "state": "upstream_failed_after_settlement",
  "money_moved": "yes",
  "do_not_retry": true,
  "operation_id": "op_2210fc5a7f104742",
  "payment_id": "pay_2fd927cdd44b490f",
  "next_action": "Operation op_2210fc5a7f104742: The payment of 0.25 USDC settled, but the seller's upstream failed (HTTP 502). The seller has the funds; whether a refund is coming is not confirmed. Do not retry: a retry pays again. Keep the receipt and call penstock_status with operation_id op_2210fc5a7f104742."
}
```

**What to copy.** The operation id: the text after the word `Operation` at the start of `next_action` (for example `op_1f201918aa294902`). It is also the `operation_id` field. Every call named in the message already carries it.

**Do this, in order:**

1. **Do not call `penstock_call` again.** A second call for the same thing is how a second payment starts.
2. **Call `penstock_status` with that `operation_id`.** It asks the seller what happened and, where it can, finishes the delivery without sending money.
3. **If the state is still unconfirmed after a few minutes,** look up the origin-chain transfer to the deposit address named in the message, then call `penstock_resume` with the `operation_id` and the transaction hash. It never sends a second deposit.
4. **Start a new purchase (`new_purchase: true`) only when** the status says `refunded`, or `expired` with no deposit started, or `delivered` and you really want fresh data.

**What each state means** (`money_moved` is whether your money left and has not come back):

| State | money_moved | In one line |
| --- | --- | --- |
| `quoted` | no | A quote exists, no deposit was started. A repeat call continues the same quote. |
| `deposit_sent_unconfirmed` | yes, or unknown if no transaction hash was recorded | A deposit was started or sent and the seller has not confirmed it. If unknown, it may have been sent: do not retry. |
| `confirming` | yes | The deposit's transaction is known; delivery is not confirmed yet. |
| `delivered` | yes | Paid once and delivered. The result and `payment_id` are in the result. |
| `upstream_failed_after_settlement` | yes | The seller has the payment but its upstream failed. `refund_state` says whether a refund is booked (`owed`) or sent (`refunded`); `none` means not confirmed either way. |
| `refunded` | no | The route reported REFUNDED: the deposit was returned. |
| `failed` | no if no deposit was started; otherwise yes or unknown | The purchase did not complete. With `refund_state: in_progress` the route reported FAILED and is returning the deposit; it is not confirmed yet. |
| `expired` | no | The quote ran out before any deposit was started. |

**An honest note.** In these samples the ids start with `op_` and transaction hashes with `sim`, because demo mode simulates settlement; no real funds are involved. In live mode, a deposit that was sent but not yet recorded is detected through 1Click's status for the deposit address, and that status can lag behind the chain, so "not confirmed" can last a few minutes even when everything is fine.

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

## Restarts

`packages/buyer-mcp/test/restart.test.ts` stops the buyer dead at named points (nothing after the stop is written to the journal), then starts a fresh buyer on the same journal directory and makes the same call. Crash points: after the intent is written, after the quote is recorded, after the deposit is broadcast but before its hash is written, after the deposit is recorded, and after the seller answered but before the answer is recorded. After every restart the call resumes the same operation (same operation id, same deposit address), the seller shows one deposit and one settled payment, and the payment id and paid total are right. A real killed child process leaves its lock file behind in one case; a restart in a different working directory and a deadline that passed after broadcast are covered too.

**Honest limit.** Demo mode simulates the deposit. In live mode a deposit that was sent but not yet recorded is detected only through the route's status check (the deposit address's status shows the transaction), so it depends on 1Click showing the deposit, which can lag. If the crash comes after the intent is marked "deposit started" but before the wallet sends, the buyer cannot tell whether anything left: it reports "may have been sent, do not retry", sends nothing more, and waits for the route's status or a transaction hash from the agent (`penstock_resume`).

## What changed

See "Buyer retry safety" in the README: the operation journal, repeat-call semantics, `penstock_status`, the result envelope, server-side quote idempotency, and `maxUsd` covering price plus route fee.

## Honest limits

The journal's HMAC chain detects corruption, torn writes and naive edits; it is not protection against a malicious local user, who can read the key stored beside it. Replay within 10 minutes is a guess that an identical call is a retry. Upstream failure after payment is reported clearly but not refunded automatically.
