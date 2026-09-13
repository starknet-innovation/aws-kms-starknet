import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { OZ_ETH_ACCOUNT_CLASS_HASH } from '../src/account-class.js';

type Input = Record<string, unknown>;
export type Aws = (service: string, operation: string, input: Input) => any;
export class AwsFailure extends Error {
  constructor(public code: string, service: string, operation: string) {
    super(`AWS ${service} ${operation} failed (${code}).`);
  }
}

export function awsCli(profile: string, region: string): Aws {
  return (service, operation, input) => {
    const env = { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_MAX_ATTEMPTS: '1' };
    // Always use the selected bootstrap profile, even in a credential-bearing shell.
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN']) delete env[name as keyof typeof env];
    const result = spawnSync('aws', ['--profile', profile, '--region', region, '--output', 'json',
      '--no-cli-pager', service, operation, '--cli-input-json', 'file:///dev/stdin'], {
      env, input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1024 * 1024,
    });
    // Never echo CLI stdout/stderr: create-access-key returns secret material.
    if (result.error || result.status !== 0) {
      const code = result.stderr?.match(/An error occurred \(([A-Za-z0-9_.-]+)\)/)?.[1] ?? 'CLI_ERROR';
      throw new AwsFailure(code, service, operation);
    }
    try { return result.stdout.trim() ? JSON.parse(result.stdout) : {}; }
    catch { throw new AwsFailure('INVALID_JSON', service, operation); }
  };
}

export function setupAws(options: { profile: string; region: string; name: string; apply: boolean },
  aws: Aws, home = homedir(), log: (message: string) => void = console.log) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.name)) throw new Error('Name must be 1–64 letters, digits, underscores or hyphens.');
  const directory = join(home, '.aws', 'starknet-aws-kms', options.name);
  if (existsSync(directory)) throw new Error(`Setup directory already exists: ${directory}. Use its saved files or choose a new name.`);
  const identity = aws('sts', 'get-caller-identity', {});
  if (!/^\d{12}$/.test(identity.Account) || typeof identity.Arn !== 'string') throw new Error('Invalid bootstrap identity.');
  try {
    aws('iam', 'get-user', { UserName: options.name });
    throw new Error('IAM user already exists. Choose a new name; existing users are never modified.');
  } catch (error) {
    if (!(error instanceof AwsFailure) || error.code !== 'NoSuchEntity') throw error;
  }
  log(`Account: ${identity.Account}\nBootstrap identity: ${identity.Arn}\nRegion: ${options.region}\nNew IAM user: ${options.name}\nPrivate output: ${directory}`);
  log('Creates one ECC_SECG_P256K1 signing key and one access key; user permissions: GetPublicKey and Sign on that KMS key. AWS charges apply.');
  if (!options.apply) { log('Preview only. Add --apply to create these resources.'); return; }

  mkdirSync(join(home, '.aws', 'starknet-aws-kms'), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const state: Input = { account: identity.Account, region: options.region, userName: options.name, status: 'starting' };
  const saveState = () => {
    writeFileSync(join(directory, 'resources.json.tmp'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(join(directory, 'resources.json.tmp'), join(directory, 'resources.json'));
  };
  saveState();
  try {
    const user = aws('iam', 'create-user', { UserName: options.name, Path: '/starknet-aws-kms/' });
    state.userArn = user.User.Arn;
    saveState();
    // The API default key policy retains account administration and enables IAM policies.
    const key = aws('kms', 'create-key', { KeySpec: 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY',
      Description: `Starknet signing for ${options.name}` });
    const keyArn = key.KeyMetadata.Arn;
    state.keyArn = keyArn;
    saveState();
    const policy = JSON.parse(readFileSync(new URL('./signing-policy.json', import.meta.url), 'utf8'));
    for (const statement of policy.Statement) statement.Resource = [keyArn];
    writeFileSync(join(directory, 'signing-policy.json'), JSON.stringify(policy, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    aws('iam', 'put-user-policy', { UserName: options.name, PolicyName: 'KmsSigningOnly', PolicyDocument: JSON.stringify(policy) });

    // Explicit UserName is mandatory: omitting it under root would create a root access key.
    const access = aws('iam', 'create-access-key', { UserName: options.name }).AccessKey;
    state.accessKeyId = access.AccessKeyId;
    try {
      writeFileSync(join(directory, 'credentials'), `[${options.name}]\naws_access_key_id = ${access.AccessKeyId}\naws_secret_access_key = ${access.SecretAccessKey}\n`, { mode: 0o600, flag: 'wx' });
    } catch {
      // Revoke a secret that could not be saved. Never remove the KMS key on failure.
      try {
        aws('iam', 'delete-access-key', { UserName: options.name, AccessKeyId: access.AccessKeyId });
        state.accessKeyRevoked = true;
      } catch { state.accessKeyRevoked = false; }
      throw new Error('Could not save credentials. See resources.json for access-key revocation status.');
    }
    writeFileSync(join(directory, 'config'), `[profile ${options.name}]\nregion = ${options.region}\n`, { mode: 0o600, flag: 'wx' });
    const env = [
      `AWS_PROFILE=${options.name}`, `AWS_SHARED_CREDENTIALS_FILE=${JSON.stringify(join(directory, 'credentials'))}`,
      `AWS_CONFIG_FILE=${JSON.stringify(join(directory, 'config'))}`,
      `AWS_REGION=${options.region}`, `AWS_KMS_KEY_ID=${keyArn}`,
      'STARKNET_RPC_URL=https://mainnet.nodes.starknet.org/rpc/v0_10',
      `STARKNET_ACCOUNT_CLASS_HASH=${OZ_ETH_ACCOUNT_CLASS_HASH}`, 'STARKNET_ACCOUNT_SALT=0x1', '',
    ].join('\n');
    writeFileSync(join(directory, '.env'), env, { mode: 0o600, flag: 'wx' });
    state.status = 'complete';
    saveState();
    log(`Created successfully. Credentials were saved privately, not printed.\nCopy ${join(directory, '.env')} to your project's .env, then run npm run cli -- kms-check.`);
  } catch (error) {
    state.status = 'incomplete';
    saveState();
    log(`Setup incomplete. Resource records are in ${directory}. Resources are retained for recovery; do not blindly rerun.`);
    throw error;
  }
}

function main() {
  const { values } = parseArgs({ options: {
    'admin-profile': { type: 'string' }, region: { type: 'string' }, name: { type: 'string', default: 'starknet-kms' },
    apply: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: npm run aws:setup -- --admin-profile ROOT_OR_ADMIN --region eu-west-1 [--name starknet-kms] [--apply]\nRequires AWS CLI v2 on macOS or Linux. Default: read-only preview.');
    return;
  }
  if (process.platform === 'win32') throw new Error('Run this helper in WSL, Linux or macOS.');
  if (!values['admin-profile'] || !values.region) throw new Error('--admin-profile and --region are required.');
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(values.region)) throw new Error('Invalid AWS region.');
  setupAws({ profile: values['admin-profile'], region: values.region, name: values.name!, apply: values.apply! }, awsCli(values['admin-profile'], values.region));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : 'AWS setup failed.');
    process.exitCode = 1;
  }
}
