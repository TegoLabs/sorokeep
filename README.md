<p align="center">
  <h1 align="center">Sorokeep</h1>
  <p align="center">
    <a href="README.es.md">Español</a>
    &middot;
    <a href="README.pt.md">Português (Brasil)</a>
    &middot;
    <a href="README.zh.md">简体中文</a>
  </p>
  <p align="center">
    The missing operations layer for deployed Soroban smart contracts.
    <br />
    Monitor TTLs. Get alerted before expiration. Auto-extend storage. Restore archived entries.
    <br />
    <br />
    <a href="#install">Install</a>
    &middot;
    <a href="#quick-start">Quick Start</a>
    &middot;
    <a href="#commands">Commands</a>
    &middot;
    <a href="#alerting">Alerting</a>
    &middot;
    <a href="#contributing">Contributing</a>
    &middot;
    <a href="CHANGELOG.md">Changelog</a>
  </p>
</p>

<p align="center">
  <a href="https://railway.com/new"><img src="https://railway.com/button.svg" alt="Deploy on Railway" /></a>
</p>

<br />

## Why Sorokeep Exists

_(Unfamiliar with Soroban/Stellar terminology like TTL, footprint, or ledger entry? Check out the [Glossary](docs/glossary.md).)_

Soroban's storage model is uncommon among major smart contract platforms: **state expires.** Every ledger entry — contract instances, persistent storage, WASM code — has a Time-To-Live (TTL). When it runs out, the entry is archived. If a contract's instance entry expires, the entire contract stops working. If persistent storage entries expire, user data becomes inaccessible until someone pays to restore it.

This is by design — state archival keeps Stellar lean and scalable. But it means **you must actively manage the lifecycle of your contract's state, or it dies.**

There is currently no dedicated open-source tool that combines TTL monitoring, alerting, auto-extension, cost tracking, and restoration for Soroban contracts. Developers either use manual CLI commands, build ad-hoc scripts, or embed TTL extension logic directly in their contracts. (See our detailed [Comparison Guide: Sorokeep vs. Manual Scripts](docs/vs-manual-scripts.md) for an in-depth breakdown.)

Sorokeep is the unified operations layer that handles all of this.

> **Why not just use a cron script?** See [Sorokeep vs. Cron Script](docs/vs-cron-script.md) for a detailed comparison of failure handling, alerting, cost visibility, and maintenance burden.

> Security auditors have started flagging TTL mismanagement as a risk area in Soroban contracts. [Veridise](https://veridise.com/audits/soroban/) includes TTL handling in their audit scope. The [LayerZero Stellar endpoint audit](https://code4rena.com/audits/2026-04-layerzero-stellar-endpoint) explicitly lists TTL expiration edge cases as a concern. [OpenZeppelin's Stellar contracts library](https://docs.openzeppelin.com/stellar-contracts) deliberately leaves instance storage TTL management to the application developer.

## Security & SBOM

Sorokeep generates a CycloneDX Software Bill of Materials (SBOM) for every release. You can find the `bom.json` file attached as a release asset on the [GitHub Releases page](https://github.com/AbdulmalikAlayande/sorokeep/releases).

## Features

- **Watch & Introspect** — Register contracts, footprint discovery from on-chain transactions, and introspection specs
- **Monitor** — Continuous TTL polling with configurable intervals via a long-running daemon
- **Alert** — Decoupled, queue-backed multi-channel notifications (Webhook with HMAC-SHA256, Slack Block Kit, Discord, Telegram, PagerDuty) with robust retry logic for low TTLs, resource usage spikes, and state changes
- **Auto-Extend** — Policy-based automatic TTL extension with transaction simulation before submission via `ExtendFootprintTTLOp`
- **Restore** — Recover archived entries via `RestoreFootprintOp` with pre-submission simulation
- **Cost & Resource Tracking** — Track extension history, XLM costs, 30-day projections, resource usage logs, and enforce configurable monthly budgets to prevent runaway spend
- **Inspect** — Inspect on-chain state, parse SAC token balances, and diff state changes
- **Channels** — Manage funded channel accounts for concurrent transaction submissions without sequence bottlenecks
- **Local-First** — All state stored in a SQLite database-backed queue. No external services beyond a Stellar RPC endpoint
- **AI-Ready** — Built-in Model Context Protocol (MCP) server exposing tools for AI agents to interact with Sorokeep's data natively
- **Advanced Security** — Integrates with AWS Secrets Manager & HashiCorp Vault for secure key resolution
- **Production-Ready deployments** — Includes Dockerfile, systemd service templates, and GitHub Actions for CI/CD integration

## Install

**Requirements:** Node.js 22+

```bash
# From source
git clone https://github.com/AbdulmalikAlayande/sorokeep.git
cd sorokeep
npm install
npm run build

# Run directly
npx tsx src/index.ts --help

# Or link globally after building
npm link
sorokeep --help

# Install the local man page
mkdir -p ~/.local/share/man/man1
cp man/sorokeep.1 ~/.local/share/man/man1/
mandb 2>/dev/null || true
man sorokeep
```

<!--
# npm (coming soon)
npm install -g sorokeep
-->

## Quick Start

> **Migrating from custom scripts or cron jobs?** See the [Migration Guide](docs/migrating-from-cli-scripts.md) to map your existing `soroban-cli` / `stellar contract extend-ttl` scripts to Sorokeep.

> **See it in action:** `scripts/demo.sh` runs the full Quick Start flow automatically. Record it with [asciinema](https://asciinema.org/) (`asciinema rec -c "bash scripts/demo.sh"`) and convert to an embeddable SVG with [svg-term-cli](https://github.com/marionebl/svg-term-cli) (`svg-term --in demo.cast --out docs/demo.svg --window`).
>
> Once a recording is captured, the SVG can be embedded here with:
> `![Sorokeep demo](docs/demo.svg)`

```bash
# 1. Register a contract for monitoring
sorokeep watch CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --network testnet \
  --name "XLM Native Token"

# 2. Check its current TTL health
sorokeep status CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

# 3. Set up a webhook alert (fires when TTL drops below 20,000 ledgers)
sorokeep alerts add \
  --contract CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --type webhook \
  --url https://your-server.com/webhook \
  --threshold 20000

# 4. Start the monitoring daemon
sorokeep daemon --network testnet
```

The daemon will check TTLs every 5 minutes, fire alerts when thresholds are crossed, send resolution notifications when TTLs recover, and auto-extend entries if guard policies are configured.

For using Sorokeep with a Soroban naming service so alerts and `status` output show friendly contract names, see [Naming Services](docs/naming-services.md).

## Commands

### Global Options

The following options can be used with any command:

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip all confirmation prompts on destructive commands (e.g., `unwatch`). Use in scripts and CI pipelines to run non-interactively. |
| `-h, --help` | Show help for any command or subcommand. |
| `-V, --version` | Print the Sorokeep version. |

> **Note:** `--yes` bypasses interactive confirmation prompts only. For the `check` command, use `--force` (see below) to bypass CI exit-code failures instead.

### `sorokeep watch <contract-id>`

Register a contract for monitoring. Connects to the Stellar RPC, discovers the contract's instance and WASM code entries, reads their TTLs, and stores everything locally.

```bash
sorokeep watch <contract-id> [options]
```

| Option                  | Description                                      | Default         |
| ----------------------- | ------------------------------------------------ | --------------- |
| `-n, --name <name>`     | Human-readable contract name                     | —               |
| `--network <network>`   | `testnet` or `mainnet`                           | `testnet`       |
| `-r, --rpc-url <url>`   | Custom Stellar RPC endpoint                      | Network default |
| `--storage-keys <keys>` | Comma-separated base64 XDR storage keys to track | —               |

**Example output:**

```
$ sorokeep watch CDLZFC3S...CYSC --network testnet --name "XLM Native Token"

✔ Contract XLM Native Token registered successfully.

  Contract: XLM Native Token (CDLZFC3S...CYSC)
  Network:  testnet
  Entries:  1 discovered
  Instance TTL: 113,918 ledgers (~7d 6h)  OK

  Run 'sorokeep status CDLZFC3S...CYSC' to check TTLs anytime.
  Run 'sorokeep guard CDLZFC3S...CYSC' to enable auto-extension.
```

Entry discovery happens in layers:

1. **Deterministic** (automatic) — Contract instance and WASM code entries, derived from the contract ID and WASM hash. Always tracked.
2. **Footprint-based** (daemon) — Discovered by scanning on-chain transaction events for storage keys your contract uses.
3. **Manual** (opt-in) — Specific storage keys declared via `--storage-keys`.

---

### `sorokeep status <contract-id>`

Display current TTL health for a watched contract. Reads from the local database — no RPC call.

```bash
sorokeep status <contract-id>
```

Shows contract name, network, last checked ledger, and a table of all tracked entries with remaining TTL in ledgers and human-readable time, plus a status indicator (OK / Warning / Critical).

---

### `sorokeep daemon`

Start the long-running monitoring process.

```bash
sorokeep daemon [options]
```

| Option                | Description                                    | Default          |
| --------------------- | ---------------------------------------------- | ---------------- |
| `--network <network>` | Network to monitor                             | `testnet`        |
| `--interval <ms>`     | Polling interval in milliseconds (min: 10,000) | `300000` (5 min) |
| `-r, --rpc-url <url>` | Custom RPC endpoint                            | Network default  |

Each cycle performs three phases:

1. **Monitor** — Fetches fresh TTLs for all contracts, detects threshold crossings, resolves recovered alerts
2. **Deliver** — Dispatches pending alerts to configured webhook and Slack channels
3. **Auto-Extend** — Extends TTLs for contracts with active guard policies

The daemon handles graceful shutdown on `SIGINT`/`SIGTERM` and includes a re-entrance guard to prevent overlapping cycles.

---

### `sorokeep alerts`

Manage alert configurations. Supports five subcommands.

#### `alerts add` — Create a new alert

```bash
sorokeep alerts add [options]
```

| Option                  | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `--contract <id>`       | Contract ID to alert on (required)                           |
| `--type <type>`         | `webhook` or `slack` (required)                              |
| `--url <url>`           | Webhook POST URL (required for webhook)                      |
| `--channel <channel>`   | Slack channel name or ID (required for slack)                |
| `--threshold <ledgers>` | Fire when remaining TTL drops below this (required)          |
| `--secret <secret>`     | HMAC signing secret for webhooks (auto-generated if omitted) |

For webhook alerts, an HMAC signing secret is auto-generated (32-byte hex) if you don't provide one. The secret is displayed once at creation time — save it to verify webhook signatures on your server. See [Webhook Signing](#webhook-signing) for details.

#### `alerts list` — View configured alerts

```bash
sorokeep alerts list --contract <id>
```

#### `alerts remove` — Delete an alert configuration

```bash
sorokeep alerts remove --id <config-id>
```

#### `alerts test` — Send a test alert

```bash
sorokeep alerts test --id <config-id>
```

Fires a synthetic `threshold_crossed` event through the real delivery pipeline. Useful for verifying that your webhook endpoint or Slack channel is correctly configured before going live.

#### `alerts history` — View past alert activity

```bash
sorokeep alerts history --contract <id> [--limit 20]
```

Shows a table of fired alerts: timestamp, entry label, TTL at fire, channel type, delivery status, retry count, and resolution time.

---

### `sorokeep guard`

Configure auto-extension policies. When enabled, the daemon automatically extends TTLs by submitting `ExtendFootprintTTLOp` transactions using a funded Stellar keypair.

```bash
sorokeep guard <contract-id> [options]
```

| Option                   | Description                                                             | Default  |
| ------------------------ | ------------------------------------------------------------------------ | -------- |
| `--preset <name>`        | Use a named policy preset (`conservative`\|`balanced`\|`aggressive`); mutually exclusive with `--target-ttl`/`--threshold` | —        |
| `--target-ttl <ledgers>` | TTL to extend entries to                                                | `100000` |
| `--threshold <ledgers>`  | Extend when TTL drops below this                                        | `20000`  |
| `--keypair <secret>`     | Stellar secret key (for one-time extension)                             | —        |
| `--keypair-env <var>`    | Env var name containing the secret key                                  | —        |
| `--auto-extend`          | Enable daemon auto-extension (requires `--keypair-env`)                 | —        |
| `--dry-run`              | Simulate extension and show estimated fee                               | —        |
| `--disable`              | Disable auto-extension for this contract                                | —        |

**Extension policy presets:**

Instead of picking raw ledger numbers, `--preset` selects a named tradeoff between cost and safety margin:

| Preset         | Target TTL      | Threshold      | Safety margin | Cost |
| -------------- | --------------- | -------------- | -------------- | ---- |
| `conservative` | 518,400 (~30d)  | 103,680 (~6d)  | Wide           | High |
| `balanced`     | 100,000 (~5.8d) | 20,000 (~1.2d) | Medium         | Med  |
| `aggressive`   | 51,840 (~3d)    | 8,640 (~12h)   | Narrow         | Low  |

Use `conservative` for production contracts where downtime is unacceptable, `aggressive` for actively monitored testnet contracts where extension cost matters more than safety margin, and `balanced` (the historical default) otherwise. `--preset` cannot be combined with `--target-ttl` or `--threshold` — pick one or the other.

```bash
sorokeep guard <contract-id> --preset conservative --keypair-env STELLAR_SECRET_KEY --auto-extend
```

**Usage modes:**

```bash
# Check current policy
sorokeep guard <contract-id>

# Dry run — see estimated fee without submitting
sorokeep guard <contract-id> --keypair S... --dry-run

# One-time immediate extension
sorokeep guard <contract-id> --keypair S...

# Enable auto-extension for the daemon
sorokeep guard <contract-id> --keypair-env STELLAR_SECRET_KEY --auto-extend

# Disable auto-extension
sorokeep guard <contract-id> --disable
```

**Security:** Secret keys are never stored in the database. When using `--auto-extend`, only the public key and the environment variable name are persisted. The daemon resolves the actual secret key from the environment at runtime.

---

### `sorokeep costs`

View extension history and rent spending for a contract.

```bash
sorokeep costs <contract-id> [options]
```

| Option            | Description                    | Default |
| ----------------- | ------------------------------ | ------- |
| `--period <days>` | Show costs for the last N days | `30`    |
| `--all`           | Show all history               | —       |

**Output includes:**

- Total extensions and total cost in XLM
- Breakdown by entry type (instance, wasm, persistent) with count and cost
- 30-day cost projection extrapolated from the selected period
- Recent extensions table: timestamp, entry label, old TTL → new TTL, cost in XLM, transaction hash

---

### `sorokeep restore`

Recover archived ledger entries via `RestoreFootprintOp` transactions.

```bash
sorokeep restore <contract-id> [options]
```

| Option                | Description                                    |
| --------------------- | ---------------------------------------------- |
| `--keypair <secret>`  | Stellar secret key                             |
| `--keypair-env <var>` | Env var containing secret key                  |
| `--entry <keyXdr>`    | Specific entry key XDR to restore (repeatable) |
| `--all`               | Restore all tracked entries for the contract   |

One of `--keypair` or `--keypair-env` is required. One of `--entry` or `--all` is required (mutually exclusive).

```bash
# Restore a specific entry
sorokeep restore <contract-id> --keypair-env STELLAR_SECRET_KEY --entry <base64-xdr>

# Restore all tracked entries
sorokeep restore <contract-id> --keypair-env STELLAR_SECRET_KEY --all
```

---

### `sorokeep resources`

View resource usage logs (CPU instructions, memory bytes, fee structures) for a contract to track execution efficiency over time.

---

### `sorokeep budget`

Set and monitor a monthly XLM extension budget for a contract. Prevents runaway costs if a contract requires frequent extensions.

---

### `sorokeep channels`

Manage funded channel accounts used to submit extension and restoration transactions concurrently, avoiding sequence number bottlenecks.

---

### `sorokeep inspect`

Inspect on-chain state directly. Can parse Stellar Asset Contract (SAC) token balances, diff state changes, and decode XDR without manual intervention.

---

### `sorokeep check`

Perform an ad-hoc, one-off execution of the monitoring cycle without starting the long-running daemon.

```bash
sorokeep check <contract-id> [options]
```

| Option | Description |
|--------|-------------|
| `--fail-under <ledgers>` | Exit with code 1 if any entry TTL is below this many ledgers (required) |
| `--force` | Bypass CI TTL failures and exit 0 even when entries are below the threshold. Use in CI pipelines where you want to report TTL health without failing the build. |

> **Note:** `--force` on `check` is different from the global `--yes` flag. `--force` overrides the exit code for CI/CD workflows; `--yes` skips interactive confirmation prompts on destructive commands.

---

### `sorokeep db`

Database management tasks, including migrations, backups, and introspection cache management.

---

### `sorokeep completion`

Generate shell autocomplete scripts for bash/zsh/fish/powershell to enable tab completion for all Sorokeep commands.

**Bash:**

```bash
sorokeep completion --script bash > /etc/bash_completion.d/sorokeep
# Or source it in your .bashrc:
# source <(sorokeep completion --script bash)
```

**Zsh:**

```zsh
sorokeep completion --script zsh > /usr/local/share/zsh/site-functions/_sorokeep
# Or source it in your .zshrc:
# source <(sorokeep completion --script zsh)
```

**Fish:**

```fish
sorokeep completion --script fish > ~/.config/fish/completions/sorokeep.fish
```

**PowerShell:**

```powershell
# Install for the current user (adds to $PROFILE)
sorokeep completion --script powershell | Out-File -FilePath (Join-Path $PROFILE "..\sorokeep_completion.ps1") -Encoding utf8
# Then add to your $PROFILE:
# . (Join-Path $PROFILE "..\sorokeep_completion.ps1")
#
# Or install directly into your $PROFILE:
# sorokeep completion --script powershell >> $PROFILE
```

---

### `sorokeep contracts`

List all watched contracts at a glance — an index view when you're managing more than a few contracts.

```bash
sorokeep contracts [options]
```

| Option | Description |
|--------|-------------|
| `--network <network>` | Filter by `testnet` or `mainnet` |
| `--json` | Output machine-readable JSON |

Displays a table with contract ID (truncated), name, network, entry count, worst-case remaining TTL, and status (OK / Warning / Critical / Expired). Reads from the local database only — instant, no RPC calls.

## Alerting

Sorokeep delivers alerts through multiple channels: **webhooks**, **Slack**, **Discord**, **Telegram**, **PagerDuty**, **Opsgenie**, **Microsoft Teams**, **Matrix**, **email**, **Google Chat**, **AWS SNS**, and a second configurable **Webhook v2** channel. Each alert includes a severity level and rich context about the affected entry. Sorokeep uses a robust, decoupled detection and dispatch architecture with a database-backed queue.

### Supported Channels Comparison

| Channel             | Auth Method                                                   | Typical Rate Limit                      | Payload Format                 | Setup Complexity |
| ------------------- | ------------------------------------------------------------- | --------------------------------------- | ------------------------------ | ---------------- |
| **Webhook**         | HMAC-SHA256 (`X-Sorokeep-Signature`) / Secret                 | Unlimited (target dependent)            | Generic JSON                   | Low              |
| **Webhook v2**      | HMAC-SHA256 (`X-Sorokeep-Signature`) / Secret, custom headers | Unlimited (target dependent)            | Generic JSON                   | Low              |
| **Slack**           | Bot OAuth Token (`xoxb-...`) / Webhook URL                    | 1 req/sec                               | Slack Block Kit JSON           | Low              |
| **PagerDuty**       | Events API v2 Routing Key                                     | 120 req/min                             | PagerDuty Event v2 JSON        | Low              |
| **Opsgenie**        | API Key                                                       | Plan-dependent                          | Opsgenie Alert API JSON        | Low              |
| **Discord**         | Webhook URL                                                   | 30 req/min per webhook                  | Discord Embed JSON             | Low              |
| **Telegram**        | Bot Token (`SOROKEEP_TELEGRAM_BOT_TOKEN`)                     | 30 msg/sec overall (1 msg/sec per chat) | HTML / Markdown Formatted Text | Medium           |
| **Microsoft Teams** | Webhook URL (tenant-scoped)                                   | Connector-dependent                     | Teams MessageCard JSON         | Low              |
| **Matrix**          | Room ID                                                       | Homeserver-dependent                    | Matrix `m.room.message` event  | Medium           |
| **Email**           | SMTP credentials (host/port/user/pass)                        | SMTP-provider dependent                 | Plain text + HTML              | Medium           |
| **Google Chat**     | Webhook URL                                                   | Space-dependent                         | Google Chat card JSON          | Low              |
| **AWS SNS**         | AWS IAM credentials (default credential chain)                | Topic-dependent (AWS account quota)     | Raw JSON (SNS `Message` field) | Medium           |

> Need a channel not listed here? See [Adding an Alert Channel](docs/adding-an-alert-channel.md) to implement a custom channel plugin.

### Alert Lifecycle

1. **Threshold Crossed** — During each monitoring cycle, if an entry's remaining TTL drops below a configured threshold, the monitor writes a `threshold_crossed` alert to the database queue.
2. **Delivery** — The dispatcher reads undelivered rows from the queue and routes the alert to the configured channel. Failed deliveries are retried on subsequent cycles, up to 5 attempts, and then gracefully abandoned. Success marks the row as delivered.
3. **Resolution** — When TTL recovers past the threshold (e.g., after an extension), Sorokeep fires an `alert_resolved` notification to all configured channels.

### Severity Levels

Severity is computed automatically based on how much TTL remains relative to the configured threshold:

| Severity     | Condition                                      | Description                              |
| ------------ | ---------------------------------------------- | ---------------------------------------- |
| **critical** | Remaining TTL < 25% of threshold, or TTL = 0   | Entry is in immediate danger of archival |
| **warning**  | Remaining TTL is below threshold but above 25% | Entry needs attention soon               |
| **info**     | Alert resolved (TTL recovered)                 | Entry is healthy again                   |

### Webhook Delivery

Webhook alerts are delivered as HTTP POST requests with a JSON body:

```json
{
	"type": "threshold_crossed",
	"severity": "warning",
	"contractId": "CDLZFC3S...",
	"contractName": "XLM Native Token",
	"network": "testnet",
	"entry": {
		"keyXdr": "AAAA1234...",
		"type": "instance",
		"label": "Contract Instance"
	},
	"threshold": {
		"configuredLedgers": 20000,
		"currentRemainingLedgers": 8500,
		"approximateTimeRemaining": "~13h 0m"
	},
	"firedAtLedger": 2500000,
	"timestamp": "2026-06-13T12:00:00.000Z"
}
```

### Webhook Signing

Webhook requests include an HMAC-SHA256 signature in the `X-Sorokeep-Signature` header for payload verification:

```
X-Sorokeep-Signature: sha256=a1b2c3d4e5f6...
```

To verify on your server using `sorokeep`:

```typescript
import { verifyWebhookSignature } from "sorokeep";

const isValid = verifyWebhookSignature(payload, signature, secret);
```

For non-Node receivers or without the `sorokeep` dependency, you can verify manually:

```javascript
import { createHmac } from "node:crypto";

function verifySignature(payload, signature, secret) {
	const expected =
		"sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
	return signature === expected;
}
```

The signing secret is auto-generated when you create a webhook alert (or you can provide your own with `--secret`). It is displayed once at creation time — store it securely.

### Slack Delivery

Slack alerts are sent via the [Slack Web API](https://api.slack.com/methods/chat.postMessage) using Block Kit for rich formatting. Messages include severity icons, contract details, remaining TTL, and actionable hints.

**Setup:**

1. Create a Slack app with `chat:write` scope at [api.slack.com/apps](https://api.slack.com/apps)
2. Install the app to your workspace and copy the Bot User OAuth Token (`xoxb-...`)
3. Provide the token via environment variable:

```bash
export SOROKEEP_SLACK_TOKEN=xoxb-your-bot-token
```

Alternatively, store the token in your config file at `~/.sorokeep/config.yaml`:

```yaml
slackToken: "xoxb-your-bot-token"
```

The environment variable takes precedence over the config file.

### Retry Policy

Failed alert deliveries are automatically retried on subsequent daemon cycles. After **5 consecutive failures**, the alert is abandoned and no further delivery attempts are made. You can view delivery status and retry counts with `sorokeep alerts history`.

## How It Works

Sorokeep is an off-chain monitoring tool. It reads data from the Stellar RPC, stores it locally in SQLite, and acts on it (alerts, auto-extension, restoration). It does not run on-chain and does not require you to modify your contracts.

```mermaid
sequenceDiagram
    participant loop as src/daemon/loop.ts
    participant monitor as src/core/monitor.ts
    participant extension as src/core/extension.ts
    participant dispatcher as src/alerts/dispatcher.ts
    participant db as src/db/repositories.ts

    Note over loop: setInterval tick triggers executeCycle()
    
    loop->>monitor: runMonitorCycle(db, network)
    activate monitor
    Note over monitor: 1. Batch-fetch TTLs via RPC<br/>2. Upsert fresh TTLs<br/>3. Detect threshold crossings & record AlertFired<br/>4. Resolve recovered alerts
    
    monitor->>extension: runAutoExtensions(db, network)
    activate extension
    Note over extension: Read extension_policies<br/>Simulate & submit ExtendFootprintTTLOp<br/>Record extension_history (cost, tx hash)
    extension-->>monitor: (extension results)
    deactivate extension
    
    monitor-->>loop: MonitorCycleResult
    deactivate monitor

    loop->>dispatcher: deliverPendingAlerts(db, network)
    activate dispatcher
    Note over dispatcher: Reads undelivered alerts from DB<br/>Routes to webhook/slack/etc.<br/>Increments retries on failure
    dispatcher-->>loop: (delivery results)
    deactivate dispatcher

    loop->>db: aggregateDailyCostSnapshots(db)
    activate db
    Note over db: Rolls extension_history into daily snapshots
    db-->>loop: (void)
    deactivate db
```

### The Daemon Cycle

Every polling interval (default: 5 minutes), the daemon runs three phases:

1. **Monitor** — For each registered contract, fetches fresh TTLs from the RPC, updates the database, checks each entry against every configured alert threshold. Fires `threshold_crossed` when TTL drops below a threshold; fires `alert_resolved` when TTL recovers.

2. **Deliver** — Processes all undelivered alerts from the database queue. Routes each to its configured channel (Webhook, Slack, Discord, Telegram, PagerDuty), marks successful deliveries, increments retry counters on failures, and abandons gracefully after 5 retries.

3. **Auto-Extend** — For contracts with an active guard policy, checks which entries have TTL below the policy threshold and simulates an `ExtendFootprintTTLOp` transaction via the Stellar RPC. If successful, it submits the transaction, records the exact XLM cost, and updates the contract's monthly budget usage to prevent runaway spend.

For the full data-flow (exact call order, fault isolation between phases, where a new contribution typically lands), see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Storage

All state is local. Sorokeep stores data in `~/.sorokeep/sorokeep.db` (SQLite with WAL mode). No external services required beyond a Stellar RPC endpoint.

**Database tables:**

| Table                | Purpose                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `contracts`          | Registered contracts with network, name, WASM hash                             |
| `contract_entries`   | Tracked ledger entries with TTLs and discovery source                          |
| `extension_policies` | Auto-extension rules per contract (threshold, target, keypair reference)       |
| `alert_configs`      | Alert channels, thresholds, and webhook secrets                                |
| `alerts_fired`       | Fired alert records with delivery status, retry count, and resolution tracking |
| `extension_history`  | Every TTL extension with transaction hash and XLM cost                         |

### Configuration

Sorokeep stores user configuration in `~/.sorokeep/config.yaml`:

```yaml
network: testnet
pollingIntervalSeconds: 300
slackToken: "xoxb-..." # Optional — can also use SOROKEEP_SLACK_TOKEN env var
rpcUrl: "https://..." # Optional — overrides network default
```

For a complete list of all supported fields (including integrations like Telegram, Vault, and Templates) and their environment variable overrides, see the [Configuration Reference](docs/config-reference.md).

The config file is created with `0600` permissions (owner read/write only) to protect sensitive values like the Slack token.

## Project Structure

```
sorokeep/
├── src/
│   ├── index.ts                 # CLI entry point (Commander.js)
│   ├── commands/                # CLI command handlers (thin presentation layer)
│   │   ├── watch.ts             # Contract registration
│   │   ├── status.ts            # TTL health display
│   │   ├── daemon.ts            # Long-running monitor
│   │   ├── alerts.ts            # Alert CRUD + test + history
│   │   ├── guard.ts             # Auto-extension policies
│   │   ├── costs.ts             # Extension cost reporting
│   │   └── restore.ts           # Archived entry recovery
│   ├── core/                    # Business logic (no CLI dependencies)
│   │   ├── watch.ts             # Contract registration and discovery
│   │   ├── monitor.ts           # Polling cycle, threshold detection, resolution
│   │   ├── extension.ts         # TTL extend, auto-extend, restore, cost recording
│   │   └── discovery.ts         # Footprint-based storage key discovery
│   ├── alerts/                  # Alert delivery pipeline
│   │   ├── types.ts             # AlertEvent, AlertSeverity, buildAlertEvent
│   │   ├── dispatcher.ts        # Routing, retry logic, delivery orchestration
│   │   ├── webhook.ts           # HTTP POST with HMAC-SHA256 signing
│   │   └── slack.ts             # Slack Web API + Block Kit formatting
│   ├── daemon/                  # Daemon lifecycle
│   │   └── loop.ts              # Start/stop, re-entrance guard, cycle orchestration
│   ├── rpc/                     # Stellar RPC client wrapper
│   │   └── client.ts            # Instance/WASM fetch, batch TTLs, extend, restore
│   ├── db/                      # Database layer
│   │   ├── schema.sql           # Full SQLite schema
│   │   ├── database.ts          # Init, WAL mode, live migrations
│   │   └── repositories.ts      # All query functions
│   ├── logging/                 # Structured logging (pino)
│   └── utils/                   # Config loader, TTL formatting
├── tests/                       # Mirrors src/ structure — 891 tests across 66 files
├── .github/workflows/           # CI (test + type-check) and publish
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── Dockerfile                   # Docker container definition
├── systemd/                     # Systemd service templates for Linux deployments
├── LICENSE
└── CONTRIBUTING.md
```

**Architecture layers:**

- **Commands** (`src/commands/`) — Thin CLI layer. Parses arguments, calls core, formats terminal output. No business logic.
- **Core** (`src/core/`) — Pure business logic. Testable without network or CLI. The daemon reuses the same functions.
- **RPC** (`src/rpc/`) — Stellar SDK wrapper. All network calls go through here. Handles transaction building, simulation, signing, and submission.
- **Alerts** (`src/alerts/`) — Delivery pipeline. Channel-specific formatting and transport, routing, retry management.
- **DB** (`src/db/`) — SQLite repositories. All queries centralized here. In-memory mode for tests.

## Tech Stack

| Package                                                                              | Purpose                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| [TypeScript](https://www.typescriptlang.org/)                                        | Application language (ESM)                       |
| [@stellar/stellar-sdk](https://github.com/nicktomlin/js-stellar-sdk)                 | Stellar and Soroban RPC interactions             |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)                         | Local database (synchronous, zero external deps) |
| [Commander.js](https://github.com/tj/commander.js)                                   | CLI framework                                    |
| [pino](https://github.com/pinojs/pino)                                               | Structured JSON logging                          |
| [chalk](https://github.com/chalk/chalk) / [ora](https://github.com/sindresorhus/ora) | Terminal formatting and spinners                 |
| [yaml](https://github.com/eemeli/yaml)                                               | Config file parsing                              |
| [Vitest](https://vitest.dev/)                                                        | Test framework                                   |

## Testing

```bash
# Run all tests
npm test

# Run a specific test file
npx vitest run tests/core/monitor.test.ts

# Watch mode
npx vitest
```

**891 tests** across **66 test files** covering:

- **Formatting** — TTL conversion, status classification, human-readable time
- **Database** — CRUD, cascades, upserts, deduplication, alert delivery queues
- **RPC Client** — Contract instance, WASM code, batch TTL queries, transaction simulation
- **Watch** — Registration, re-watch, SAC contracts, error handling, network isolation, introspection
- **Monitor Cycle** — TTL refresh, threshold detection, alert deduplication, resolution, fault isolation, multi-threshold escalation, partial RPC responses
- **Extension** — TTL extension, auto-extension policy evaluation, restore, cost recording, budget enforcement
- **Alert Dispatcher** — Channel routing, retry logic, max retry cap, abandoned alerts (Slack, Discord, Telegram, Webhook, PagerDuty)
- **Webhook** — HMAC-SHA256 signing, timeout handling, HTTP error responses
- **Slack** — Token resolution, Block Kit structure, `body.ok` validation
- **CLI Commands** — Alerts, budget, guard, costs, watch, status, daemon, check, restore, db, channels
- **Config** — Load/save, defaults, parse failure handling, file permissions
- **Daemon** — Start/stop, re-entrance guard, cycle error isolation
- **MCP Server** — Test coverage for all exposed MCP tools

All tests use in-memory SQLite databases and mocked RPC responses — no network calls, no filesystem side effects. TDD is practiced throughout.

## Security & Provenance

Sorokeep packages published to npm carry a [verified provenance statement](https://docs.npmjs.com/generating-provenance-statements). This provides a cryptographic, auditable link between the published npm package and the exact GitHub Actions run and commit that built it.

To verify the provenance of your installed Sorokeep package, you can check the [npm registry page](https://www.npmjs.com/package/sorokeep) for the provenance badge, or run the following command to check npm audit signatures:

```bash
npm audit signatures
```

## FAQ

### Why TypeScript, not Rust?

Sorokeep is an off-chain operational tool, not a smart contract. TypeScript was chosen because:

1. The Stellar JS SDK is the most complete client library for Soroban RPC interactions
2. Soroban developers already have Node.js in their toolchain
3. npm distribution means zero-friction installation
4. The performance requirements (periodic RPC polling) are well within Node.js capabilities
5. It maximizes the contributor pool — most Soroban developers know TypeScript

### Is my secret key stored anywhere?

No. When you configure auto-extension with `--keypair-env`, Sorokeep stores only the **public key** and the **environment variable name** in the database. The actual secret key is resolved from your environment at runtime. If you use `--keypair` for a one-time operation, the key is used in-memory and never persisted.

### What happens if the daemon crashes mid-cycle?

Each phase (monitor, deliver, auto-extend) is wrapped in isolated error handling. A failure in one phase doesn't prevent the others from running. Alert deliveries are idempotent — if a delivery was marked successful, it won't be re-sent. If the daemon restarts, undelivered alerts will be picked up on the next cycle.

### What networks are supported?

Testnet (`https://soroban-testnet.stellar.org`) and Mainnet (`https://mainnet.sorobanrpc.com`) are supported, and commands that make RPC calls accept a custom endpoint with `--rpc-url`. The selected network is stored with each watched contract, so keep the network and RPC endpoint aligned.

### How do I register a contract for monitoring?

Run `sorokeep watch <contract-id>` and provide the network and RPC options required for your deployment. Alert configurations require that the contract has already been registered; use `sorokeep status <contract-id>` to inspect its current state.

### How can I verify an alert channel before going live?

Create the alert configuration, then run `sorokeep alerts test --id <alert-config-id>`. The command sends a synthetic `threshold_crossed` event through the real delivery path; add `--dry-run` to print the payload without sending it.

### Can one alert go to more than one destination?

Yes. For TTL alerts, repeat `--target <type:target>` when running `sorokeep alerts add`, for example `--target webhook:https://... --target slack:alerts`. Resource alerts currently support only their primary target.

### Why did an alert not arrive immediately?

An alert may be deferred when its configured quiet-hours window is active; it remains pending without consuming a retry. Delivery failures are retried by the daemon, and a delivery is abandoned after the channel's retry limit is reached.

### Which alert channels are available?

The built-in registry currently includes Webhook, Webhook v2, Slack, PagerDuty, Google Chat, Discord, Telegram, Opsgenie, Microsoft Teams, Matrix, and email. Run `sorokeep alerts channels` to see the registered channels in the current installation, including channels supplied by plugins.

### What happens when a contract entry has already expired?

An expired entry is archived and cannot be extended until it is restored. Run `sorokeep restore <contract-id> --entry <key-xdr> --keypair-env <var>` (or use `--all`), then let the existing watch continue; restoration requires a signing key and XLM for network fees.

### What about email alerts?

Email alerts are supported. Configure SMTP credentials (host/port/user/pass) in `~/.sorokeep/config.yaml` or via the corresponding environment variables, and email deliveries use the same database-backed retry queue as the other channels. See the [Configuration Reference](docs/config-reference.md) for the exact field names.

### How do I use a custom RPC endpoint?

Pass `--rpc-url <url>` to `sorokeep watch` or `sorokeep daemon`, or set `rpcUrl` in `~/.sorokeep/config.yaml`. A custom endpoint overrides the default Testnet or Mainnet RPC URL for that command.

### Can I run a monitoring pass without the daemon?

Yes — `sorokeep check <contract-id> --fail-under <ledgers>` runs a single monitoring cycle ad hoc and exits with code 1 if any tracked entry is below that TTL. Use `--force` in CI when you want to report TTL health without failing the build.

### How do I restore an archived entry?

Run `sorokeep restore <contract-id> --keypair-env STELLAR_SECRET_KEY --all` to restore all tracked entries, or pass `--entry <base64-xdr>` to restore one specific entry. The command requires either `--keypair` or `--keypair-env`.

### How do I see how much I've spent on extensions?

Run `sorokeep costs <contract-id>` to see total extensions, total cost in XLM, a per-entry-type breakdown, and a 30-day projection. Use `--period <days>` to change the lookback window or `--all` for the complete history.

### What does `sorokeep guard --dry-run` do?

Run `sorokeep guard <contract-id> --keypair S... --dry-run` to simulate the extension transaction and see the estimated fee without submitting anything to the network. This is useful for checking cost before enabling auto-extension or performing a one-time extension.

## Roadmap

Track overall progress on the [Sorokeep Roadmap board](https://github.com/AbdulmalikAlayande/sorokeep/projects) — issues are grouped by phase (`phase-1` through `phase-15`) with Todo/In Progress/Done status.

> **Note:** The board is configured via a proposal at [`docs/roadmap-board-proposal.md`](docs/roadmap-board-proposal.md).
> If you're a maintainer, follow that doc to create and link the board.

- Plugin interface for alert channels — so a new channel (Matrix, MS Teams, email) doesn't require touching core dispatch code or the DB schema
- Prometheus `/metrics` endpoint for teams with existing observability stacks — see [Observability Setup Guide](docs/observability.md); an [example Grafana dashboard](devops/grafana/sorokeep-dashboard.json) is included
- Reusable GitHub Action wrapping `sorokeep check` for CI-integrated TTL checks
- Web dashboard for visual TTL monitoring
- Multi-contract batch operations

## Getting Help

**Troubleshooting daemon issues?** See [docs/troubleshooting.md](docs/troubleshooting.md) for a complete runbook covering common failure modes (hung cycles, alerts not firing, auto-extension blocked, RPC errors) with diagnostic commands and resolution steps.

If you're stuck or have questions:
- Check [open issues](https://github.com/AbdulmalikAlayande/sorokeep/issues)
- Reach out on X: [@The_good_man02](https://twitter.com/The_good_man02)

For security issues (key leakage, unintended transactions), see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the system works at runtime, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities. This project follows a [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)

## Author

**Abdulmalik Alayande**

- GitHub: [@AbdulmalikAlayande](https://github.com/AbdulmalikAlayande)
- X: [@The_good_man02](https://twitter.com/The_good_man02)
