# Deployment

Deploy tooling must pass constructor arguments. This document verifies the expected flag spelling for those arguments as parsed by the `stellar-cli`.

## Verified Spelling

The Stellar CLI automatically converts `snake_case` Rust argument names into `kebab-case` CLI flags.

- `admin` -> `--admin`
- `min_lock_ledgers` -> `--min-lock-ledgers`
- `max_lock_ledgers` -> `--max-lock-ledgers`

This was verified against `stellar-cli` version **28.1.0**.

## Command Line Outputs

### 1. `stellar contract deploy --help`

This command shows the general help for deploying a contract:

```text
Deploy a Wasm contract

Usage: stellar contract deploy [OPTIONS]

Options:
      --wasm <WASM>              Wasm file to deploy
      --wasm-hash <WASM_HASH>    Hash of the Wasm file
  -h, --help                     Print help

[... standard stellar-cli RPC and network options omitted for brevity ...]
```

### 2. `stellar contract deploy -- --help`

This command parses the provided WASM and displays the contract-specific arguments (the constructor arguments):

```text
Usage: stellar contract deploy --wasm <WASM> -- [CONTRACT_OPTIONS]

Contract Options:
      --admin <Address>                            Admin address for the vault
      --min-lock-ledgers <u32>                     Minimum lock ledgers
      --max-lock-ledgers <u32>                     Maximum lock ledgers
  -h, --help                                       Print help
```

## Worked Example

To deploy the vault and initialize it in one atomic step, run:

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/lumens_vault.wasm \
  --source admin \
  --network testnet \
  -- \
  --admin G...YOUR_ADMIN_ADDRESS... \
  --min-lock-ledgers 17280 \
  --max-lock-ledgers 31536000
```
