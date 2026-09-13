# AWS setup from a root or administrator profile

Run `npm ci` first. The helper uses Node.js and AWS CLI v2, with no extra SDK packages. It works on macOS, Linux and WSL. It uses an existing authenticated profile; it does not create or request root access keys. An administrator profile with permission to create IAM users, attach inline policies, manage their access keys, and create KMS keys also works.

```sh
npm run aws:setup -- --admin-profile YOUR_ROOT_PROFILE --region eu-west-1 --name starknet-kms
npm run aws:setup -- --admin-profile YOUR_ROOT_PROFILE --region eu-west-1 --name starknet-kms --apply
```

The first command reads the caller identity and checks that the user name is unused. The second creates:

1. An IAM user under `/starknet-aws-kms/`, without a console login.
2. An AWS-generated `ECC_SECG_P256K1` KMS key with `SIGN_VERIFY` usage.
3. An inline `KmsSigningOnly` policy granting `kms:GetPublicKey` and `kms:Sign` on that exact key ARN.
4. One access key explicitly belonging to the new IAM user.

The KMS API's [default key policy](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html) retains account administration and enables IAM policies. The new user receives no key-management permissions. Root is used only for bootstrap; application commands use the new user's profile. For deployed applications, your existing IAM role and temporary credentials remain supported.

The signing policy was generated with AWS IAM Policy Autopilot and narrowed to the new key at setup time. To regenerate its baseline after changing the signer:

```sh
uvx iam-policy-autopilot@latest generate-policies src/kms-signer.ts --service-hints kms --pretty
```

## Generated files

The new directory `~/.aws/starknet-aws-kms/NAME/` has mode `0700`; its files have mode `0600`:

| File | Purpose |
| --- | --- |
| `credentials` | AWS shared-credentials file containing the new user's access key and secret |
| `config` | Isolated AWS profile configuration, avoiding collisions with existing profiles |
| `.env` | Profile name, credentials-file path, region, key ARN and Starknet mainnet configuration |
| `resources.json` | Creation status and resource identifiers for recovery; no secret access key |
| `signing-policy.json` | Exact policy attached to the user |

Neither your standard AWS credentials file nor the project's `.env` is modified. Save any existing project configuration, then copy the generated environment file:

```sh
cp ~/.aws/starknet-aws-kms/starknet-kms/.env .env
npm run cli -- kms-check
npm run preset:build
npm run cli -- inspect
```

AWS credentials already exported in your shell can override the generated configuration when running application commands. Use a shell without other exported AWS credentials, and check that `AWS_PROFILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`, `AWS_REGION` and `AWS_KMS_KEY_ID` refer to this setup. The bootstrap helper itself explicitly selects the administrator profile and removes static credential environment overrides from its AWS CLI subprocesses.

IAM changes may need a short time to propagate. If `kms-check` initially reports access denied, retry after propagation; no second user or key is needed. The helper creates no Starknet transactions or funding transfers. Continue with the README to fund and deploy the derived account. AWS charges apply for retaining and using the KMS key.

## Failure recovery

The helper refuses to reuse an existing user name or output directory. It never silently replaces credentials or rotates a key. Creation calls are not automatically retried: a timeout can leave a resource created even when the response was lost.

If setup fails, inspect `resources.json` and the AWS console using your administrator profile. Successful resource identifiers are recorded after each step. Resources remain available for recovery; the helper never schedules KMS key deletion. If saving a newly created secret fails, it attempts to delete that access key and records whether revocation succeeded.

If the credentials file exists, retain it privately. If an access key was created but its secret was not saved (for example, after a process crash), delete that user access key in IAM before creating a replacement. Do not print replacement secrets into logs or commit generated files. Check IAM and KMS/CloudTrail for resources whose creation response may have been lost.

To abandon an unused setup, remove its access keys, inline policy and user through IAM, and separately schedule deletion of the unused KMS key. Preserve a KMS key controlling a funded Starknet account until funds and account ownership have been migrated. Choosing another name starts a separate setup with a separate key and account address; it does not recover the previous account.
