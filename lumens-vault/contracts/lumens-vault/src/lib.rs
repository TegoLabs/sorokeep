#![no_std]

// The test module formats assertion output and collects into std collections,
// neither of which exists in no_std. Test-only, so the contract wasm is
// unaffected.
#[cfg(test)]
extern crate std;

pub mod storage;
pub mod events;
pub mod contract;

pub use contract::{LumensVault, LumensVaultClient};

#[cfg(test)]
mod test;
