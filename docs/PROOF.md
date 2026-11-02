# Proof: real transactions on mainnet

Everything on this page happened on Solana mainnet and NEAR mainnet with real funds. Nothing here is simulated. Each hash links to a public explorer, so anyone can check it. The run followed [LIVE-RUNBOOK.md](LIVE-RUNBOOK.md): separate dev accounts, tiny amounts, a dry quote first, a $1 cap enforced in code, and a human "yes" before the send.

Accounts (dev accounts used only for this):
- Payer: `Cp4TVsDsqTY18nEvSBYpqUWpkJYaQ6kNdUx6qcAAYMB3` (Solana)
- Seller: `acedevv.near` (NEAR)

## 1. One x402 payment from Solana, settled as USDC on NEAR (2026-11-02)

An HTTP request to a Penstock-protected API (`GET /p/tidewater/tides-now`, price $0.01) got HTTP 402. The payer paid with USDC on Solana. NEAR Intents (1Click) delivered USDC to the seller's NEAR account. The retried request got HTTP 200 with the API response and a signed Penstock receipt. The proxy ran in live mode on the developer's machine (loopback only), with no facilitator: this is the near-intents path.

| Step | When (UTC) | What | Proof |
| --- | --- | --- | --- |
| Quote | 22:45:18 | Penstock asked 1Click for an `EXACT_OUTPUT` quote: deliver 0.010000 USDC to `acedevv.near`, refund to the payer on Solana. 1Click returned deposit address `GhEoS7T28yza7yTVHYx86GouxUauVgPxGg9ip96ygBsG`, `amountIn` 0.014949 USDC (`minAmountIn` 0.014847), `withdrawFee` 0.004842 USDC. The quote's ed25519 signature was verified before use. | 1Click correlation id `6df62868-c4cb-4e8a-88bf-754cdee0ffc9` |
| Deposit (Solana) | 22:45:40 | The payer sent 0.014949 USDC to the deposit address (created its token account, then `transferChecked`). Payer USDC 4.1 → 4.085051; SOL 0.009058 → 0.007565 (network fee plus token-account rent). | [56542cnA…VDqPHSg](https://solscan.io/tx/56542cnAqGL58AzFZxoWEzESCNrAe8uzGdu2bT6JUKPyCwVypwQFMYEMk3qGGGJBeKUeHMqrqAg21NZxsVDqPHSg) |
| Bridge in (NEAR) | 22:46:42 | Omni Bridge finalised the Solana deposit on NEAR (Wormhole VAA verified) and minted the bridged USDC into `intents.near`. | [7sd4k8WU…Ni5qeAA](https://nearblocks.io/txns/7sd4k8WUQEdNeJbXbiwo4J1t3PSCgFrAMhKkja2TTXNn) |
| Swap (NEAR Intents) | 22:46:50, 22:47:06 | Intent execution inside `intents.near` (intents `7Yn4C1tP…nESR`, `YoPg3i7g…9nm`). | [ESSqz2Hn…eAA](https://nearblocks.io/txns/ESSqz2Hn2CMbvuL74j34YjGk2Bexw5xd4ezHk8j5qeAA), [FZ7MQT2Q…4ni](https://nearblocks.io/txns/FZ7MQT2QHqwZeAnvUA8CXyue5aQV2AEAmZcpbDAYY4ni) |
| Delivery (NEAR) | 22:47:09 | `intents.near` withdrew to the seller: `storage_deposit` of 0.00125 NEAR on the USDC contract for `acedevv.near` (its first USDC registration, paid by 1Click from the swap), then `ft_transfer` of 0.010000 USDC to `acedevv.near`. | [Ggb5B734…Ac3MA](https://nearblocks.io/txns/Ggb5B734pfQVDefs12eJ3xsE6sLbeRjcN3j56a7Ac3MA) |
| 1Click status | 22:47:14 | `SUCCESS`: deposited 0.014949, used 0.014847, delivered 0.010000 USDC. | `GET /v0/status?depositAddress=GhEoS7T2…ygBsG` |
| HTTP 200 + receipt | 22:47:14 | Penstock confirmed the delivery against 1Click (origin tx in `originChainTxHashes`, terms matching the seller), returned the API response and the signed receipt below. | receipt `pay_344e32ceb8be4004` |

After the run, `acedevv.near` holds 0.01 USDC (`ft_balance_of` = 10000), and `storage_balance_of(acedevv.near)` on the USDC contract went from `null` to registered.

The signed Penstock receipt (ed25519 over the canonical JSON of `body`; it verifies with `verifyReceipt` from `@penstock/core`):

```json
{
  "body": {
    "v": 1,
    "kind": "payment",
    "paymentId": "pay_344e32ceb8be4004",
    "seller": "acedevv.near",
    "endpoint": "tidewater.tides-now",
    "resource": "http://localhost:4020/p/tidewater/tides-now",
    "amountUsdc": "10000",
    "network": "near:mainnet",
    "transaction": "Ggb5B734pfQVDefs12eJ3xsE6sLbeRjcN3j56a7Ac3MA",
    "originChain": "sol",
    "originTx": "56542cnAqGL58AzFZxoWEzESCNrAe8uzGdu2bT6JUKPyCwVypwQFMYEMk3qGGGJBeKUeHMqrqAg21NZxsVDqPHSg",
    "payer": "Cp4TVsDsqTY18nEvSBYpqUWpkJYaQ6kNdUx6qcAAYMB3",
    "ts": 1793659634493,
    "simulated": false
  },
  "sig": "kMgWqDVCtib5jsRFdVcv7UP_J-uAeRDUPFuRAABmW7-nU8gdgtNMx4RHOJ79K0-_07V8EKXWheLbGIDNiI04CA",
  "pub": "_cGrqV19QgXAuQgcw3bZi1xkfnkD5wxNzhBQwJfL6ow"
}
```

**What this proves**
- An x402 paywall in front of an HTTP API took a payment in a token on another chain (USDC on Solana) and the seller received USDC on NEAR, with one HTTP retry and no seller action.
- The seller needed no NEAR, no wallet action and no key: 1Click registered the seller's USDC storage as part of the first delivery (the `storage_deposit` in the delivery transaction).
- Penstock released the API response only after 1Click reported `SUCCESS` for this exact deposit, and its receipt names both chains' transactions.

The API response itself is the example tide service bundled with Penstock (deterministic sample data); the payment around it is real.
