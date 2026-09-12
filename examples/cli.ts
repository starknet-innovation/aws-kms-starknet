import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { KMSClient } from '@aws-sdk/client-kms';
import { RpcProvider, hash, json } from 'starknet';
import {
  KmsSigner, MAINNET, assertMainnet, assertSuccessfulReceipt, connectAccount,
  deployment, enforceFeeCap, felt, invokeCall, maximumFee, parseUnits,
  transferCall, verifyDeployedAccount, DEFAULT_ACCOUNT_ARTIFACT, OZ_ETH_ACCOUNT_CLASS_HASH, isClassDeclared,
} from '../src/index.js';

const help = `Starknet mainnet / AWS KMS examples

npm run cli -- class-hash
npm run cli -- inspect
npm run cli -- kms-check
npm run cli -- deploy [--broadcast --max-fee-strk 0.1]
npm run cli -- transfer --token 0x... --to 0x... --amount-base-units 1 [--broadcast --max-fee-strk 0.1]
npm run cli -- invoke --contract 0x... --entrypoint name --calldata '["1","2"]' [--broadcast --max-fee-strk 0.1]
npm run cli -- call --contract 0x... --entrypoint name --calldata '[]'

Deploy, transfer, and invoke estimate fees by default. --broadcast submits to mainnet.
Configuration: .env.example. Amounts use integer base units; fee caps use decimal STRK.`;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in your environment or .env.`);
  return value;
}
function print(value: unknown) {
  console.log(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, broadcast: { type: 'boolean', default: false },
    'max-fee-strk': { type: 'string' }, token: { type: 'string' }, to: { type: 'string' },
    'amount-base-units': { type: 'string' }, contract: { type: 'string' },
    entrypoint: { type: 'string' }, calldata: { type: 'string', default: '[]' },
  } });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const command = positionals[0]!;
  if (positionals.length !== 1 || !['class-hash', 'inspect', 'kms-check', 'deploy', 'transfer', 'invoke', 'call'].includes(command)) throw new Error(help);
  const option = (name: 'token' | 'to' | 'amount-base-units' | 'contract' | 'entrypoint') => {
    const value = values[name];
    if (!value) throw new Error(`--${name} is required.`);
    return value;
  };
  const rawCalldata: unknown = JSON.parse(values.calldata!);
  if (!Array.isArray(rawCalldata) || rawCalldata.some(v => typeof v !== 'string')) throw new Error('--calldata must be a JSON array of integer strings.');
  const call = command === 'transfer' ? transferCall(option('token'), option('to'), option('amount-base-units'))
    : command === 'invoke' || command === 'call' ? invokeCall(option('contract'), option('entrypoint'), rawCalldata) : undefined;
  if (values.broadcast && !values['max-fee-strk']) throw new Error('--max-fee-strk is required with --broadcast.');
  const feeCap = values.broadcast ? parseUnits(values['max-fee-strk'] ?? '', 18) : undefined;
  if (values.broadcast && !['deploy', 'transfer', 'invoke'].includes(command)) throw new Error('--broadcast is only valid for deploy, transfer, or invoke.');

  if (command === 'class-hash') {
    const artifact = json.parse(await readFile(process.env.STARKNET_ACCOUNT_ARTIFACT || DEFAULT_ACCOUNT_ARTIFACT, 'utf8'));
    print({ classHash: hash.computeContractClassHash(artifact) });
    return;
  }

  if (command === 'call') {
    const provider = new RpcProvider({ nodeUrl: required('STARKNET_RPC_URL') });
    assertMainnet(await provider.getChainId());
    print(await provider.callContract(call!));
    return;
  }
  const kms = new KMSClient({ region: required('AWS_REGION'), maxAttempts: 3,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 } });
  try {
    const signer = new KmsSigner(kms, required('AWS_KMS_KEY_ID'));
    if (command === 'kms-check') {
      // Domain-separated diagnostic challenge, never a transaction or a broadcast.
      const digest = hash.computeHashOnElements([MAINNET, '0x4b4d535f434845434b', BigInt(Date.now())]);
      await signer.signHash(digest);
      print({ kmsSigningVerified: true, keyArn: await signer.getKeyArn(), publicKey: await signer.getPubKey() });
      return;
    }
    const provider = new RpcProvider({ nodeUrl: required('STARKNET_RPC_URL') });
    assertMainnet(await provider.getChainId());
    const classHash = felt(process.env.STARKNET_ACCOUNT_CLASS_HASH?.trim() || OZ_ETH_ACCOUNT_CLASS_HASH, 'Class hash');
    const artifactPath = process.env.STARKNET_ACCOUNT_ARTIFACT || DEFAULT_ACCOUNT_ARTIFACT;
    const artifact = json.parse(await readFile(artifactPath, 'utf8'));
    if (BigInt(hash.computeContractClassHash(artifact)) !== BigInt(classHash)) throw new Error('Configured class hash does not match the compiled account artifact.');
    const classDeclared = await isClassDeclared(provider, classHash);
    const payload = deployment(classHash, required('STARKNET_ACCOUNT_SALT'), await signer.getPubKey());
    const accountAddress = process.env.STARKNET_ACCOUNT_ADDRESS?.trim() || payload.contractAddress;
    const account = await connectAccount(provider, signer, accountAddress);
    if (command === 'inspect') {
      print({ network: 'SN_MAIN', classDeclared, keyArn: await signer.getKeyArn(), publicKey: await signer.getPubKey(),
        accountAddress, counterfactualAddress: payload.contractAddress, deployment: payload });
      return;
    }
    if (!classDeclared) throw new Error('Account class is not declared on mainnet. Declare the selected artifact using an existing funded account before funding or deploying this account.');
    const details = { tip: 0n, skipValidate: false };
    if (command === 'deploy' && BigInt(account.address) !== BigInt(payload.contractAddress)) throw new Error('Configured account address does not match the deployment parameters.');
    if (command !== 'deploy') await verifyDeployedAccount(provider, signer, account.address, classHash);
    const nonce = command === 'deploy' ? 0n : await account.getNonce();
    const estimate = command === 'deploy' ? await account.estimateAccountDeployFee(payload, { ...details, nonce })
      : await account.estimateInvokeFee(call!, { ...details, nonce });
    const resourceBounds = estimate.resourceBounds;
    print({ network: 'SN_MAIN', operation: command, account: account.address, nonce,
      payload: command === 'deploy' ? payload : call, resourceBounds, tip: 0,
      maximumFeeFri: maximumFee(resourceBounds), broadcast: values.broadcast });
    if (!values.broadcast) return;
    enforceFeeCap(resourceBounds, feeCap!);
    const result = command === 'deploy' ? await account.deployAccount(payload, { ...details, nonce, resourceBounds })
      : await account.execute(call!, { ...details, nonce, resourceBounds });
    print({ transactionHash: result.transaction_hash });
    // Print the hash before waiting, so a timeout never loses the submission identifier.
    const receipt = await assertSuccessfulReceipt(provider, result.transaction_hash);
    print({ transactionHash: result.transaction_hash, executionStatus: receipt.execution_status, finalityStatus: receipt.finality_status });
  } finally {
    kms.destroy();
  }
}

main().catch(error => {
  // Provider URLs can contain credentials: don't print raw transport errors or stacks.
  const message = error instanceof Error ? error.message : 'Operation failed.';
  const rpc = process.env.STARKNET_RPC_URL;
  const safe = rpc ? message.split(rpc).join('[RPC URL]') : message;
  console.error(safe.replace(/https?:\/\/[^\s"']+/g, '[URL]'));
  process.exitCode = 1;
});
