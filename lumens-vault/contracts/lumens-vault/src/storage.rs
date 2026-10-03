// Storage layout.
//
// Every persisted value is wrapped in a versioned enum. A later contract
// version adds a variant and leaves the existing one byte-identical, which is
// what lets `upgrade()` swap the bytecode without stranding stored data. The
// v2 fixture crate next door exists to prove that actually works.
//
// The V1 shapes are only editable in place while nothing is deployed anywhere.
// Once an instance exists holding data, adding a V2 variant is the only safe
// route.

use soroban_sdk::{contracttype, Address};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    State,                         // Stores VaultState
    Config,                        // Stores VaultConfig
    Vault(Address, Address, u32),  // (User, Asset, Vault ID) -> Stores VaultEntry
    AssetWhitelist(Address),       // Stores bool
    UserVaultCount(Address),       // Stores u32 for auto-incrementing vault IDs
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VaultConfig {
    V1(VaultConfigV1),
}

// Global, inclusive-at-both-ends lock bounds. There is deliberately no
// `default_timelock_ledgers` any more: a default is a second source of truth
// that the frontend's picker would have to know about, and the whole point of
// bounds is that every deposit states its own period inside them.
//
// `//` and not `///` on purpose: this struct is part of the wasm's spec
// metadata, which is paid for in rent forever. The same warning appears
// above `__constructor` in contract.rs.
//
// Edited in place as V1 rather than added as a V2 variant, which is only
// safe while nothing anywhere holds an instance of this contract in the old
// shape. That confirmation has not been recorded in this repository yet
// (E02-01), so treat it as an open precondition rather than a settled fact:
// if the contract turns out to have been deployed, this has to become
// `VaultConfig::V2` and existing instances need a migration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultConfigV1 {
    pub min_lock_ledgers: u32,
    pub max_lock_ledgers: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VaultEntry {
    V1(VaultEntryV1),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultEntryV1 {
    pub amount: i128,
    pub unlock_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VaultState {
    V1(VaultStateV1),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultStateV1 {
    pub is_paused: bool,
}
