// Event definitions. Two rules apply here:
//
// 1. Four topics is a hard ceiling. The SDK's type system does not enforce it,
//    so nothing stops a fifth `#[topic]` being added by mistake.
// 2. High-cardinality fields (`vault_id`, `amount`, `asset` on the whitelist
//    events) go in data, not topics.
//
// Rule 2 has a consequence the off-chain reader has to live with: because
// `asset` is data on WhitelistEvent and DelistEvent, it cannot be used as an
// RPC topic filter, so the backend must decode every one of those events and
// inspect the payload to derive the current whitelist.
//
// UNVERIFIED: none of these structs specify `#[contractevent(topics = [...])]`
// explicitly, so the macro applies its default topic naming, and whether that
// prepends an implicit name topic has never been checked against the pinned
// SDK version. That changes every event's real topic count. Confirm it by
// publishing each event type in a test and asserting `env.events().all()`
// rather than reasoning about it.

use soroban_sdk::{contractevent, Address, BytesN};

#[contractevent]
pub struct PauseEvent {
    #[topic]
    pub admin: Address,
}

#[contractevent]
pub struct UnpauseEvent {
    #[topic]
    pub admin: Address,
}

#[contractevent]
pub struct WhitelistEvent {
    #[topic]
    pub admin: Address,
    pub asset: Address,
}

#[contractevent]
pub struct DelistEvent {
    #[topic]
    pub admin: Address,
    pub asset: Address,
}

#[contractevent]
pub struct NewAdminEvent {
    #[topic]
    pub admin: Address,
    pub new_admin: Address,
}

#[contractevent]
pub struct DepositEvent {
    #[topic]
    pub from: Address,
    #[topic]
    pub asset: Address,
    pub vault_id: u32,
    pub amount: i128,
}

#[contractevent]
pub struct WithdrawEvent {
    #[topic]
    pub to: Address,
    #[topic]
    pub asset: Address,
    pub vault_id: u32,
    pub amount: i128,
}

#[contractevent]
pub struct UpgradeEvent {
    #[topic]
    pub admin: Address,
    pub new_wasm_hash: BytesN<32>,
}

#[contractevent]
pub struct ConfigUpdatedEvent {
    #[topic]
    pub admin: Address,
    pub min_lock_ledgers: u32,
    pub max_lock_ledgers: u32,
}
