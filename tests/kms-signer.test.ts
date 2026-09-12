import assert from 'node:assert/strict';
import { createPublicKey, createHash } from 'node:crypto';
import { test } from 'node:test';
import { GetPublicKeyCommand, SignCommand, type KMSClient } from '@aws-sdk/client-kms';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ETransactionVersion3, EthSigner, EDataAvailabilityMode, type InvocationsSignerDetails } from 'starknet';
import { KmsSigner, MAINNET, FELT_PRIME, publicKeyCalldata } from '../src/kms-signer.js';

// Public test fixture only. Application code never has a private key.
const privateKey = '1'.padStart(64, '0');
const publicKey = secp256k1.getPublicKey(privateKey, false);
const arn = 'arn:aws:kms:eu-west-1:111122223333:key/test-key';
const spki = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'secp256k1',
  x: Buffer.from(publicKey.slice(1, 33)).toString('base64url'), y: Buffer.from(publicKey.slice(33)).toString('base64url'),
} }).export({ format: 'der', type: 'spki' });

function fixture(mode: 'normal' | 'high-s' | 'wrong-key' | 'double-hash' | 'bad-der' | 'bad-spec' | 'bad-arn' = 'normal') {
  const commands: (GetPublicKeyCommand | SignCommand)[] = [];
  const send = async (command: GetPublicKeyCommand | SignCommand) => {
    commands.push(command);
    if (command instanceof GetPublicKeyCommand) return {
      KeyId: arn, KeySpec: mode === 'bad-spec' ? 'ECC_NIST_P256' : 'ECC_SECG_P256K1',
      KeyUsage: 'SIGN_VERIFY', SigningAlgorithms: ['ECDSA_SHA_256'], PublicKey: spki,
    };
    const digest = mode === 'double-hash' ? createHash('sha256').update(command.input.Message!).digest() : command.input.Message!;
    const sig = secp256k1.sign(digest, mode === 'wrong-key' ? '2'.padStart(64, '0') : privateKey);
    const der = mode === 'high-s' ? new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s).toDERRawBytes() : sig.toDERRawBytes();
    return { KeyId: mode === 'bad-arn' ? `${arn}-other` : arn, SigningAlgorithm: 'ECDSA_SHA_256',
      Signature: mode === 'bad-der' ? new Uint8Array([1, 2]) : der };
  };
  return { signer: new KmsSigner({ send } as unknown as Pick<KMSClient, 'send'>, 'alias/starknet'), commands };
}

const details: InvocationsSignerDetails = {
  chainId: MAINNET, version: ETransactionVersion3.V3, cairoVersion: '1', walletAddress: '0x123', nonce: 7,
  resourceBounds: { l1_gas: { max_amount: 12n, max_price_per_unit: 34n },
    l2_gas: { max_amount: 56n, max_price_per_unit: 78n }, l1_data_gas: { max_amount: 90n, max_price_per_unit: 12n } },
  tip: 0, paymasterData: [], accountDeploymentData: [],
  nonceDataAvailabilityMode: EDataAvailabilityMode.L1, feeDataAvailabilityMode: EDataAvailabilityMode.L1,
};
const calls = [{ contractAddress: '0x456', entrypoint: 'transfer', calldata: ['0x789', '100', '0'] }];
const softwareSigner = new EthSigner(`0x${privateKey}`);

// Compare the four r/s limbs to the independent built-in Starknet.js signer.
for (const version of [ETransactionVersion3.V3, ETransactionVersion3.F3]) {
  test(`KMS invoke matches EthSigner for ${version}`, async () => {
    const { signer } = fixture();
    const actual = await signer.signTransaction(calls, { ...details, version });
    const expected = await softwareSigner.signTransaction(calls, { ...details, version });
    assert.deepEqual(actual, (expected as string[]).slice(0, 4));
  });
  test(`KMS account deployment matches EthSigner for ${version}`, async () => {
    const { signer } = fixture();
    const deploy = { ...details, version, classHash: '0x123', addressSalt: '0x42', contractAddress: '0x456',
      constructorCalldata: publicKeyCalldata(await signer.getPubKey()) };
    assert.deepEqual(await signer.signDeployAccountTransaction(deploy),
      (await softwareSigner.signDeployAccountTransaction(deploy) as string[]).slice(0, 4));
  });
  test(`KMS declare matches EthSigner for ${version}`, async () => {
    const { signer } = fixture();
    const declare = { ...details, version, senderAddress: '0x123', classHash: '0x456', compiledClassHash: '0x789' };
    assert.deepEqual(await signer.signDeclareTransaction(declare),
      (await softwareSigner.signDeclareTransaction(declare) as string[]).slice(0, 4));
  });
}

test('uses a 32-byte, zero-padded digest and pins the alias to its ARN', async () => {
  const { signer, commands } = fixture();
  await Promise.all([signer.getPubKey(), signer.getPubKey()]);
  await signer.signHash('0x1');
  await signer.signHash('0x2');
  assert.equal(commands.filter(c => c instanceof GetPublicKeyCommand).length, 1);
  const command = commands[1] as SignCommand;
  assert.equal(command.input.KeyId, arn);
  assert.equal(command.input.MessageType, 'DIGEST');
  assert.equal(command.input.SigningAlgorithm, 'ECDSA_SHA_256');
  assert.equal(Buffer.from(command.input.Message!).toString('hex'), '1'.padStart(64, '0'));
});

test('normalizes high-S signatures', async () => {
  assert.deepEqual(await fixture('normal').signer.signHash('0x123'), await fixture('high-s').signer.signHash('0x123'));
});
for (const mode of ['wrong-key', 'double-hash', 'bad-der', 'bad-spec', 'bad-arn'] as const) {
  test(`rejects ${mode} responses`, async () => { await assert.rejects(fixture(mode).signer.signHash('0x123')); });
}

test('rejects other networks and unsupported versions before contacting KMS', async () => {
  const { signer, commands } = fixture();
  await assert.rejects(signer.signTransaction(calls, { ...details, chainId: '0x123' as InvocationsSignerDetails['chainId'] }), /mainnet/);
  await assert.rejects(signer.signTransaction(calls, { ...details, version: '0x1' as InvocationsSignerDetails['version'] }), /V3/);
  await assert.rejects(signer.signTransaction(calls, { ...details, cairoVersion: '0' }), /Cairo 1/);
  assert.equal(commands.length, 0);
});

test('rejects out-of-range digests and invalid public points', async () => {
  const { signer, commands } = fixture();
  await assert.rejects(signer.signHash('-1'));
  await assert.rejects(signer.signHash(FELT_PRIME.toString()));
  assert.throws(() => publicKeyCalldata(`0x${'0'.repeat(128)}`));
  assert.equal(commands.length, 0);
});

test('KMS result matches the shared Cairo signature fixture', async () => {
  const { readFile } = await import('node:fs/promises');
  const vector = JSON.parse(await readFile('tests/fixtures/signature.json', 'utf8'));
  const { signer } = fixture();
  assert.equal(await signer.getPubKey(), vector.publicKey);
  assert.deepEqual(await signer.signHash(vector.digest), vector.signature);
  const cairoTest = await readFile('contracts/tests/test_account.cairo', 'utf8');
  for (const limb of vector.signature) assert.ok(cairoTest.includes(limb));
});
