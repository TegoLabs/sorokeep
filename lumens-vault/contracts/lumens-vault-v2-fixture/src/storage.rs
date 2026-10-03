// Every key and the V1 shapes here must stay byte-identical to the real
// contract's storage.rs — that's what lets this "new" binary correctly
// deserialize ledger entries the OLD binary actually wrote. Only add new
// variants (like VaultEntryV2 below); never change what V1 already means.

use soroban_sdk::{contracttype, Address};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    State,
    Config,
    Vault(Address, Address, u32),
    AssetWhitelist(Address),
    UserVaultCount(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VaultConfig {
    V1(VaultConfigV1),
}

// Mirrors the real contract's `VaultConfigV1` byte-for-byte. The fixture
// never reads `DataKey::Config` — only `get_vault` and `version` exist here —
// so this shape is carried purely to keep the "V1 shapes are byte-identical
// across both crates" invariant above true, rather than because anything
// depends on it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultConfigV1 {
    pub min_lock_ledgers: u32,
    pub max_lock_ledgers: u32,
}

/// The deliberate schema change this whole fixture exists to test: a new
/// variant with an extra field, added alongside the untouched V1 shape.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VaultEntry {
    V1(VaultEntryV1),
    V2(VaultEntryV2),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultEntryV1 {
    pub amount: i128,
    pub unlock_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultEntryV2 {
    pub amount: i128,
    pub unlock_ledger: u32,
    pub last_touched_ledger: u32,
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
