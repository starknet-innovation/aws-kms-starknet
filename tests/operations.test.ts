import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { CallData, EthSigner, type Abi } from 'starknet';
import { address, deployment, enforceFeeCap, felt, invokeCall, maximumFee, parseUnits, transferCall } from '../src/operations.js';
import { publicKeyCalldata } from '../src/kms-signer.js';

test('transfers encode large uint256 base-unit amounts exactly', () => {
  const amount = (1n << 128n) + 42n;
  assert.deepEqual(transferCall('0x1', '0x2', amount.toString()).calldata, ['0x2', '0x2a', '0x1']);
  for (const value of ['0', '-1', '1.5', '1e18', (1n << 256n).toString()]) assert.throws(() => transferCall('0x1', '0x2', value));
});

test('decimal fee caps do not round or accept ambiguous input', () => {
  assert.equal(parseUnits('0.000000000000000001', 18), 1n);
  assert.equal(parseUnits('12.34', 18), 12340000000000000000n);
  for (const value of ['0', '-1', '1e3', '0.0000000000000000001', '', 'Infinity']) assert.throws(() => parseUnits(value, 18));
});

test('fee cap includes all three resource bounds', () => {
  const bounds = { l1_gas: { max_amount: 2n, max_price_per_unit: 3n },
    l2_gas: { max_amount: 4n, max_price_per_unit: 5n }, l1_data_gas: { max_amount: 6n, max_price_per_unit: 7n } };
  assert.equal(maximumFee(bounds), 68n);
  assert.doesNotThrow(() => enforceFeeCap(bounds, 68n));
  assert.throws(() => enforceFeeCap(bounds, 67n));
});

test('addresses and calldata reject invalid ranges', () => {
  assert.equal(felt('0'), '0x0');
  assert.throws(() => address('0'));
  assert.throws(() => address((1n << 251n).toString()));
  assert.throws(() => invokeCall('0x1', 'transfer', ['-1']));
  assert.throws(() => invokeCall('0x1', 'bad name', []));
});

test('public key encoding matches the compiled Cairo constructor ABI', async () => {
  const { abi } = JSON.parse(await readFile('contracts/target/dev/starknet_aws_kms_KmsAccount.contract_class.json', 'utf8')) as { abi: Abi };
  const pubkey = await new EthSigner('0x1').getPubKey();
  const expected = new CallData(abi).compile('constructor', { public_key: pubkey });
  assert.deepEqual(publicKeyCalldata(pubkey).map(BigInt), expected.map(BigInt));
  assert.notEqual(deployment('0x1', '0x1', pubkey).contractAddress, deployment('0x1', '0x2', pubkey).contractAddress);
});
