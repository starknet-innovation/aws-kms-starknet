# Mainnet validation

Completed on 2026-09-12 using real AWS KMS secp256k1 signatures and the project's CLI against Starknet mainnet. All three transactions returned `SUCCEEDED` and `ACCEPTED_ON_L2` at verification.

Account: [0x738ab187cab45340e23ec4f8f9e518bdbf02eaaffcf6958d110942625947a13](https://voyager.online/contract/0x738ab187cab45340e23ec4f8f9e518bdbf02eaaffcf6958d110942625947a13)

Class: `0x000be1cf8839442d664572712fd36554c4d259f86549ad02e22353d10729b900` (OpenZeppelin 4.0.0 EthAccountUpgradeable). The owner key was generated and used inside AWS KMS; the CLI retrieved only its public key and signatures.

| Operation signed by KMS | Evidence | Block | Actual fee (STRK) |
| --- | --- | --- | --- |
| Deploy KMS-owned account | [Transaction](https://voyager.online/tx/0x8a6e05199ed4d8d29a2a04e999a80858756f00edce0a3fe6115a5c719a4a51) | 14773241 | 0.590934835037801123 |
| Transfer 0.001 STRK back to funder | [Transaction](https://voyager.online/tx/0xe328d2cf0e779a3bc487f9c210b678b1d5d8d83677e8d605880d9931de769e) | 14773263 | 0.543009365950887630 |
| Invoke STRK approve with zero allowance | [Transaction](https://voyager.online/tx/0x9c4fd3650825e27cfa05dbb4e9ef538736c5055eec9c3ae1f03cedb142cf49) | 14773272 | 0.535514100375562914 |

An existing account [funded the KMS account with 10 STRK](https://voyager.online/tx/0x064d7b36fcc7d6d31ba678f08ff4529c03a36d90cbd0fbf8cbb059fee756e3d2). That bootstrap transfer and the earlier class declaration used the existing account's signer. Their fees were paid separately by that account.

The three KMS-signed operations consumed **1.669458301364251667 STRK** in fees. After returning 0.001 STRK to the funder, **8.329541698635748333 STRK** remained in the KMS account at completion. The final nonce was 3.

Verification checked successful receipts, the deployed class and owner public key, the token's Transfer and Approval events, zero allowance for the funder, and the final balance reconciled against actual fees. Each KMS transaction used a 2 STRK maximum fee cap. These results cover account deployment, token transfer, and a generic contract invocation; fees and balances are observations from this run.

To reproduce with your own infrastructure, follow the [README](../README.md), derive and fund your own account, then run deploy, transfer, and invoke with explicit fee caps. The generic invocation in this run called STRK's `approve` entrypoint with calldata `[fundingAddress, "0", "0"]`.
