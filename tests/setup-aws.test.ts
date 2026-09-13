import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwsFailure, setupAws, type Aws } from '../scripts/setup-aws.js';

const keyArn = 'arn:aws:kms:eu-west-1:111122223333:key/test-key';
const options = { profile: 'bootstrap', region: 'eu-west-1', name: 'test-signer', apply: true };
function fixture(t: { after: (fn: () => void) => void }, fail = '') {
  const home = mkdtempSync(join(tmpdir(), 'kms-setup-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const calls: { service: string; operation: string; input: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const aws: Aws = (service, operation, input) => {
    calls.push({ service, operation, input });
    if (operation === fail) throw new AwsFailure('AccessDenied', service, operation);
    if (operation === 'get-caller-identity') return { Account: '111122223333', Arn: 'arn:aws:iam::111122223333:root' };
    if (operation === 'get-user') throw new AwsFailure('NoSuchEntity', service, operation);
    if (operation === 'create-user') return { User: { Arn: 'arn:aws:iam::111122223333:user/starknet-aws-kms/test-signer' } };
    if (operation === 'create-key') return { KeyMetadata: { Arn: keyArn } };
    if (operation === 'create-access-key') return { AccessKey: { AccessKeyId: 'TEST_ACCESS_ID', SecretAccessKey: 'public-test-secret' } };
    return {};
  };
  return { home, directory: join(home, '.aws/starknet-aws-kms/test-signer'), calls, logs, aws, log: (s: string) => logs.push(s) };
}

test('AWS setup preview makes no mutations or credential files', t => {
  const f = fixture(t);
  setupAws({ ...options, apply: false }, f.aws, f.home, f.log);
  assert.deepEqual(f.calls.map(c => c.operation), ['get-caller-identity', 'get-user']);
  assert.equal(existsSync(f.directory), false);
});

test('AWS setup scopes signing, explicitly targets the new user, and stores secrets privately', t => {
  const f = fixture(t);
  setupAws(options, f.aws, f.home, f.log);
  const policy = JSON.parse(f.calls.find(c => c.operation === 'put-user-policy')!.input.PolicyDocument as string);
  assert.deepEqual(policy.Statement, [{ Effect: 'Allow', Action: ['kms:GetPublicKey', 'kms:Sign'], Resource: [keyArn] }]);
  assert.deepEqual(f.calls.find(c => c.operation === 'create-access-key')!.input, { UserName: options.name });
  assert.match(readFileSync(join(f.directory, 'credentials'), 'utf8'), /public-test-secret/);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  for (const file of ['credentials', 'config', '.env', 'resources.json', 'signing-policy.json']) assert.equal(statSync(join(f.directory, file)).mode & 0o777, 0o600);
  assert(!f.logs.join('\n').includes('public-test-secret'));
  assert(!readFileSync(join(f.directory, 'resources.json'), 'utf8').includes('public-test-secret'));
  const env = readFileSync(join(f.directory, '.env'), 'utf8');
  assert.match(env, /AWS_PROFILE=test-signer/);
  assert.match(env, /AWS_CONFIG_FILE=/);
  assert(env.includes(keyArn));
  assert(!env.includes('public-test-secret'));
  const callCount = f.calls.length;
  assert.throws(() => setupAws(options, f.aws, f.home, f.log), /already exists/);
  assert.equal(f.calls.length, callCount);
});

test('AWS setup stops on a denied existence check and does not treat it as a missing user', t => {
  const f = fixture(t, 'get-user');
  assert.throws(() => setupAws(options, f.aws, f.home, f.log), /AccessDenied/);
  assert.equal(existsSync(f.directory), false);
  assert.deepEqual(f.calls.map(c => c.operation), ['get-caller-identity', 'get-user']);
});

test('AWS setup refuses an existing user before creating resources', t => {
  const f = fixture(t);
  const aws: Aws = (s, op, input) => op === 'get-user' ? {} : f.aws(s, op, input);
  assert.throws(() => setupAws(options, aws, f.home, f.log), /user already exists/);
  assert.equal(existsSync(f.directory), false);
});

test('AWS setup records partial resources without issuing credentials when policy attachment fails', t => {
  const f = fixture(t, 'put-user-policy');
  assert.throws(() => setupAws(options, f.aws, f.home, f.log), /AccessDenied/);
  assert.equal(f.calls.some(c => c.operation === 'create-access-key'), false);
  const state = JSON.parse(readFileSync(join(f.directory, 'resources.json'), 'utf8'));
  assert.equal(state.keyArn, keyArn);
  assert.equal(state.status, 'incomplete');
});

test('AWS setup revokes an access key if saving its secret fails', t => {
  const f = fixture(t);
  const aws: Aws = (s, op, input) => {
    if (op === 'create-access-key') mkdirSync(join(f.directory, 'credentials'));
    return f.aws(s, op, input);
  };
  assert.throws(() => setupAws(options, aws, f.home, f.log), /Could not save credentials/);
  assert.deepEqual(f.calls.find(c => c.operation === 'delete-access-key')!.input, { UserName: options.name, AccessKeyId: 'TEST_ACCESS_ID' });
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'resources.json'), 'utf8')).accessKeyRevoked, true);
  assert(!f.logs.join('\n').includes('public-test-secret'));
});
