<!--
For PRs against lumens-vault/. This is a SEPARATE template from the
repository default (.github/PULL_REQUEST_TEMPLATE.md), which still applies to
sorokeep's own TypeScript code — do not use this one for those.

GitHub does not apply this template automatically. Either open the PR with
`?template=lumens-vault.md` appended to the compare URL, or paste this file's
contents over the default template's body.

Everything below exists because of a specific mistake this project already
made once. See lumens-vault/CONTRIBUTING.md, "Two hard-won rules".
-->

## Issue this closes

Closes #<!-- issue number. One issue per PR. If this PR closes nothing, say
why it exists at all — unscoped changes to this directory are not accepted. -->

## Every file changed, and why

<!--
List every file in the diff, one per line, with a short reason. "and some
small fixes" is not a line item. If a file is in the diff that the issue's
Files section didn't name, that is exactly the scope drift the non-goals
sections exist to catch — call it out explicitly here rather than letting a
reviewer find it.

  - lumens-vault/contracts/lumens-vault/src/test.rs — added the two negative
    auth tests the acceptance criteria asked for
-->

-

## Acceptance criteria, with real output

<!--
Copy the issue's acceptance-criteria checklist here verbatim, and under each
item that asks you to verify, test, or run something, paste the ACTUAL
terminal output. Not a summary, not "tests pass", not output you expect the
command to produce — the real bytes from your terminal, in a fenced block.

An acceptance criterion with a tick and no output next to it reads, to a
reviewer, as unverified.

If the issue touched upgrade or TTL behaviour, run it more than once and say
how many times. A test that passed once has not been shown to be stable, and
this project has shipped that exact mistake before.

  - [x] `cargo test` green

    ```
    $ cargo test
    running 8 tests
    ...
    test result: ok. 8 passed; 0 failed
    ```
-->

-

## Anything you verified against primary sources

<!--
If the issue asked you to check something against current documentation —
Soroban/Stellar SDK behaviour, sorokeep's real CLI flags, a third-party
contract interface like Reflector — link what you actually read and state
what it said. That instruction is in the issue because a previous version of
that same claim turned out to be wrong.

Write "nothing required" if the issue asked for none.
-->

## Judgment calls the issue didn't specify

<!--
Anything you decided that the issue left open. Naming it here is always
cheaper than a reviewer finding it later and having to guess whether it was
deliberate. Write "none" if there were none.
-->

## Scope

- [ ] Nothing outside `lumens-vault/` was modified.
      <!-- Verify, don't assume: `git diff --name-only main... | grep -v '^lumens-vault/'`
           should print nothing. If it prints something, either revert it or
           justify it on the line below — a few issues do legitimately touch
           .github/ or repository-root files, and those say so in their Files
           section. -->
- [ ] The diff does exactly what the issue's acceptance criteria asked, and no more.
- [ ] Nothing in the issue's **Non-goals** section is in this PR.
- [ ] The issue's **Depends on** issues are merged, or the line said `nothing`.

## Secrets

- [ ] No secret key, seed phrase, webhook secret, API token, or `.env` value
      appears anywhere in this diff — including test fixtures, pasted command
      output, and the snapshot JSON under `test_snapshots/`.

<!--
Pasted terminal output is the usual way a secret reaches a public PR, so
re-read the blocks above before submitting. If something did leak, treat the
value as compromised and rotate it — deleting the comment does not, since
the edit history and any forks retain it. Do not report a suspected
vulnerability in a public PR; follow SECURITY.md.
-->

## Checks

- [ ] `cargo test` passes, with the output pasted above.
- [ ] `cargo fmt --check` introduces no new diff in files this PR touched.
- [ ] `cargo clippy --all-targets` introduces no new warning in files this PR touched.
- [ ] The v2 fixture was rebuilt first if the upgrade test was affected
      (see the build order in `lumens-vault/README.md`).
- [ ] Regenerated `test_snapshots/` files in the diff are ones this change
      genuinely affects — unrelated snapshot churn is reverted.
