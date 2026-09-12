// SPDX-License-Identifier: MIT
// Built with OpenZeppelin Contracts for Cairo 3.0.0 (MIT).
#[starknet::contract(account)]
pub mod KmsAccount {
    use openzeppelin_account::EthAccountComponent;
    use openzeppelin_interfaces::accounts::EthPublicKey;
    use openzeppelin_introspection::src5::SRC5Component;

    component!(path: EthAccountComponent, storage: eth_account, event: EthAccountEvent);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);

    #[abi(embed_v0)]
    impl EthAccountMixinImpl =
        EthAccountComponent::EthAccountMixinImpl<ContractState>;
    impl InternalImpl = EthAccountComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        eth_account: EthAccountComponent::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        EthAccountEvent: EthAccountComponent::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
    }

    #[constructor]
    fn constructor(ref self: ContractState, public_key: EthPublicKey) {
        self.eth_account.initializer(public_key);
    }
}
