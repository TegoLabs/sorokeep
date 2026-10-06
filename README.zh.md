<!-- 此文件使用简体中文 (Simplified Chinese) 编写。如需维护，请保持简体中文变体。 -->

<p align="center">
  <h1 align="center">Sorokeep</h1>
  <p align="center">
    已部署 Soroban 智能合约所缺失的操作层。
    <br />
    监控 TTL。在过期前收到提醒。自动延长存储。恢复已归档的条目。
    <br />
    <br />
    <a href="#安装">安装</a>
    &middot;
    <a href="#快速开始">快速开始</a>
    &middot;
    <a href="#命令">命令</a>
    &middot;
    <a href="#告警">告警</a>
    &middot;
    <a href="#参与贡献">参与贡献</a>
  </p>
</p>

<p align="right">
  <a href="README.md">English</a>
</p>

<br />

## 为什么需要这个工具

Soroban 的存储模型在主流智能合约平台中并不常见：**状态会过期。** 每个账本条目——合约实例、持久存储、WASM 代码——都有一个生存时间（TTL）。当 TTL 耗尽时，该条目会被归档。如果合约的实例条目过期，整个合约将停止工作。如果持久存储条目过期，用户数据将无法访问，直到有人付费恢复为止。

这是设计使然——状态归档保持了 Stellar 的轻量化和可扩展性。但这意味着**你必须主动管理合约状态的生命周期，否则它就会失效。**

目前尚无专门的开源工具能够将 TTL 监控、告警、自动延长、成本追踪和恢复功能整合用于 Soroban 合约。开发者要么使用手动 CLI 命令，要么编写临时脚本，要么直接在合约中嵌入 TTL 延长逻辑。

Sorokeep 就是处理所有这些事务的统一操作层。

> 安全审计机构已开始将 TTL 管理不善标记为 Soroban 合约中的风险领域。[Veridise](https://veridise.com/audits/soroban/) 将 TTL 处理纳入其审计范围。[LayerZero Stellar 端点审计](https://code4rena.com/audits/2026-04-layerzero-stellar-endpoint)明确将 TTL 过期边界情况列为关注点。[OpenZeppelin 的 Stellar 合约库](https://docs.openzeppelin.com/stellar-contracts)则故意将实例存储 TTL 管理留给应用开发者自行处理。

## 功能特性

- **观察与内省** — 注册合约、从链上交易中发现 footprint，以及内省规范
- **监控** — 通过长时间运行的守护进程，以可配置的间隔持续轮询 TTL
- **告警** — 解耦的、基于队列的多渠道通知（支持带 HMAC-SHA256 的 Webhook、Slack Block Kit、Discord、Telegram、PagerDuty），具备针对低 TTL、资源使用峰值和状态变更的健壮重试逻辑
- **自动延长** — 基于策略的自动 TTL 延长，在通过 `ExtendFootprintTTLOp` 提交交易前进行模拟
- **恢复** — 通过 `RestoreFootprintOp` 恢复已归档的条目，并在提交前进行模拟
- **成本与资源追踪** — 追踪延长历史、XLM 费用、30 天成本预测、资源使用日志，并可配置月度预算上限以防止费用失控
- **检查** — 检查链上状态、解析 SAC 代币余额，以及对比状态变更
- **通道** — 管理资金充足的通道账户，用于并发提交交易，避免序列号瓶颈
- **本地优先** — 所有状态存储在基于 SQLite 数据库的队列中。除 Stellar RPC 端点外无需外部服务
- **AI 就绪** — 内置模型上下文协议（MCP）服务器，为 AI 代理提供与 Sorokeep 数据原生交互的工具
- **高级安全** — 集成 AWS Secrets Manager 和 HashiCorp Vault，实现安全的密钥解析
- **生产就绪部署** — 包含 Dockerfile、systemd 服务模板和 GitHub Actions，支持 CI/CD 集成

## 安装

**前提条件：** Node.js 22+

```bash
# 从源码安装
git clone https://github.com/AbdulmalikAlayande/sorokeep.git
cd sorokeep
npm install
npm run build

# 直接运行
npx tsx src/index.ts --help

# 或者在构建后全局链接
npm link
sorokeep --help
```

<!--
# npm（即将推出）
npm install -g sorokeep
-->

## 快速开始

```bash
# 1. 注册一个合约进行监控
sorokeep watch CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --network testnet \
  --name "XLM Native Token"

# 2. 检查当前的 TTL 健康状态
sorokeep status CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

# 3. 设置 webhook 告警（当 TTL 低于 20,000 个账本时触发）
sorokeep alerts add \
  --contract CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --type webhook \
  --url https://your-server.com/webhook \
  --threshold 20000

# 4. 启动监控守护进程
sorokeep daemon --network testnet
```

守护进程将每 5 分钟检查一次 TTL，当超过阈值时触发告警，在 TTL 恢复时发送恢复通知，并在配置了防护策略时自动延长条目。

## 命令

### `sorokeep watch <contract-id>`

注册一个合约进行监控。连接到 Stellar RPC，发现合约的实例和 WASM 代码条目，读取它们的 TTL，并将所有信息存储在本地。

```bash
sorokeep watch <contract-id> [options]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-n, --name <name>` | 人类可读的合约名称 | — |
| `--network <network>` | `testnet` 或 `mainnet` | `testnet` |
| `-r, --rpc-url <url>` | 自定义 Stellar RPC 端点 | 网络默认值 |
| `--storage-keys <keys>` | 逗号分隔的 base64 XDR 存储密钥，用于追踪 | — |

**输出示例：**

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

条目发现分层进行：

1. **确定性发现**（自动）— 合约实例和 WASM 代码条目，从合约 ID 和 WASM 哈希值推导得出。始终被追踪。
2. **基于 Footprint 的发现**（守护进程）— 通过扫描链上交易事件，发现合约使用的存储密钥。
3. **手动发现**（可选）— 通过 `--storage-keys` 声明的特定存储密钥。

---

### `sorokeep status <contract-id>`

显示已监控合约的当前 TTL 健康状态。从本地数据库读取——无需 RPC 调用。

```bash
sorokeep status <contract-id>
```

显示合约名称、网络、上次检查的账本，以及所有已追踪条目的表格，包括剩余 TTL（以账本数和人类可读时间表示），还有状态指示器（OK / Warning / Critical）。

---

### `sorokeep daemon`

启动长时间运行的监控进程。

```bash
sorokeep daemon [options]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--network <network>` | 要监控的网络 | `testnet` |
| `--interval <ms>` | 轮询间隔（毫秒，最小值：10,000） | `300000`（5 分钟） |
| `-r, --rpc-url <url>` | 自定义 RPC 端点 | 网络默认值 |

每个周期执行三个阶段：

1. **监控** — 获取所有合约的最新 TTL，检测阈值超过情况，解析已恢复的告警
2. **投递** — 将待处理的告警分发到配置的 webhook 和 Slack 频道
3. **自动延长** — 为具有活跃防护策略的合约延长 TTL

守护进程处理 `SIGINT`/`SIGTERM` 的优雅关闭，并包含重入保护以防止周期重叠。

---

### `sorokeep alerts`

管理告警配置。支持五个子命令。

#### `alerts add` — 创建新告警

```bash
sorokeep alerts add [options]
```

| 选项 | 说明 |
|------|------|
| `--contract <id>` | 要告警的合约 ID（必填） |
| `--type <type>` | `webhook` 或 `slack`（必填） |
| `--url <url>` | Webhook POST URL（webhook 类型必填） |
| `--channel <channel>` | Slack 频道名称或 ID（slack 类型必填） |
| `--threshold <ledgers>` | 当剩余 TTL 低于此值时触发（必填） |
| `--secret <secret>` | Webhook 的 HMAC 签名密钥（如省略则自动生成） |

对于 webhook 告警，如果你不提供密钥，系统会自动生成一个 HMAC 签名密钥（32 字节十六进制）。该密钥在创建时会显示一次——请妥善保存，以便在服务器上验证 webhook 签名。详情请参阅 [Webhook 签名](#webhook-签名)。

#### `alerts list` — 查看已配置的告警

```bash
sorokeep alerts list --contract <id>
```

#### `alerts remove` — 删除告警配置

```bash
sorokeep alerts remove --id <config-id>
```

#### `alerts test` — 发送测试告警

```bash
sorokeep alerts test --id <config-id>
```

通过真实的投递管道发送一个合成的 `threshold_crossed` 事件。适用于在上线前验证你的 webhook 端点或 Slack 频道是否配置正确。

#### `alerts history` — 查看历史告警活动

```bash
sorokeep alerts history --contract <id> [--limit 20]
```

显示已触发告警的表格：时间戳、条目标签、触发时的 TTL、频道类型、投递状态、重试次数和恢复时间。

---

### `sorokeep guard`

配置自动延长策略。启用后，守护进程将使用资金充足的 Stellar 密钥对提交 `ExtendFootprintTTLOp` 交易来自动延长 TTL。

```bash
sorokeep guard <contract-id> [options]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--target-ttl <ledgers>` | 要延长到的 TTL 值 | `100000` |
| `--threshold <ledgers>` | TTL 低于此值时触发延长 | `20000` |
| `--keypair <secret>` | Stellar 私钥（用于一次性延长） | — |
| `--keypair-env <var>` | 包含私钥的环境变量名 | — |
| `--auto-extend` | 启用守护进程自动延长（需要 `--keypair-env`） | — |
| `--dry-run` | 模拟延长操作并显示预计费用 | — |
| `--disable` | 禁用此合约的自动延长 | — |

**使用模式：**

```bash
# 查看当前策略
sorokeep guard <contract-id>

# 试运行——查看预计费用但不提交
sorokeep guard <contract-id> --keypair S... --dry-run

# 一次性立即延长
sorokeep guard <contract-id> --keypair S...

# 为守护进程启用自动延长
sorokeep guard <contract-id> --keypair-env STELLAR_SECRET_KEY --auto-extend

# 禁用自动延长
sorokeep guard <contract-id> --disable
```

**安全性：** 私钥永远不会存储在数据库中。使用 `--auto-extend` 时，只会持久化公钥和环境变量名。守护进程在运行时从环境中解析实际的私钥。

---

### `sorokeep costs`

查看合约的延长历史和租金支出。

```bash
sorokeep costs <contract-id> [options]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--period <days>` | 显示最近 N 天的费用 | `30` |
| `--all` | 显示所有历史记录 | — |

**输出包括：**

- 总延长次数和总费用（以 XLM 计）
- 按条目类型分类的明细（实例、wasm、持久存储），包含数量和费用
- 基于所选时间段外推的 30 天费用预测
- 最近延长记录表格：时间戳、条目标签、旧 TTL → 新 TTL、XLM 费用、交易哈希

---

### `sorokeep restore`

通过 `RestoreFootprintOp` 交易恢复已归档的账本条目。

```bash
sorokeep restore <contract-id> [options]
```

| 选项 | 说明 |
|------|------|
| `--keypair <secret>` | Stellar 私钥 |
| `--keypair-env <var>` | 包含私钥的环境变量 |
| `--entry <keyXdr>` | 要恢复的特定条目密钥 XDR（可重复） |
| `--all` | 恢复该合约的所有已追踪条目 |

`--keypair` 和 `--keypair-env` 二者必选其一。`--entry` 和 `--all` 二者必选其一（互斥）。

```bash
# 恢复特定条目
sorokeep restore <contract-id> --keypair-env STELLAR_SECRET_KEY --entry <base64-xdr>

# 恢复所有已追踪条目
sorokeep restore <contract-id> --keypair-env STELLAR_SECRET_KEY --all
```

---

### `sorokeep resources`

查看合约的资源使用日志（CPU 指令数、内存字节数、费用结构），以追踪随时间变化的执行效率。

---

### `sorokeep budget`

设置和监控合约的月度 XLM 延长预算。当合约需要频繁延长时，防止费用失控。

---

### `sorokeep channels`

管理资金充足的通道账户，用于并发提交延长和恢复交易，避免序列号瓶颈。

---

### `sorokeep inspect`

直接检查链上状态。可以解析 Stellar Asset Contract（SAC）代币余额、对比状态变更，以及解码 XDR，无需手动干预。

---

### `sorokeep check`

执行一次性的、临时的监控周期，无需启动长时间运行的守护进程。

---

### `sorokeep db`

数据库管理任务，包括迁移、备份和内省缓存管理。

---

### `sorokeep completion`

生成 bash/zsh 的 shell 自动补全脚本，为所有 Sorokeep 命令启用 Tab 补全。

## 告警

Sorokeep 通过多个渠道投递告警：**webhook**、**Slack**、**Discord**、**Telegram** 和 **PagerDuty**。每条告警包含严重程度级别和受影响条目的丰富上下文信息。Sorokeep 采用健壮的、解耦的检测和分发架构，使用基于数据库的队列。

### 告警生命周期

1. **阈值超过** — 在每个监控周期中，如果某个条目的剩余 TTL 低于配置的阈值，监控器会将一条 `threshold_crossed` 告警写入数据库队列。
2. **投递** — 分发器从队列中读取未投递的行，并将告警路由到配置的频道。投递失败会在后续周期重试，最多 5 次尝试，然后优雅地放弃。成功投递会将该行标记为已投递。
3. **恢复** — 当 TTL 恢复超过阈值时（例如延长后），Sorokeep 会向所有已配置的频道发送 `alert_resolved` 通知。

### 严重程度级别

严重程度根据剩余 TTL 相对于配置阈值的比例自动计算：

| 严重程度 | 条件 | 说明 |
|----------|------|------|
| **critical** | 剩余 TTL < 阈值的 25%，或 TTL = 0 | 条目面临立即归档的危险 |
| **warning** | 剩余 TTL 低于阈值但高于 25% | 条目需要尽快处理 |
| **info** | 告警已恢复（TTL 已恢复） | 条目已恢复健康状态 |

### Webhook 投递

Webhook 告警以 HTTP POST 请求的形式投递，包含 JSON 请求体：

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

### Webhook 签名

Webhook 请求在 `X-Sorokeep-Signature` 头中包含 HMAC-SHA256 签名，用于验证请求载荷：

```
X-Sorokeep-Signature: sha256=a1b2c3d4e5f6...
```

在你的服务器上验证：

```javascript
import { createHmac } from "node:crypto";

function verifySignature(payload, signature, secret) {
  const expected = "sha256=" + createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return signature === expected;
}
```

签名密钥在创建 webhook 告警时自动生成（你也可以通过 `--secret` 提供自己的密钥）。它在创建时会显示一次——请安全存储。

### Slack 投递

Slack 告警通过 [Slack Web API](https://api.slack.com/methods/chat.postMessage) 发送，使用 Block Kit 进行富文本格式化。消息包含严重程度图标、合约详情、剩余 TTL 和可操作的提示。

**设置步骤：**

1. 在 [api.slack.com/apps](https://api.slack.com/apps) 创建一个具有 `chat:write` 权限范围的 Slack 应用
2. 将应用安装到你的工作区，并复制 Bot User OAuth Token（`xoxb-...`）
3. 通过环境变量提供 token：

```bash
export SOROKEEP_SLACK_TOKEN=xoxb-your-bot-token
```

或者，将 token 存储在配置文件 `~/.sorokeep/config.yaml` 中：

```yaml
slackToken: "xoxb-your-bot-token"
```

环境变量优先于配置文件。

### 重试策略

失败的告警投递会在后续守护进程周期中自动重试。连续 **5 次失败** 后，该告警将被放弃，不再进行投递尝试。你可以通过 `sorokeep alerts history` 查看投递状态和重试次数。

## 工作原理

Sorokeep 是一个链下监控工具。它从 Stellar RPC 读取数据，将其本地存储在 SQLite 中，并据此执行操作（告警、自动延长、恢复）。它不在链上运行，也不要求你修改合约。

```
                         ┌─────────────────────┐
                         │    Stellar 网络     │
                         │  (testnet / mainnet) │
                         └──────────┬───────────┘
                                    │ RPC
                         ┌──────────▼───────────┐
                         │   Sorokeep    │
                         │                       │
                         │  ┌─────────────────┐  │
                         │  │  监控周期        │  │
                         │  │  (获取 TTL,      │  │
                         │  │   检测告警,      │  │
                         │  │   恢复)         │  │
                         │  └────────┬────────┘  │
                         │           │            │
                         │  ┌────────▼────────┐  │
                         │  │   分发器         │  │
                         │  │  (webhook/slack) │  │
                         │  └────────┬────────┘  │
                         │           │            │
                         │  ┌────────▼────────┐  │
                         │  │  自动延长        │  │
                         │  │  (防护策略)      │  │
                         │  └─────────────────┘  │
                         │                       │
                         │  ┌─────────────────┐  │
                         │  │   SQLite 数据库  │  │
                         │  │  ~/.soroban-     │  │
                         │  │   sorokeep/     │  │
                         │  │   sorokeep.db    │  │
                         │  └─────────────────┘  │
                         └───────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              ┌──────────┐  ┌────────────┐  ┌────────────┐
              │ Webhooks │  │   Slack    │  │   终端     │
              └──────────┘  └────────────┘  └────────────┘
```

### 守护进程周期

每次轮询间隔（默认：5 分钟），守护进程运行三个阶段：

1. **监控** — 对每个已注册的合约，从 RPC 获取最新 TTL，更新数据库，对照每个已配置的告警阈值检查每个条目。当 TTL 低于阈值时触发 `threshold_crossed`；当 TTL 恢复时触发 `alert_resolved`。

2. **投递** — 处理数据库队列中所有未投递的告警。将每条告警路由到其配置的频道（Webhook、Slack、Discord、Telegram、PagerDuty），标记成功的投递，在失败时增加重试计数器，并在 5 次重试后优雅放弃。

3. **自动延长** — 对于具有活跃防护策略的合约，检查哪些条目的 TTL 低于策略阈值，并通过 Stellar RPC 模拟 `ExtendFootprintTTLOp` 交易。如果模拟成功，则提交交易，记录确切的 XLM 费用，并更新合约的月度预算使用量以防止费用失控。

如需了解完整的数据流（确切的调用顺序、阶段间的故障隔离、新贡献通常落在何处），请参阅 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

### 存储

所有状态都是本地的。Sorokeep 将数据存储在 `~/.sorokeep/sorokeep.db`（启用 WAL 模式的 SQLite）。除 Stellar RPC 端点外无需外部服务。

**数据库表：**

| 表名 | 用途 |
|------|------|
| `contracts` | 已注册的合约，包含网络、名称、WASM 哈希 |
| `contract_entries` | 已追踪的账本条目，包含 TTL 和发现来源 |
| `extension_policies` | 每个合约的自动延长规则（阈值、目标值、密钥对引用） |
| `alert_configs` | 告警频道、阈值和 webhook 密钥 |
| `alerts_fired` | 已触发的告警记录，包含投递状态、重试次数和恢复追踪 |
| `extension_history` | 每次 TTL 延长记录，包含交易哈希和 XLM 费用 |

### 配置

Sorokeep 将用户配置存储在 `~/.sorokeep/config.yaml`：

```yaml
network: testnet
pollingIntervalSeconds: 300
slackToken: "xoxb-..."        # 可选——也可以使用 SOROKEEP_SLACK_TOKEN 环境变量
rpcUrl: "https://..."         # 可选——覆盖网络默认值
```

配置文件以 `0600` 权限（仅所有者可读写）创建，以保护 Slack token 等敏感值。

## 项目结构

```
sorokeep/
├── src/
│   ├── index.ts                 # CLI 入口点 (Commander.js)
│   ├── commands/                # CLI 命令处理器（薄展示层）
│   │   ├── watch.ts             # 合约注册
│   │   ├── status.ts            # TTL 健康状态展示
│   │   ├── daemon.ts            # 长时间运行的监控器
│   │   ├── alerts.ts            # 告警 CRUD + 测试 + 历史
│   │   ├── guard.ts             # 自动延长策略
│   │   ├── costs.ts             # 延长费用报告
│   │   └── restore.ts           # 已归档条目恢复
│   ├── core/                    # 业务逻辑（无 CLI 依赖）
│   │   ├── watch.ts             # 合约注册和发现
│   │   ├── monitor.ts           # 轮询周期、阈值检测、恢复
│   │   ├── extension.ts         # TTL 延长、自动延长、恢复、费用记录
│   │   └── discovery.ts         # 基于 Footprint 的存储密钥发现
│   ├── alerts/                  # 告警投递管道
│   │   ├── types.ts             # AlertEvent、AlertSeverity、buildAlertEvent
│   │   ├── dispatcher.ts        # 路由、重试逻辑、投递编排
│   │   ├── webhook.ts           # 带 HMAC-SHA256 签名的 HTTP POST
│   │   └── slack.ts             # Slack Web API + Block Kit 格式化
│   ├── daemon/                  # 守护进程生命周期
│   │   └── loop.ts              # 启动/停止、重入保护、周期编排
│   ├── rpc/                     # Stellar RPC 客户端封装
│   │   └── client.ts            # 实例/WASM 获取、批量 TTL、延长、恢复
│   ├── db/                      # 数据库层
│   │   ├── schema.sql           # 完整的 SQLite 架构
│   │   ├── database.ts          # 初始化、WAL 模式、在线迁移
│   │   └── repositories.ts      # 所有查询函数
│   ├── logging/                 # 结构化日志 (pino)
│   └── utils/                   # 配置加载器、TTL 格式化
├── tests/                       # 镜像 src/ 结构——66 个文件中包含 891 个测试
├── .github/workflows/           # CI（测试 + 类型检查）和发布
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── Dockerfile                   # Docker 容器定义
├── systemd/                     # 用于 Linux 部署的 systemd 服务模板
├── LICENSE
└── CONTRIBUTING.md
```

**架构分层：**

- **命令层** (`src/commands/`) — 薄 CLI 层。解析参数、调用核心、格式化终端输出。不含业务逻辑。
- **核心层** (`src/core/`) — 纯业务逻辑。可独立于网络或 CLI 进行测试。守护进程复用相同的函数。
- **RPC 层** (`src/rpc/`) — Stellar SDK 封装。所有网络调用通过此处。处理交易构建、模拟、签名和提交。
- **告警层** (`src/alerts/`) — 投递管道。频道特定的格式化和传输、路由、重试管理。
- **数据库层** (`src/db/`) — SQLite 仓储。所有查询集中在此。测试使用内存模式。

## 技术栈

| 包名 | 用途 |
|------|------|
| [TypeScript](https://www.typescriptlang.org/) | 应用语言 (ESM) |
| [@stellar/stellar-sdk](https://github.com/nicktomlin/js-stellar-sdk) | Stellar 和 Soroban RPC 交互 |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 本地数据库（同步、零外部依赖） |
| [Commander.js](https://github.com/tj/commander.js) | CLI 框架 |
| [pino](https://github.com/pinojs/pino) | 结构化 JSON 日志 |
| [chalk](https://github.com/chalk/chalk) / [ora](https://github.com/sindresorhus/ora) | 终端格式化和旋转动画 |
| [yaml](https://github.com/eemeli/yaml) | 配置文件解析 |
| [Vitest](https://vitest.dev/) | 测试框架 |

## 测试

```bash
# 运行所有测试
npm test

# 运行特定测试文件
npx vitest run tests/core/monitor.test.ts

# 监视模式
npx vitest
```

**891 个测试**分布在 **66 个测试文件**中，覆盖：

- **格式化** — TTL 转换、状态分类、人类可读时间
- **数据库** — CRUD、级联、upsert、去重、告警投递队列
- **RPC 客户端** — 合约实例、WASM 代码、批量 TTL 查询、交易模拟
- **观察** — 注册、重新观察、SAC 合约、错误处理、网络隔离、内省
- **监控周期** — TTL 刷新、阈值检测、告警去重、恢复、故障隔离、多阈值升级、部分 RPC 响应
- **延长** — TTL 延长、自动延长策略评估、恢复、费用记录、预算执行
- **告警分发器** — 频道路由、重试逻辑、最大重试次数限制、放弃的告警（Slack、Discord、Telegram、Webhook、PagerDuty）
- **Webhook** — HMAC-SHA256 签名、超时处理、HTTP 错误响应
- **Slack** — Token 解析、Block Kit 结构、`body.ok` 验证
- **CLI 命令** — Alerts、budget、guard、costs、watch、status、daemon、check、restore、db、channels
- **配置** — 加载/保存、默认值、解析失败处理、文件权限
- **守护进程** — 启动/停止、重入保护、周期错误隔离
- **MCP 服务器** — 所有暴露的 MCP 工具的测试覆盖

所有测试使用内存 SQLite 数据库和模拟的 RPC 响应——无网络调用、无文件系统副作用。全程实践 TDD。

## 常见问题

### 为什么选择 TypeScript，而不是 Rust？

Sorokeep 是一个链下运维工具，而非智能合约。选择 TypeScript 的原因如下：

1. Stellar JS SDK 是 Soroban RPC 交互中最完整的客户端库
2. Soroban 开发者已经在其工具链中使用 Node.js
3. npm 分发意味着零摩擦安装
4. 性能要求（定期 RPC 轮询）完全在 Node.js 的能力范围内
5. 最大化贡献者池——大多数 Soroban 开发者都了解 TypeScript

### 我的私钥会被存储在任何地方吗？

不会。当你使用 `--keypair-env` 配置自动延长时，Sorokeep 仅在数据库中存储 **公钥** 和 **环境变量名**。实际的私钥在运行时从你的环境中解析。如果你使用 `--keypair` 执行一次性操作，密钥仅在内存中使用，永远不会被持久化。

### 如果守护进程在周期中途崩溃会怎样？

每个阶段（监控、投递、自动延长）都包裹在独立的错误处理中。一个阶段的失败不会阻止其他阶段的运行。告警投递是幂等的——如果一次投递已被标记为成功，它不会被重复发送。如果守护进程重启，未投递的告警将在下一个周期被拾取。

### 支持哪些网络？

Testnet（`https://soroban-testnet.stellar.org`）和 Mainnet（`https://mainnet.sorobanrpc.com`）。你也可以通过 `--rpc-url` 将 Sorokeep 指向任何自定义 RPC 端点。

### 关于邮件告警呢？

邮件告警尚未实现。CLI 会拒绝 `--type email` 并给出清晰的错误信息。目前支持的频道是 Webhook 和 Slack。

## 路线图

- 告警频道的插件接口——使新频道（Matrix、MS Teams、邮件）无需修改核心分发代码或数据库架构
- 适用于已有可观测性技术栈的团队的 Prometheus `/metrics` 端点
- 可复用的 GitHub Action，封装 `sorokeep check`，用于 CI 集成的 TTL 检查
- 用于可视化 TTL 监控的 Web 仪表板
- 多合约批量操作

## 参与贡献

欢迎参与贡献。请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解指南，[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 了解系统运行时的工作原理，以及 [SECURITY.md](SECURITY.md) 了解如何报告漏洞。本项目遵循 [行为准则](CODE_OF_CONDUCT.md)。

## 许可证

[MIT](LICENSE)

## 作者

**Abdulmalik Alayande**

- GitHub: [@AbdulmalikAlayande](https://github.com/AbdulmalikAlayande)
- X: [@The_good_man02](https://twitter.com/The_good_man02)
