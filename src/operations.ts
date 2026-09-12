import {
  Account, ETransactionVersion3, RpcProvider, hash,
  type Call, type ResourceBoundsBN,
} from 'starknet';
import { KmsSigner, FELT_PRIME, assertMainnet, publicKeyCalldata, uint256Limbs } from './kms-signer.js';

export function felt(value: string, name = 'Value'): string {
  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) throw new Error(`${name} must be a hex or decimal integer.`);
  const n = BigInt(value);
  if (n >= FELT_PRIME) throw new Error(`${name} exceeds the Starknet field.`);
  return `0x${n.toString(16)}`;
}

export function address(value: string, name = 'Address'): string {
  const n = BigInt(felt(value, name));
  if (n === 0n || n >= (1n << 251n) - 256n) throw new Error(`${name} must be a nonzero Starknet address.`);
  return `0x${n.toString(16)}`;
}

/** Decimal string to base units, with no floating point rounding. */
export function parseUnits(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Invalid decimals.');
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('Amount must be a positive decimal string.');
  const [whole = '', fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error('Amount has too many decimal places.');
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (units <= 0n || units >= 1n << 256n) throw new Error('Amount must be positive and fit in uint256.');
  return units;
}

export function transferCall(token: string, recipient: string, amountBaseUnits: string): Call {
  if (!/^\d+$/.test(amountBaseUnits) || BigInt(amountBaseUnits) <= 0n) throw new Error('Transfer amount must be a positive integer in token base units.');
  return { contractAddress: address(token, 'Token'), entrypoint: 'transfer',
    calldata: [address(recipient, 'Recipient'), ...uint256Limbs(BigInt(amountBaseUnits))] };
}

export function invokeCall(contractAddress: string, entrypoint: string, calldata: string[]): Call {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entrypoint)) throw new Error('Invalid entrypoint name.');
  return { contractAddress: address(contractAddress), entrypoint, calldata: calldata.map(v => felt(v, 'Calldata')) };
}

/** Maximum V3 fee in fri for the explicit zero-tip transactions used here. */
export function maximumFee(bounds: ResourceBoundsBN): bigint {
  return [bounds.l1_gas, bounds.l2_gas, bounds.l1_data_gas].reduce((sum, resource) => {
    const amount = BigInt(resource.max_amount);
    const price = BigInt(resource.max_price_per_unit);
    if (amount < 0n || price < 0n) throw new Error('Invalid resource bounds.');
    return sum + amount * price;
  }, 0n);
}

export function enforceFeeCap(bounds: ResourceBoundsBN, cap: bigint): void {
  if (cap <= 0n || maximumFee(bounds) > cap) throw new Error('Estimated resource bounds exceed the maximum STRK fee.');
}

export function deployment(classHash: string, salt: string, publicKey: string) {
  const constructorCalldata = publicKeyCalldata(publicKey);
  const payload = { classHash: felt(classHash, 'Class hash'), addressSalt: felt(salt, 'Salt'), constructorCalldata };
  return { ...payload, contractAddress: hash.calculateContractAddressFromHash(payload.addressSalt, payload.classHash, constructorCalldata, 0) };
}

export async function connectAccount(provider: RpcProvider, signer: KmsSigner, accountAddress: string) {
  assertMainnet(await provider.getChainId());
  return new Account({ provider, address: address(accountAddress), signer, cairoVersion: '1', transactionVersion: ETransactionVersion3.V3 });
}

/** Catch wrong account/class/key configuration before asking KMS to sign. */
export async function verifyDeployedAccount(provider: RpcProvider, signer: KmsSigner, accountAddress: string, classHash: string) {
  const actualClass = await provider.getClassHashAt(accountAddress);
  if (BigInt(actualClass) !== BigInt(classHash)) throw new Error('Deployed account class differs from the configured KmsAccount class.');
  const onchain = await provider.callContract({ contractAddress: accountAddress, entrypoint: 'get_public_key', calldata: [] });
  const expected = publicKeyCalldata(await signer.getPubKey());
  if (onchain.length !== expected.length || onchain.some((v, i) => BigInt(v) !== BigInt(expected[i]!))) {
    throw new Error('KMS public key does not match the account owner.');
  }
}

export async function assertSuccessfulReceipt(provider: RpcProvider, transactionHash: string) {
  const receipt = await provider.waitForTransaction(transactionHash, { retryInterval: 3000, retries: 100 });
  if (!('execution_status' in receipt) || receipt.execution_status !== 'SUCCEEDED') throw new Error(`Transaction did not succeed: ${transactionHash}`);
  return receipt;
}
