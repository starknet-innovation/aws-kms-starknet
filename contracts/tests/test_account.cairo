// Public test key = 1; cross-checked by tests/kms-signer.test.ts. Never fund this key.
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_signature,
    start_cheat_transaction_hash,
};
use starknet::{ContractAddress, SyscallResultTrait};

fn public_key() -> Array<felt252> {
    array![
        0x29bfcdb2dce28d959f2815b16f81798, 0x79be667ef9dcbbac55a06295ce870b07,
        0xfd17b448a68554199c47d08ffb10d4b8, 0x483ada7726a3c4655da4fbfc0e1108a8,
    ]
}
fn signature() -> Array<felt252> {
    array![
        0xe2fdf5973a2e23c48e794aab593940dc, 0xa43c24f6b898b5635ca9ce84f05ee2b0,
        0x77f4e0d585f7c4115bc66b28fc3e4717, 0x5a3992725ed9be5d677212ff1e75b67f,
    ]
}
fn deploy() -> ContractAddress {
    let class = declare("KmsAccount").unwrap().contract_class();
    let (address, _) = class.deploy(@public_key()).unwrap();
    address
}
fn verify(account: ContractAddress, digest: felt252, sig: Array<felt252>) -> felt252 {
    let mut calldata = array![digest];
    sig.serialize(ref calldata);
    *starknet::syscalls::call_contract_syscall(
        account, selector!("is_valid_signature"), calldata.span(),
    )
        .unwrap_syscall()
        .at(0)
}

#[test]
fn accepts_kms_format_signature() {
    assert!(verify(deploy(), 0x123, signature()) == starknet::VALIDATED);
}
#[test]
fn rejects_changed_digest() {
    assert!(verify(deploy(), 0x124, signature()) == 0);
}
#[test]
fn rejects_changed_signature() {
    let original = signature();
    let sig = array![1, *original.at(1), *original.at(2), *original.at(3)];
    assert!(verify(deploy(), 0x123, sig) == 0);
}
#[test]
fn constructor_stores_full_public_key() {
    let actual = starknet::syscalls::call_contract_syscall(
        deploy(), selector!("get_public_key"), array![].span(),
    )
        .unwrap_syscall();
    assert!(actual == public_key().span());
}
#[test]
fn validates_invoke_with_kms_signature() {
    let account = deploy();
    start_cheat_transaction_hash(account, 0x123);
    start_cheat_signature(account, signature().span());
    let result = starknet::syscalls::call_contract_syscall(
        account, selector!("__validate__"), array![0].span(),
    )
        .unwrap_syscall();
    assert!(*result.at(0) == starknet::VALIDATED);
}
#[test]
fn validates_deploy_account_with_kms_signature() {
    let account = deploy();
    start_cheat_transaction_hash(account, 0x123);
    start_cheat_signature(account, signature().span());
    let mut calldata = array![0x1, 0x42];
    calldata.append_span(public_key().span());
    let result = starknet::syscalls::call_contract_syscall(
        account, selector!("__validate_deploy__"), calldata.span(),
    )
        .unwrap_syscall();
    assert!(*result.at(0) == starknet::VALIDATED);
}
