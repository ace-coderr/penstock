/**
 * One SPL USDC transfer on Solana mainnet: from the payer to a 1Click deposit address. Creates the
 * deposit address's USDC token account first if it does not exist (idempotent instruction).
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { base58Decode, base58Encode } from "@penstock/intents-adapter";
import { SOLANA_USDC_MINT } from "./rpc";

export interface UsdcTransfer {
  rpcUrl: string;
  payerSecret: string;
  to: string;
  amount: bigint;
}

/** Builds and signs the transfer; returns the signature (the transaction id) and the raw bytes. */
export async function buildUsdcTransfer(t: UsdcTransfer): Promise<{ signature: string; raw: Buffer; lastValidBlockHeight: number; blockhash: string }> {
  const payer = Keypair.fromSecretKey(base58Decode(t.payerSecret));
  const mint = new PublicKey(SOLANA_USDC_MINT);
  const owner = new PublicKey(t.to);
  const source = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const dest = getAssociatedTokenAddressSync(mint, owner, true);
  const conn = new Connection(t.rpcUrl, "confirmed");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dest, owner, mint),
    createTransferCheckedInstruction(source, mint, dest, payer.publicKey, t.amount, 6),
  );
  tx.sign(payer);
  const signature = tx.signatures[0]!.signature!;
  return { signature: base58Encode(signature), raw: tx.serialize(), lastValidBlockHeight, blockhash };
}

export async function sendAndConfirm(rpcUrl: string, raw: Buffer, signature: string, blockhash: string, lastValidBlockHeight: number): Promise<"confirmed" | "failed"> {
  const conn = new Connection(rpcUrl, "confirmed");
  await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
  const r = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return r.value.err ? "failed" : "confirmed";
}
