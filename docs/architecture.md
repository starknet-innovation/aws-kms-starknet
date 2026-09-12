# Architecture and adaptation notes

## Signing boundary

`src/kms-signer.ts` implements Starknet.js's signer interface. It computes standard V3 transaction hashes with Starknet.js; it does not construct Ethereum transactions. It requires `SN_MAIN` and accepts only V3 and fee-query V3 transaction versions.

On first use it calls `GetPublicKey`, validates the KMS key spec, usage, and algorithm, decodes the SPKI public key through Node's crypto library, and caches the full secp256k1 point and resolved key ARN. Later `Sign` requests use that ARN even when initialization used an alias. Every DER signature is parsed, normalized to low-S, and verified locally against the exact digest and pinned public key before being returned.

Both the pinned OpenZeppelin 4.0.0 preset and the optional 3.0.0 custom accounts verify a full public key and deserialize a signature as `[r.low, r.high, s.low, s.high]`. Each limb is 128 bits. There is no recovery ID or Ethereum personal-sign prefix. This is specific to the included account; other secp256k1 accounts can use different formats. The full public key constructor is `[x.low, x.high, y.low, y.high]`.

Upstream references: [KMS GetPublicKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_GetPublicKey.html), [KMS Sign](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html), [OpenZeppelin signature implementation](https://github.com/OpenZeppelin/cairo-contracts/blob/v4.0.0/packages/account/src/utils/signature.cairo).

## Account and declaration

`contracts/preset` compiles the upstream OpenZeppelin 4.0.0 `EthAccountUpgradeable` at commit `4485016e27f71c3e95839a0cdac3d646512f6e15` with Scarb 2.18.0 release settings. Its computed hash must match the pinned preset hash in `src/account-class.ts`. It supports owner-authorized upgrades, owner-key rotation, and SRC9 outside execution. This project exposes only the transaction-signing flows described in the README. An account upgrade changes its class hash; the CLI will reject further use until its artifact and configured hash are updated and checked.

The optional `contracts/src/lib.cairo` composes OpenZeppelin's account and SRC5 components. It has no upgrade mechanism. The inherited account interface includes owner-key rotation with a proof from the new key. The template provides no recovery role, multisig, or rotation command.

Declaring a class makes its code available on Starknet. Deploying an account creates one instance with its own owner key and salt. The class can be reused by multiple users without sharing ownership. The CLI checks the locally compiled class hash against the configured class. `inspect` reports declaration status; transaction commands require the class to exist on mainnet. RPC errors other than class-not-found are propagated. It also checks the deployed account class and on-chain public key before transfer or invocation.

If you modify the Cairo code or compiler/dependency versions, rebuild, declare the resulting class if needed, and recompute addresses. Never reuse an old funding address after changing deployment parameters without checking the resulting address. Review compiler/Sierra compatibility with your current mainnet before declaring a newly compiled artifact.

## Credentials and permissions

The application uses your existing AWS credential chain. A runtime normally needs only `kms:GetPublicKey` and `kms:Sign` scoped to the supplied key, with the corresponding key policy or grant authorizing it. Configure those permissions through your own infrastructure. `CreateKey`, `Decrypt`, and `GetSecretValue` are not needed.

Anyone with permission to sign using this key can authorize account transactions. KMS does not understand token recipients, contract calls, or amounts. Enforce application authorization and spending limits before signing; the CLI's explicit broadcast flag and fee cap only govern that CLI process. Never expose `signHash` as an unauthenticated signing API.

## Mainnet execution

The CLI checks the actual RPC chain ID and uses an explicit zero tip. It estimates with validation enabled, then submits with the same nonce and bounded resource limits. The fee cap is the sum of the three resource amounts multiplied by their respective maximum prices, in fri (10^-18 STRK). It limits fees, not transferred value or the effects of invoked contracts. Gas price movement can still cause a bounded transaction to fail or remain pending.

The provider is a trust boundary for chain state, nonce, and estimates. Use an endpoint you trust. For unattended jobs, persist transaction hashes before retrying and coordinate nonces across workers. A lost submission response can mean a transaction was accepted even if the client saw an error. No automatic application-level resubmission is implemented.

Moving an alias does not rotate an already-running signer: it keeps its original ARN. Starting a new signer after alias reassignment changes its public key; deployed account checks will reject that mismatch. Actual owner rotation requires an account transaction following OpenZeppelin's ownership protocol. Disabling/deleting the original KMS key before migrating ownership can make funds inaccessible.

## Testing scope

The local suites verify transport request shapes, signature correctness and rejection cases, Starknet.js hash compatibility, Cairo account verification, constructor encoding, input validation, and fee limits. KMS is mocked only in tests. Runtime commands always use the real AWS SDK.

Local test keys are public fixtures and must never be funded. `kms-check` performs a real KMS signature without an on-chain transaction. `npm run test:kms` additionally signs three V3 query payloads (deploy-account, transfer, invoke) in KMS and checks the resulting signatures in the exact OpenZeppelin preset in the local Cairo VM, including rejection after digest tampering. The transaction hash is injected into the local VM for verification; this is not a mainnet execution test. A full integration run additionally requires the user's key, endpoint, declared account class, and funded mainnet account. The preset class was declared on mainnet in transaction `0x016acc441f717d0317b2d85bb60c174d1c69c725bde0db2d17000be68a2f2361`, block `14772785`, and fetched back to verify its hash. That bootstrap declaration used an existing Stark-curve account. A subsequent funded integration run successfully deployed the KMS-owned account, transferred STRK, and invoked STRK approve using real AWS KMS signatures on mainnet. See the [mainnet validation report](mainnet-validation.md) for transaction evidence, fees, and verified state.
