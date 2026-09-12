/** Opt-in integration check: real AWS KMS signing, local Cairo verification, no RPC. */
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { KMSClient, type SignCommandInput } from '@aws-sdk/client-kms';
import { ETransactionVersion3, EDataAvailabilityMode, hash, json, transaction, type InvocationsSignerDetails } from 'starknet';
import { KmsSigner, MAINNET, publicKeyCalldata, deployment, transferCall, invokeCall, DEFAULT_ACCOUNT_ARTIFACT, OZ_ETH_ACCOUNT_CLASS_HASH } from '../src/index.js';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before running test:kms.`);
  return value;
}

async function main() {
  const kms = new KMSClient({ region: required('AWS_REGION'), maxAttempts: 3,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 } });
  const signer = new KmsSigner(kms, required('AWS_KMS_KEY_ID'));
  const fixturePath = 'contracts/preset/tests/test_live_kms.cairo';
  let fixtureCreated = false;
  // Capture only the public transaction digest, never credentials or private key material.
  const digests: string[] = [];
  kms.middlewareStack.add((next, context) => async args => {
    const input = args.input as SignCommandInput;
    if (context.commandName === 'SignCommand' && input.Message) {
      digests.push(`0x${Buffer.from(input.Message).toString('hex')}`);
    }
    return next(args);
  }, { step: 'initialize', name: 'captureTestDigest' });
  try {
    const artifact = json.parse(await readFile(DEFAULT_ACCOUNT_ARTIFACT, 'utf8'));
    if (BigInt(hash.computeContractClassHash(artifact)) !== BigInt(OZ_ETH_ACCOUNT_CLASS_HASH)) throw new Error('Preset class hash mismatch.');
    const publicKey = await signer.getPubKey();
    const constructor = publicKeyCalldata(publicKey);
    const deploy = deployment(hash.computeContractClassHash(artifact), '0x1', publicKey);
    // Query-version signatures cannot be used to broadcast these example transactions.
    const details: InvocationsSignerDetails = {
      chainId: MAINNET, version: ETransactionVersion3.F3, cairoVersion: '1', walletAddress: deploy.contractAddress,
      nonce: 0, tip: 0, paymasterData: [], accountDeploymentData: [],
      resourceBounds: { l1_gas: { max_amount: 0n, max_price_per_unit: 0n },
        l2_gas: { max_amount: 0n, max_price_per_unit: 0n }, l1_data_gas: { max_amount: 0n, max_price_per_unit: 0n } },
      nonceDataAvailabilityMode: EDataAvailabilityMode.L1, feeDataAvailabilityMode: EDataAvailabilityMode.L1,
    };
    const transfer = transferCall('0x123', '0x456', '1');
    const invoke = invokeCall('0x789', 'increase_balance', ['1']);
    const cases = [
      { name: 'deploy', signature: await signer.signDeployAccountTransaction({ ...details, ...deploy }),
        entrypoint: '__validate_deploy__', calldata: [deploy.classHash, deploy.addressSalt, ...constructor] },
      { name: 'transfer', signature: await signer.signTransaction([transfer], details),
        entrypoint: '__validate__', calldata: transaction.getExecuteCalldata([transfer], '1') },
      { name: 'invoke', signature: await signer.signTransaction([invoke], details),
        entrypoint: '__validate__', calldata: transaction.getExecuteCalldata([invoke], '1') },
    ];
    if (digests.length !== cases.length) throw new Error('Unexpected number of KMS requests.');
    const cairo = `// Ephemeral real-KMS signature fixtures. Removed when the test completes.
use snforge_std::{declare, ContractClassTrait, DeclareResultTrait, start_cheat_signature, start_cheat_transaction_hash};
use starknet::{ContractAddress, SyscallResultTrait};
fn deploy() -> ContractAddress {
    let class = declare("EthAccountUpgradeable").unwrap().contract_class();
    let (account, _) = class.deploy(@array![${constructor.join(', ')}]).unwrap();
    account
}
` + cases.map((testCase, i) => `
#[test]
fn ${testCase.name}_signature_from_real_kms() {
    let account = deploy();
    let signature = array![${testCase.signature.join(', ')}];
    start_cheat_signature(account, signature.span());
    start_cheat_transaction_hash(account, ${digests[i]});
    let result = starknet::syscalls::call_contract_syscall(
        account, selector!("${testCase.entrypoint}"), array![${testCase.calldata.join(', ')}].span(),
    ).unwrap_syscall();
    assert!(*result.at(0) == starknet::VALIDATED);
    // The same real signature must fail if the digest changes.
    let mut bad_calldata = array![${BigInt(digests[i]!) + 1n}];
    signature.serialize(ref bad_calldata);
    let invalid = starknet::syscalls::call_contract_syscall(
        account, selector!("is_valid_signature"), bad_calldata.span(),
    ).unwrap_syscall();
    assert!(*invalid.at(0) == 0);
}
`).join('\n');
    // Refuse to overwrite a concurrent or interrupted run's fixture.
    await writeFile(fixturePath, cairo, { flag: 'wx', mode: 0o600 });
    fixtureCreated = true;
    const result = spawnSync('snforge', ['test', '--release', 'test_live_kms::'], { cwd: 'contracts/preset', stdio: 'inherit', timeout: 180000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Cairo verification of real KMS signatures failed.');
    console.log(JSON.stringify({ kmsSigningVerified: true, cairoVerification: 'passed',
      classHash: OZ_ETH_ACCOUNT_CLASS_HASH, operations: cases.map(c => c.name), signatureVersion: 'V3 query', broadcast: false }, null, 2));
  } finally {
    kms.destroy();
    if (fixtureCreated) await unlink(fixturePath);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Live KMS check failed.');
  process.exitCode = 1;
});
