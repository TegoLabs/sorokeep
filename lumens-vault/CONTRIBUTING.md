# Contributing to Lumens Vault

Thanks for wanting to work on this. Read this whole file before your first
PR — it's short, and it exists because of specific, real mistakes this
project already made once and doesn't want to make again.

## Where work comes from

All work is tracked as GitHub issues in the [`sorokeep` repository](https://github.com/TegoLabs/sorokeep/issues?q=is%3Aissue+label%3Alumens-vault), labeled
`lumens-vault`, grouped into milestones. **Every issue has an Acceptance
Criteria checklist and a Non-Goals section.** Both are load-bearing:

- The acceptance criteria are what "done" means. If you think something
  else should also be done, open a new issue for it — don't fold it into
  the PR silently.
- The non-goals exist because this project's history includes real
  instances of scope quietly expanding or quietly shrinking between what
  was designed and what got built, and nobody noticing until it became a
  security finding months later. If a non-goal seems wrong to you, say so
  in the issue before you start, not in the PR description after.

If an issue's scope genuinely doesn't make sense once you're in the code,
stop and comment on the issue. Don't guess and expand it.

## Two hard-won rules, stated plainly

**1. Show your work — don't assert, demonstrate.**
If your PR says tests pass, paste the actual `cargo test` output. If it
touches anything upgrade- or TTL-related, run it more than once — a test
that passes once and never again isn't proven, and this project has
shipped that exact mistake before. "It works" is not a substitute for the
output that shows it working.

**2. Verify against primary sources, not memory or secondhand docs.**
Soroban/Stellar SDK behavior, Sorokeep's actual current CLI flags, and
third-party contract interfaces (Reflector, etc.) have all been stated
incorrectly at some point in this project's history — not out of
carelessness, but because it's genuinely easy to trust a plausible-sounding
claim instead of checking it. If an issue asks you to verify something
against current docs, that instruction is there because a previous version
of this exact claim was wrong. Check it for real.

Neither of these is about distrust of you specifically — they're standing
process fixes for failure modes that already happened here, once each,
expensively.

## Getting your environment set up

You'll need:
- Rust, edition2024-capable (1.85+) — `soroban-sdk`'s dependency tree
  requires this; older toolchains will fail with an `edition2024` error
  before reaching this project's own code
- The `wasm32v1-none` target
- `stellar-cli`, reasonably current
- Node.js, for anything under the eventual app-data/frontend components
  (see [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md) — these don't fully exist yet)

Build and test commands are in [`README.md`](README.md). Note the build order: the
v2 fixture crate must be compiled before `cargo test`, because the upgrade test
resolves its wasm at compile time. The verified step-by-step — toolchain versions,
the exact PowerShell sequence from clean checkout to green suite, and the actual
failure output if you skip the fixture build — is in
[`docs/testing.md`](docs/testing.md).

## Making a PR

1. Pick an open, unassigned issue (or comment to claim one).
2. Read the issue's **Depends on** line before starting. It lists the
   specific issues that must merge first, or says `nothing`. Dependencies
   are declared per issue rather than as a global queue, so plenty of work
   is available in parallel — but starting something whose dependency is
   still open usually means rewriting it.
3. Keep the PR scoped to the issue's acceptance criteria.
4. Include real command output for anything the acceptance criteria asks
   you to verify or test — not a summary of what you expect it to say.
5. If you had to make a judgment call the issue didn't specify, say so
   explicitly in the PR description rather than picking silently.

## Review and merge

PRs are reviewed against the issue's acceptance criteria first, scope
second, style third. A correct, narrowly-scoped PR that does exactly what
the issue asked will move faster than an impressive one that does more
than the issue asked.

## Code of conduct and security

This repo's [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) applies here too. For security issues,
follow [`SECURITY.md`](../SECURITY.md)'s disclosure process — do not open a public issue for
a suspected vulnerability, especially anything touching the contract's
fund-safety logic.
