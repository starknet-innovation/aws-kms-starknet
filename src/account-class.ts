import { RpcError, type RpcProvider } from 'starknet';

/** OpenZeppelin 4.0.0 EthAccountUpgradeable, Scarb 2.18.0 release build. */
export const OZ_ETH_ACCOUNT_CLASS_HASH = '0x000be1cf8839442d664572712fd36554c4d259f86549ad02e22353d10729b900';
export const DEFAULT_ACCOUNT_ARTIFACT = 'contracts/preset/target/release/kms_oz_preset_EthAccountUpgradeable.contract_class.json';

/** A published class hash does not guarantee declaration on a particular network. */
export async function isClassDeclared(provider: Pick<RpcProvider, 'getClassByHash'>, classHash: string): Promise<boolean> {
  try {
    await provider.getClassByHash(classHash);
    return true;
  } catch (error) {
    if (error instanceof RpcError && error.code === 28) return false;
    throw error;
  }
}
