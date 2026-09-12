import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CallData, EthSigner, RpcError, hash, json } from 'starknet';
import { DEFAULT_ACCOUNT_ARTIFACT, OZ_ETH_ACCOUNT_CLASS_HASH, isClassDeclared } from '../src/account-class.js';
import { publicKeyCalldata } from '../src/kms-signer.js';

test('release build reproduces the published OZ 4.0.0 EthAccountUpgradeable class', async () => {
  const artifact = json.parse(await readFile(DEFAULT_ACCOUNT_ARTIFACT, 'utf8'));
  assert.equal(BigInt(hash.computeContractClassHash(artifact)), BigInt(OZ_ETH_ACCOUNT_CLASS_HASH));
  const pubkey = await new EthSigner('0x1').getPubKey();
  const encoded = new CallData(artifact.abi).compile('constructor', { public_key: pubkey });
  assert.deepEqual(encoded.map(BigInt), publicKeyCalldata(pubkey).map(BigInt));
  assert.equal(await isClassDeclared({ getClassByHash: async () => artifact }, OZ_ETH_ACCOUNT_CLASS_HASH), true);
});

test('class-not-found is distinct from RPC and authorization failures', async () => {
  const notFound = { getClassByHash: async () => { throw new RpcError({ code: 28, message: 'Class hash not found' }, 'starknet_getClass', {}); } };
  assert.equal(await isClassDeclared(notFound, OZ_ETH_ACCOUNT_CLASS_HASH), false);
  const unavailable = { getClassByHash: async () => { throw new Error('RPC unavailable'); } };
  await assert.rejects(isClassDeclared(unavailable, OZ_ETH_ACCOUNT_CLASS_HASH), /RPC unavailable/);
});
