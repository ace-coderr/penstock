/** USDC storage registration for the seller account (NEP-145 `storage_deposit`). */
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators, createTransaction } from "@near-js/transactions";
import { base58Decode } from "@penstock/intents-adapter";
import { NEAR_USDC, nearAccessKey, nearSendTx } from "./rpc";

export const STORAGE_DEPOSIT_GAS = 30_000_000_000_000n;

export async function registerUsdcStorage(opts: { nearRpc: string; accountId: string; secret: string; depositYocto: bigint }): Promise<{ hash: string; ok: boolean; failure?: unknown }> {
  const keyPair = KeyPair.fromString(opts.secret as KeyPairString);
  const publicKey = keyPair.getPublicKey();
  const key = await nearAccessKey(opts.nearRpc, opts.accountId, publicKey.toString());
  if (!key || key.permission !== "FullAccess") throw new Error("SELLER_NEAR_PRIVATE_KEY is not a full-access key of SELLER_NEAR_ACCOUNT");
  const action = actionCreators.functionCall("storage_deposit", { account_id: opts.accountId, registration_only: true }, STORAGE_DEPOSIT_GAS, opts.depositYocto);
  const tx = createTransaction(opts.accountId, publicKey, NEAR_USDC, BigInt(key.nonce) + 1n, [action], base58Decode(key.block_hash));
  const [, signed] = await new KeyPairSigner(keyPair).signTransaction(tx);
  return nearSendTx(opts.nearRpc, Buffer.from(signed.encode()).toString("base64"));
}
