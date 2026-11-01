import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators, buildDelegateAction, encodeSignedDelegate } from "@near-js/transactions";
import { computeTimeoutBlocks, createClientNearSigner, toBase64, type ClientNearSigner } from "@x402/near";
import { simNearBlockHeight, simNearNonce } from "@penstock/core";

/**
 * NEAR signers for the buyer. `simulatedNearWallet` signs genuine NEP-366 delegate actions with
 * an ephemeral key, but takes nonce and block height from the shared simulated clock instead of
 * NEAR RPC. It is only accepted by a Penstock proxy in demo or dry mode. `liveNearWallet` is the
 * reference RPC-backed signer from @x402/near.
 */

export interface NearWallet extends ClientNearSigner {
  accountId: string;
  simulated: boolean;
}

const FT_TRANSFER_GAS = 30_000_000_000_000n;

export function simulatedNearWallet(accountId = `sim-agent-${Math.random().toString(36).slice(2, 8)}.near`): NearWallet {
  const signer = new KeyPairSigner(KeyPair.fromRandom("ed25519"));
  return {
    accountId,
    simulated: true,
    async createSignedDelegateAction({ paymentRequirements: req }) {
      const publicKey = await signer.getPublicKey();
      const transfer = actionCreators.functionCall("ft_transfer", { receiver_id: req.payTo, amount: req.amount }, FT_TRANSFER_GAS, 1n);
      const delegate = buildDelegateAction({
        actions: [transfer],
        maxBlockHeight: simNearBlockHeight() + computeTimeoutBlocks(req.maxTimeoutSeconds),
        nonce: simNearNonce(),
        publicKey,
        receiverId: req.asset,
        senderId: accountId,
      });
      const [, signed] = await signer.signDelegateAction(delegate);
      return toBase64(encodeSignedDelegate(signed));
    },
  };
}

export function liveNearWallet(accountId: string, secretKey: string): NearWallet {
  const inner = createClientNearSigner({ accountId, secretKey: secretKey as KeyPairString });
  return { accountId, simulated: false, createSignedDelegateAction: (i) => inner.createSignedDelegateAction(i) };
}
