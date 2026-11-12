import { chainByKey, formatUnits } from "@penstock/core";
import { movedMoney, type MoneyMoved, type Operation, type OperationState, type RefundState } from "./journal";

/**
 * The envelope every penstock_* tool result carries, so an agent can always tell what happened to
 * its money and what to do next without reading prose.
 *
 * Wording rules (tested):
 *  - never "will be returned" unless the refund is confirmed (REFUNDED) or in progress per the route;
 *  - never "nothing was paid" unless the journal proves no deposit was started;
 *  - when unsure: "sent, not confirmed, do not retry, call penstock_status".
 */
export interface Envelope {
  state: OperationState | "ok" | "no_operation";
  money_moved: MoneyMoved;
  /** What the seller charges (the price). */
  amount_usdc: string | null;
  price_usdc: string | null;
  /** What the route costs on top of the price. */
  route_fee_usdc: string | null;
  /** The total taken from the wallet: price plus route fee. */
  total_debited_usdc: string | null;
  /** The origin-asset amount that leaves the wallet, e.g. "0.2536 USDC". */
  debited_from_wallet: string | null;
  /** The seller's payment id, once the payment is booked. */
  payment_id: string | null;
  operation_id: string | null;
  do_not_retry: boolean;
  next_action: string;
  /** USDC sent and not returned, across every operation in this buyer's journal. */
  paid_total_usdc: string;
  refund_state: RefundState;
}

const usdc = (v: string | bigint) => formatUnits(BigInt(v), 6);

function formatAsset(amount: string, symbol: string, chainKey: string | null): string {
  const chain = chainKey ? chainByKey(chainKey) : undefined;
  const a = chain?.assets.find((x) => x.symbol === symbol);
  return a ? formatUnits(BigInt(amount), a.decimals) : amount;
}

export function paidTotal(total: bigint): string {
  return usdc(total);
}

/**
 * The words for one operation. Pure, so the wording rules can be tested state by state. Every sentence starts with
 * "Operation <id>:", and every call it names carries the same id. When money moved or may have, the instruction
 * comes FIRST ("DO NOT RETRY. Check penstock_status with operation_id <id> before starting a new purchase.") and the
 * details (amounts, transaction hash, refund state) follow, so an alert that cuts the text keeps the instruction.
 */
export function describeOperation(op: Operation): { next_action: string; do_not_retry: boolean } {
  const r = describeRaw(op);
  const id = op.id;
  const text = r.next_action
    .replace(/call penstock_resume with operation_id and the transaction hash/g, `call penstock_resume with operation_id ${id} and the transaction hash`)
    .replace(/penstock_status(?! with)/g, `penstock_status with operation_id ${id}`);
  if (!r.do_not_retry) return { do_not_retry: false, next_action: `Operation ${id}: ${text}` };
  return { do_not_retry: true, next_action: `${leadInstruction(id)} ${text}` };
}

/**
 * The first sentence of every do-not-retry message. Within the first 120 characters it holds the operation id,
 * "DO NOT RETRY" and the call to make. Without an id (nothing readable on file) it is just "DO NOT RETRY."
 */
export function leadInstruction(id?: string | null): string {
  return id
    ? `Operation ${id}: DO NOT RETRY. Check penstock_status with operation_id ${id} before starting a new purchase.`
    : "DO NOT RETRY. No operation id is readable, so check with the seller before starting a new purchase.";
}

function describeRaw(op: Operation): { next_action: string; do_not_retry: boolean } {
  const amount = `${usdc(op.amountUsdc)} USDC`;
  const chain = op.originChain ? (chainByKey(op.originChain)?.label ?? op.originChain) : "the origin chain";
  const tx = op.txHash ?? "unknown";
  const refundTo = op.quote?.refundTo ?? "your refund address";
  switch (op.state) {
    case "quoted":
      if (op.manualDeposit && op.quote && new Date(op.quote.refundDeadline).getTime() < Date.now()) {
        return { do_not_retry: true, next_action: `This quote expired. If you already sent the deposit to ${op.quote.payTo}, call penstock_resume with operation_id and the transaction hash. If you did not send anything, call penstock_call again with new_purchase: true to get a new quote.` };
      }
      if (op.manualDeposit && op.quote) {
        return {
          do_not_retry: false,
          next_action: `Send ${op.quote.amount} base units of ${op.originSymbol ?? "the asset"} on ${chain} to ${op.quote.payTo}${op.quote.depositMemo ? ` (memo ${op.quote.depositMemo})` : ""} before ${op.quote.refundDeadline}, then call penstock_resume with operation_id and the transaction hash. Calling penstock_call again returns this same quote; it does not open a second one.`,
        };
      }
      return { do_not_retry: false, next_action: "A quote was obtained and no deposit has been sent. Calling penstock_call again continues this same quote; it does not open a second one." };
    case "deposit_sent_unconfirmed":
      if (!op.txHash && !op.exactPayload) {
        return {
          do_not_retry: true,
          next_action: `A deposit was started but this buyer has no confirmation that it was sent, so it may have been. Do not retry and do not call penstock_call again. Check your wallet for a transfer of ${op.quote?.amount ?? "the quoted amount"} to ${op.quote?.payTo ?? "the deposit address"}; if it went out, call penstock_resume with operation_id and the transaction hash, otherwise call penstock_status.`,
        };
      }
      return { do_not_retry: true, next_action: `Payment of ${amount} was sent${op.txHash ? ` (tx ${tx})` : ""} and is not yet confirmed by the seller. Do not retry: a retry pays again. Call penstock_status in a few seconds.` };
    case "confirming":
      return { do_not_retry: true, next_action: `Deposit sent (tx ${tx}); the seller has not confirmed delivery yet. Do not retry: a retry pays again. Call penstock_status in a few seconds.` };
    case "delivered":
      return { do_not_retry: true, next_action: `Done. The price was ${amount}${op.feeUsdc && op.feeUsdc !== "0" ? `, the route fee ${usdc(op.feeUsdc)} USDC, ${usdc(op.debitedUsdc)} USDC in total` : ""}; it was paid once and the result is in body. Do not call again for the same data: a repeat of this exact call within ten minutes returns this result, and after that it buys again (new_purchase: true buys again now).` };
    case "upstream_failed_after_settlement":
      if (op.refundState === "owed") {
        return { do_not_retry: true, next_action: `The payment of ${amount} settled, but the seller's upstream failed${op.resultStatus ? ` (HTTP ${op.resultStatus})` : ""}. The seller has booked a refund of ${usdc(op.refundAmountUsdc ?? op.amountUsdc)} USDC; the seller sends it, it is not automatic. Do not retry: a retry pays again. Call penstock_status for the refund state.` };
      }
      if (op.refundState === "refunded") {
        return { do_not_retry: false, next_action: `The seller's upstream failed and the seller has sent the refund of ${usdc(op.refundAmountUsdc ?? op.amountUsdc)} USDC. You can call penstock_call again.` };
      }
      return { do_not_retry: true, next_action: `The payment of ${amount} settled, but the seller's upstream failed${op.resultStatus ? ` (HTTP ${op.resultStatus})` : ""}. The seller has the funds; whether a refund is coming is not confirmed. Do not retry: a retry pays again. Keep the receipt and call penstock_status.` };
    case "refunded":
      return { do_not_retry: false, next_action: `The deposit was refunded to ${refundTo}. You can call penstock_call again to start a new purchase.` };
    case "expired":
      return { do_not_retry: false, next_action: "The quote expired and no deposit was started. Calling penstock_call again opens a new quote." };
    case "failed":
      if (op.refundState === "in_progress") {
        return { do_not_retry: true, next_action: `1Click reports the swap FAILED. 1Click returns failed swaps to ${refundTo}; that refund is in progress and not yet confirmed. Do not retry. Call penstock_status until refund_state is refunded.` };
      }
      if (op.txHash || op.exactPayload) {
        return { do_not_retry: true, next_action: `The purchase failed after a deposit was sent${op.txHash ? ` (tx ${tx})` : ""}, so funds may be with the seller or in a refund. Do not retry. Call penstock_status.` };
      }
      return { do_not_retry: false, next_action: `The purchase did not go through: ${op.lastError ?? "it was refused"}. No deposit was started, so no money left. You may adjust and call again.` };
  }
}

export function envelopeFor(op: Operation, total: bigint): Envelope {
  const { next_action, do_not_retry } = describeOperation(op);
  return {
    state: op.state,
    money_moved: movedMoney(op),
    amount_usdc: usdc(op.amountUsdc),
    price_usdc: usdc(op.amountUsdc),
    route_fee_usdc: usdc(op.feeUsdc || "0"),
    total_debited_usdc: usdc(op.debitedUsdc || op.amountUsdc),
    debited_from_wallet: op.debited ? `${formatAsset(op.debited.amount, op.debited.symbol, op.originChain)} ${op.debited.symbol}` : null,
    payment_id: op.paymentId ?? ((op.receipt as { body?: { paymentId?: string } } | null)?.body?.paymentId ?? null),
    operation_id: op.id,
    do_not_retry,
    next_action,
    paid_total_usdc: usdc(total),
    refund_state: op.refundState,
  };
}

/** For results that involve no operation: search, routes, and calls refused before any quote. */
export function plainEnvelope(total: bigint, next_action: string, state: Envelope["state"] = "no_operation"): Envelope {
  return { state, money_moved: "no", amount_usdc: null, price_usdc: null, route_fee_usdc: null, total_debited_usdc: null, debited_from_wallet: null, payment_id: null, operation_id: null, do_not_retry: false, next_action, paid_total_usdc: usdc(total), refund_state: "none" };
}
