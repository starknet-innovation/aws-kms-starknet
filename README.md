# Starknet operations with AWS KMS

Fork this project to deploy a Starknet account, transfer tokens, and invoke contracts on **mainnet**, with signatures produced by your own AWS KMS key. It includes a reusable TypeScript signer, a pinned OpenZeppelin account preset, a minimal custom account, and runnable examples. Bring your own AWS infrastructure, credentials, RPC endpoint, and funds.

## How it works

AWS KMS does not offer the Stark curve normally used by Starknet accounts. This project pairs a KMS `ECC_SECG_P256K1` signing key with OpenZeppelin's `EthAccountComponent`. The account verifies secp256k1 signatures on Starknet; it is not an Ethereum account address or an ordinary Stark-curve wallet.

```text
Your application → Starknet.js transaction hash → AWS KMS Sign
                                                      ↓
Starknet mainnet ← EthAccount verifies signature ← DER signature → Cairo r/s limbs
```

KMS signs the 32-byte Starknet transaction digest with `MessageType: DIGEST` and `ECDSA_SHA_256`. The latter selects the KMS signing algorithm; the digest is **not hashed again**. The private key remains in KMS. The application retrieves only the public key and signatures. See [AWS key specs](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html), [KMS Sign](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html), and [OpenZeppelin accounts](https://docs.openzeppelin.com/contracts-cairo/4.x/accounts).

## What you provide

- An existing AWS KMS asymmetric key: `ECC_SECG_P256K1`, usage `SIGN_VERIFY`.
- Credentials authorized for `kms:GetPublicKey` and `kms:Sign` on that key. Use your existing IAM role, AWS profile, or runtime credential injection. No AWS resources are provisioned by this project.
- Your own Starknet **mainnet** RPC endpoint compatible with Starknet.js 10.8.0 (RPC 0.9 or supported 0.10). The CLI checks `SN_MAIN` before using it for transactions.
- STRK for transaction fees. The default OpenZeppelin class is already declared on mainnet; custom classes need a separate declaration through an existing funded account.

Never put a Starknet or Ethereum private key in `.env`. The KMS key ID is an identifier, not a private key. Your RPC URL may contain a secret. `.env` and build output are ignored by Git.

## Set up

Use Node.js 22.19+, Scarb **2.18.0**, and Starknet Foundry **0.60.0**. Dependencies are pinned in the npm and Scarb lockfiles. The preset dependency uses the exact OpenZeppelin v4.0.0 Git commit. Install the Cairo tools using their official [Scarb](https://docs.swmansion.com/scarb/download.html) and [Foundry](https://foundry-rs.github.io/starknet-foundry/getting-started/installation.html) instructions.

```sh
npm ci
npm run preset:build
cp .env.example .env
```

Fill `.env` from your existing infrastructure. Node loads it for CLI commands; already-set environment variables take precedence. AWS credentials use the SDK's default provider chain.

### Use the declared account class

The default is OpenZeppelin **4.0.0 `EthAccountUpgradeable`**:

```text
0x000be1cf8839442d664572712fd36554c4d259f86549ad02e22353d10729b900
```

The release build in `contracts/preset` reproduces this exact [published class hash](https://docs.openzeppelin.com/contracts-cairo/4.x/presets). The preset supports owner-authorized upgrades and key rotation. This exact class is now declared on mainnet in [transaction 0x016acc…f2361](https://voyager.online/tx/0x016acc441f717d0317b2d85bb60c174d1c69c725bde0db2d17000be68a2f2361), block `14772785`. Forks can reuse it directly. Check the artifact and current declaration status with your RPC:

```sh
npm run cli -- class-hash
npm run cli -- inspect
```

`class-hash` computes the selected artifact's hash locally, without AWS or RPC access. `inspect` prints `classDeclared` along with the counterfactual address. The default preset should report `true`; no declaration fee is needed when reusing it.

The class was copied from Sepolia with `sncast declare-from`, preserving its exact hash. The source artifact was checked against the local release build before submission and fetched back from mainnet after confirmation. The declaration succeeded with `ACCEPTED_ON_L2` status. Its signer was an existing funded account. A subsequent [live mainnet run](docs/mainnet-validation.md) successfully deployed a KMS-owned account, transferred STRK, and invoked a contract using real AWS KMS signatures.

To declare a different class from Sepolia in the future, use this pattern with that class hash:

```sh
sncast --account YOUR_EXISTING_ACCOUNT --wait declare-from \
  --class-hash 0xYOUR_CLASS_HASH \
  --source-url https://sepolia.nodes.starknet.org/rpc/v0_10 \
  --url https://mainnet.nodes.starknet.org/rpc/v0_10 \
  --dry-run --detailed
```

Remove `--dry-run --detailed` and supply your chosen `--max-fee` in fri to submit (1 STRK = 10^18 fri). The source is Sepolia; the transaction and fee payment happen on mainnet. `sncast` manages its own signing credentials and does not read this project's `.env`.

For a custom account, edit `contracts/src/lib.cairo` and run `npm run contracts:build`. Set `STARKNET_ACCOUNT_ARTIFACT=contracts/target/dev/starknet_aws_kms_KmsAccount.contract_class.json`, run `class-hash`, and set `STARKNET_ACCOUNT_CLASS_HASH` to the result. Declare `KmsAccount` from `contracts` with the dev profile. This minimal alternative uses OpenZeppelin 3.0.0 and has no upgrade entrypoint. The CLI always checks the configured class hash against the selected local artifact.

### Verify your KMS connection

```sh
npm run cli -- kms-check
```

This makes a real KMS `Sign` request and verifies the signature locally against the KMS public key. It does not submit a transaction and does not require RPC or account configuration. KMS request charges apply. Successful output includes `kmsSigningVerified: true`.

For a fuller integration check, run `npm run test:kms`. It asks real AWS KMS to sign deploy-account, transfer, and invoke **V3 query** payloads, then verifies those signatures through the exact OpenZeppelin preset in the local Cairo VM. It also verifies that changed digests are rejected. This needs the Cairo tools but no RPC or mainnet funds; it does not broadcast. The temporary Cairo fixture is removed after the run.

## 1. Deploy an account

```sh
npm run cli -- inspect
```

This checks mainnet, the KMS public key, and class declaration status, then prints the counterfactual address and constructor calldata. Proceed only when `classDeclared` is `true`. Fund **that Starknet address** with enough STRK for deployment and later fees using your existing wallet. Keep the KMS key, class hash, and salt unchanged after funding: together they determine the address. An Ethereum address derived from the same key is not the destination.

```sh
npm run cli -- deploy
npm run cli -- deploy --broadcast --max-fee-strk 2
```

The first command estimates fees with signature validation enabled. The second estimates again, checks its resource bounds against your STRK cap, signs in KMS, and submits. `2` is an illustrative cap, not a fee recommendation; choose your own after inspecting the estimate. Estimates may require a funded counterfactual account. A deployed account should not be deployed again.

## 2. Transfer tokens

Set token and recipient addresses to the actual mainnet contracts you intend to use:

```sh
npm run cli -- transfer --token 0xTOKEN --to 0xRECIPIENT --amount-base-units 1000000
npm run cli -- transfer --token 0xTOKEN --to 0xRECIPIENT --amount-base-units 1000000 --broadcast --max-fee-strk 2
```

Replace all placeholders. Amounts are positive integer **token base units**, encoded as Cairo `u256`. For a token with six decimals, `1000000` means one token; for an 18-decimal token it does not. The account needs both the transfer balance and STRK for fees.

## 3. Invoke a contract

```sh
npm run cli -- invoke --contract 0xCONTRACT --entrypoint YOUR_FUNCTION --calldata '["123", "456"]'
npm run cli -- invoke --contract 0xCONTRACT --entrypoint YOUR_FUNCTION --calldata '["123", "456"]' --broadcast --max-fee-strk 2
```

Calldata is an array of string-encoded felts in the target contract's ABI order. Encode structs, arrays, and `u256` values before passing them; use Starknet.js `CallData` in your application for complex ABIs. `invoke` signs and executes through your account. A read-only call uses no AWS credentials:

```sh
npm run cli -- call --contract 0xCONTRACT --entrypoint YOUR_VIEW --calldata '[]'
```

Submission prints the transaction hash immediately, then waits for a successful receipt. If waiting times out, look up that hash with your RPC or explorer before resubmitting. Run transactions sequentially for a given account, or add nonce coordination in your own service.

## Adapt the signer

```ts
import { KMSClient } from '@aws-sdk/client-kms';
import { RpcProvider } from 'starknet';
import { KmsSigner, connectAccount, verifyDeployedAccount } from './src/index.js';

const kms = new KMSClient({ region: process.env.AWS_REGION });
const signer = new KmsSigner(kms, process.env.AWS_KMS_KEY_ID!);
const provider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
const account = await connectAccount(provider, signer, process.env.STARKNET_ACCOUNT_ADDRESS!);
await verifyDeployedAccount(provider, signer, account.address, process.env.STARKNET_ACCOUNT_CLASS_HASH!);
// Use account.estimateInvokeFee / account.execute with your application's fee policy.
// The complete estimate → cap → execute flow is in examples/cli.ts.
```

`KmsSigner` supports V3 invoke, deploy-account, and declare transaction signing, including V3 query versions. The three CLI write examples use it directly. Typed messages are deliberately unsupported; `signHash` is a low-level digest operation for integrations and the KMS diagnostic. The CLI fee cap is not an IAM or signer-level spending policy.

See [architecture and operational considerations](docs/architecture.md) for account compatibility, key rotation, and trust boundaries. This is an integration example, not an audited custody service.

## Verify changes

```sh
npm run verify
```

Builds both Cairo accounts and TypeScript, checks the published preset hash, runs TypeScript tests, and executes both accounts’ tests in the local Cairo VM. The tests cover real ECDSA computation through a mocked KMS transport, transaction hash parity with Starknet.js, public-key ABI encoding, and Cairo verification of the same signature fixture. These local tests do not broadcast transactions. The separate [mainnet validation report](docs/mainnet-validation.md) records successful live KMS-signed deployment, transfer, and invocation. Run `kms-check` with your own infrastructure to verify the real KMS path, then the three examples to validate your deployment.

Licensed under [MIT](LICENSE).
