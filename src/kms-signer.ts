import { createPublicKey } from 'node:crypto';
import { GetPublicKeyCommand, SignCommand, type KMSClient } from '@aws-sdk/client-kms';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  CallData, constants, ETransactionVersion3, hash, stark, transaction,
  type Call, type DeclareSignerDetails, type DeployAccountSignerDetails,
  type InvocationsSignerDetails, type SignerInterface, type TypedData,
} from 'starknet';

export const MAINNET = constants.StarknetChainId.SN_MAIN;
export const FELT_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

export function assertMainnet(chainId: string): void {
  if (BigInt(chainId) !== BigInt(MAINNET)) throw new Error('Only Starknet mainnet (SN_MAIN) is supported.');
}

function transactionFields<T extends InvocationsSignerDetails | DeployAccountSignerDetails | DeclareSignerDetails>(details: T) {
  assertMainnet(details.chainId);
  if (![BigInt(ETransactionVersion3.V3), BigInt(ETransactionVersion3.F3)].includes(BigInt(details.version))) {
    throw new Error('Only V3 transactions and V3 fee queries are supported.');
  }
  return {
    version: details.version as ETransactionVersion3,
    nonceDataAvailabilityMode: stark.intDAM(details.nonceDataAvailabilityMode),
    feeDataAvailabilityMode: stark.intDAM(details.feeDataAvailabilityMode),
  };
}

export function uint256Limbs(value: bigint): string[] {
  if (value < 0n || value >= 1n << 256n) throw new Error('Value must fit in a uint256.');
  return [value & ((1n << 128n) - 1n), value >> 128n].map(n => `0x${n.toString(16)}`);
}

/** Constructor encoding for the OpenZeppelin 3.0.0 / 4.0.0 EthPublicKey (x, y). */
export function publicKeyCalldata(publicKey: string): string[] {
  if (!/^0x[0-9a-f]{128}$/i.test(publicKey)) throw new Error('Expected an uncompressed secp256k1 public key without the 04 prefix.');
  secp256k1.ProjectivePoint.fromHex(`04${publicKey.slice(2)}`).assertValidity();
  return [...uint256Limbs(BigInt(`0x${publicKey.slice(2, 66)}`)), ...uint256Limbs(BigInt(`0x${publicKey.slice(66)}`))];
}

/** No private key is accepted, generated, exported, or decrypted by this signer. */
export class KmsSigner implements SignerInterface {
  private identity?: Promise<{ arn: string; publicKey: string; bytes: Uint8Array }>;

  constructor(private readonly kms: Pick<KMSClient, 'send'>, private readonly keyId: string) {
    if (!keyId.trim()) throw new Error('KMS key ID or ARN is required.');
  }

  private getIdentity() {
    this.identity ??= this.loadIdentity().catch(error => {
      this.identity = undefined;
      throw error;
    });
    return this.identity;
  }

  private async loadIdentity() {
    const response = await this.kms.send(new GetPublicKeyCommand({ KeyId: this.keyId }));
    if (response.KeySpec !== 'ECC_SECG_P256K1' || response.KeyUsage !== 'SIGN_VERIFY' ||
        !response.SigningAlgorithms?.includes('ECDSA_SHA_256')) {
      throw new Error('KMS key must be ECC_SECG_P256K1 / SIGN_VERIFY with ECDSA_SHA_256.');
    }
    if (!response.PublicKey || !response.KeyId?.includes(':key/')) throw new Error('KMS returned an incomplete public key response.');
    const jwk = createPublicKey({ key: Buffer.from(response.PublicKey), format: 'der', type: 'spki' }).export({ format: 'jwk' });
    if (jwk.kty !== 'EC' || jwk.crv !== 'secp256k1' || !jwk.x || !jwk.y) throw new Error('Unexpected KMS public key encoding.');
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    if (x.length !== 32 || y.length !== 32) throw new Error('Invalid secp256k1 coordinates.');
    const bytes = Buffer.concat([Buffer.from([4]), x, y]);
    secp256k1.ProjectivePoint.fromHex(bytes).assertValidity();
    return { arn: response.KeyId, publicKey: `0x${bytes.subarray(1).toString('hex')}`, bytes };
  }

  async getPubKey(): Promise<string> { return (await this.getIdentity()).publicKey; }
  async getKeyArn(): Promise<string> { return (await this.getIdentity()).arn; }

  /** Sign a Starknet digest directly; deliberately no SHA-256 or Ethereum prefix. */
  async signHash(messageHash: string): Promise<string[]> {
    const value = BigInt(messageHash);
    if (value < 0n || value >= FELT_PRIME) throw new Error('Digest must be a Starknet felt.');
    const digest = Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
    const identity = await this.getIdentity();
    // Pin the resolved ARN: an alias moving later must not silently change the signer.
    const response = await this.kms.send(new SignCommand({
      KeyId: identity.arn, Message: digest, MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256',
    }));
    if (!response.Signature || response.KeyId !== identity.arn || response.SigningAlgorithm !== 'ECDSA_SHA_256') {
      throw new Error('Unexpected KMS signing response.');
    }
    const signature = secp256k1.Signature.fromDER(response.Signature).normalizeS();
    if (!secp256k1.verify(signature.toCompactRawBytes(), digest, identity.bytes, { prehash: false, lowS: true })) {
      throw new Error('KMS signature does not match the pinned public key and digest.');
    }
    // OZ 3.0.0 / 4.0.0 verifies the full public key; its Secp256Signature is two u256s, no recovery ID.
    return [...uint256Limbs(signature.r), ...uint256Limbs(signature.s)];
  }

  async signTransaction(calls: Call[], details: InvocationsSignerDetails): Promise<string[]> {
    if (details.cairoVersion !== '1') throw new Error('This signer requires a Cairo 1 account.');
    return this.signHash(hash.calculateInvokeTransactionHash({
      ...details, ...transactionFields(details), senderAddress: details.walletAddress,
      compiledCalldata: transaction.getExecuteCalldata(calls, '1'),
    }));
  }

  async signDeployAccountTransaction(details: DeployAccountSignerDetails): Promise<string[]> {
    return this.signHash(hash.calculateDeployAccountTransactionHash({
      ...details, ...transactionFields(details), salt: details.addressSalt,
      compiledConstructorCalldata: CallData.compile(details.constructorCalldata),
    }));
  }

  async signDeclareTransaction(details: DeclareSignerDetails): Promise<string[]> {
    return this.signHash(hash.calculateDeclareTransactionHash({ ...details, ...transactionFields(details) }));
  }

  async signMessage(_data: TypedData, _address: string): Promise<never> {
    throw new Error('Typed-message signing is outside this transaction-only example.');
  }
}
