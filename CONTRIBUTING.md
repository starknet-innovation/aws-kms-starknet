# Contributing

Fork the repository and adapt the examples to your own infrastructure. Keep runtime signing in AWS KMS and keep the CLI mainnet-only.

Run `npm ci` and `npm run verify` with the pinned tools in `.tool-versions`. These tests need no AWS credentials or network funds. Do not put live private keys, AWS credentials, authenticated RPC URLs, `.env` files, or funded test identities in commits or issues.

When changing dependencies or the account contract, update lockfiles, rerun both the TypeScript and Cairo suites, and verify the constructor/signature ABI. The OpenZeppelin preset release artifact must continue to reproduce its pinned published class hash. Account changes can change the class hash and deployment address. Document those effects before users fund an address.

Include the problem, resulting behavior, and validation in a pull request. Describe whether any claimed integration result was local, real KMS only, or an actual mainnet transaction; do not conflate them.
