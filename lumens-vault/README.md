# Lumens Vault

A time-locked, multi-asset savings vault on Stellar Soroban. Users deposit an
admin-whitelisted asset, choose a lock period within admin-set bounds, and cannot withdraw
until it expires. No yield, no fees, no emergency unlock.

It is built for two purposes at once. It is a usable savings primitive, and it is a real
proving ground for [Sorokeep](https://github.com/TegoLabs/sorokeep) — every vault is a
separate persistent ledger entry with its own TTL, so a busy contract accumulates a lot of
storage that has to be kept alive. That is exactly the problem Sorokeep exists to solve, and
exercising it against something real is more informative than a synthetic demo.

**Status:** testnet only, not audited, not deployed to mainnet. The conditions that would have
to be met first are tracked in the backlog under epic E04 and collected into a pre-mainnet
checklist there.

## Where this lives

Developed inside the `sorokeep` repository under `lumens-vault/` for the duration of Drips
Wave 9 (Stellar), then moved to its own repository. Everything Lumens-Vault-specific is
contained in this one folder, so that move is a folder move rather than an untangling.

Nothing outside `lumens-vault/` belongs to this project. Sorokeep's own `src/`, `tests/`,
`docs/` and root files are a separate, live project and are never modified by work here.

## Layout

```
lumens-vault/
├── contracts/
│   ├── lumens-vault/              the contract
│   └── lumens-vault-v2-fixture/   disposable second binary, proves the upgrade path
├── docs/
│   ├── TECH_SPEC.md               what the system must do
│   ├── SYSTEM_DESIGN.md           how the pieces are arranged
│   ├── testing.md                 clean checkout → green contract test suite, verified
│   └── backlog/                   the issue backlog and the requirements register
├── CONTRIBUTING.md
└── README.md
```

`backend/` and `frontend/` do not exist yet. They are specified in `docs/SYSTEM_DESIGN.md`
and built out by the backlog's E07 onwards.

## Requirements

- [Rust 1.85 or later.](https://www.rust-lang.org/tools/install)
- The `wasm32v1-none` target — the only target the Soroban runtime supports.
- [`stellar-cli` `23.1.0`](https://github.com/stellar/stellar-cli)

```powershell
rustup target add wasm32v1-none
```

## Build and test

The upgrade test imports the v2 fixture's compiled wasm via `contractimport!`, which resolves
at **compile** time. The fixture must therefore be built before the main crate's tests, or
cargo test` fails on a missing file:

```powershell
cd contracts\lumens-vault-v2-fixture
stellar contract build

cd ..\lumens-vault
cargo test
```

Expected: 5 tests, all passing.

The full walkthrough — required toolchain versions, this command sequence with its
actual output, what the fixture-ordering failure looks like when you skip step 1, and a
troubleshooting table — is in [`docs/testing.md`](docs/testing.md).

To build the contract itself to wasm:

```powershell
cd contracts\lumens-vault
stellar contract build
```

Expected: a wasm artifact under `target\wasm32v1-none\release\`, currently around 11.4 KB with
16 exported functions. The `[profile.release]` block must keep `overflow-checks = true` —
`stellar contract build` requires it.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. Two rules matter more than the rest:

1. **Show your work.** If a PR says tests pass, paste the output. Anything touching TTL or
   upgrade behaviour gets run more than once.
2. **Verify against primary sources.** Soroban SDK behaviour, Sorokeep's CLI flags and
   third-party contract interfaces have each been stated incorrectly here at some point.
Where an issue asks you to check something, it is because a previous version of that claim
was wrong.

Work is tracked as issues in the `sorokeep` repository under the `lumens-vault` label. The
backlog is generated — see [`docs/backlog/`](docs/backlog/) for the requirements register,
the epics, and the coverage matrix proving every requirement maps to at least one issue.

## License

Lumens Vault is licensed under the [MIT License](LICENSE).

## Relationship to Sorokeep

Sorokeep is a separate, already-built tool: a TypeScript CLI and daemon that monitors Soroban
storage TTLs and auto-extends them. This project **consumes** it — registered via its CLI,
receiving its webhook alerts, importing `verifyWebhookSignature` from its npm package. None of
its functionality is reimplemented here. If something looks like it needs TTL polling or
auto-extension logic in this codebase, that is a sign of a design mistake, not a missing
feature.
