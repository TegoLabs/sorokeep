# Configuration Reference

This document provides a complete reference of all supported fields in the `~/.sorokeep/config.yaml` file and related environment variables.

| Field Name | Type | Default | Description | Read By | Environment Override |
|---|---|---|---|---|---|
| `network` | string | `"testnet"` | Default Stellar network to use. | `daemon`, `watch`, config | None |
| `rpcUrl` | string | (none) | Default RPC URL override. | `daemon`, `watch` | None |
| `pollingIntervalSeconds` | number | `300` | Default polling interval in seconds for the daemon. | `daemon` | None |
| `slackToken` | string | (none) | Slack bot token for Slack alert delivery. | `slack` config | None |
| `telegramBotToken` | string | (none) | Telegram bot token. | `telegram` | `SOROKEEP_TELEGRAM_BOT_TOKEN` |
| `templatesPath` | string | (none) | Directory containing custom Handlebars templates. | `alerts/templates` | None |
| `monthlyBudgetXlm` | number | (none) | Monthly rent budget in XLM to trigger warnings. | `costs` | None |
| `rpcCertificateFingerprint` | string | (none) | SHA-256 fingerprint (hex) of the RPC server's TLS certificate. | `rpc` | None |
| `vault.url` | string | (none) | HashiCorp Vault server URL. | `vault`, `extension` | None |
| `vault.token` | string | (none) | Vault authentication token. | `vault`, `extension` | None |
| `vault.namespace` | string | (none) | Optional Vault namespace (for Vault Enterprise). | `vault`, `extension` | None |
| `feeSponsorSecret` | string | (none) | Secret key of the fee sponsor account. | `daemon`, `extension` | None |
| `mcp.mode` | string | `"read-only"` | MCP server permission mode: `read-only` refuses tools that change state, `read-write` allows every registered tool. Unrecognised values fall back to `read-only`. | `mcp` | None |
| `smtp.host` | string | (none) | SMTP server hostname for email alert delivery. | `email` | `SOROKEEP_SMTP_HOST` |
| `smtp.port` | number | (none) | SMTP server port. | `email` | `SOROKEEP_SMTP_PORT` |
| `smtp.user` | string | (none) | SMTP authentication username. | `email` | `SOROKEEP_SMTP_USER` |
| `smtp.pass` | string | (none) | SMTP authentication password. | `email` | `SOROKEEP_SMTP_PASS` |

## Environment-only settings

These are not `config.yaml` fields — they're read directly from the environment and have no YAML equivalent, but are configuration inputs in the same sense.

| Environment Variable | Type | Description | Read By |
|---|---|---|---|
| `SOROKEEP_MATRIX_ACCESS_TOKEN` | string | Matrix access token for Matrix alert delivery. Takes priority over any config-based token. | `matrix` |
| `SOROKEEP_MATRIX_HOMESERVER` | string | Matrix homeserver URL. | `matrix` |
| `SOROKEEP_METRICS_TOKEN` | string | Bearer token required to access the `/metrics` and MCP HTTP endpoints, if set. | `observability/server` |
| `SOROKEEP_OTLP_ENDPOINT` | string | OpenTelemetry OTLP exporter endpoint for traces. | `observability/tracing` |
| `SOROKEEP_OTLP_IN_MEMORY` | boolean | When `"true"`, uses an in-memory span exporter instead of OTLP (used in tests). | `observability/tracing` |

## RPC Certificate Pinning

If you are running sorokeep against a private RPC endpoint with elevated trust requirements, you can optionally enable TLS certificate pinning. This helps prevent man-in-the-middle attacks or compromised Certificate Authorities by rejecting connections to an RPC endpoint unless the presented certificate matches a specified SHA-256 fingerprint.

### How to obtain the fingerprint

You can fetch the current SHA-256 fingerprint of your RPC server using OpenSSL. Run this command, replacing `your-rpc-endpoint.com` with your endpoint host:

```bash
echo -n | openssl s_client -connect your-rpc-endpoint.com:443 2>/dev/null | openssl x509 -noout -fingerprint -sha256
```

This will output something like:
`SHA256 Fingerprint=8A:73:90...`

Take the hexadecimal portion and add it to your `~/.sorokeep/config.yaml`:
```yaml
rpcCertificateFingerprint: "8A:73:90..."
```
