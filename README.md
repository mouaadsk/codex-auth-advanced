# Codex Auth Advanced

[![latest release](https://img.shields.io/github/v/release/mouaadsk/codex-auth-advanced?sort=semver&label=latest)](https://github.com/mouaadsk/codex-auth-advanced/releases/latest)
[![latest pre-release](https://img.shields.io/github/v/release/mouaadsk/codex-auth-advanced?include_prereleases&sort=semver&filter=*-*&label=pre-release)](https://github.com/mouaadsk/codex-auth-advanced/releases)

`codex-auth-advanced` manages multiple Codex, Claude Code, and OpenAI-compatible API accounts from one local installation. This fork adds a stable loopback provider proxy, managed account groups, API-key switching, Anthropic Messages compatibility, pinned routes for secondary clients, VSLLM model routing, exact New API subscription-window tracking, resilient compact requests, and graceful proxy restarts.

This repository is maintained as a local macOS checkout. It is not currently published as a general npm release.

## Contents

- [Capabilities](#capabilities)
- [How It Works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Command Reference](#command-reference)
- [Account Storage](#account-storage)
- [Provider Proxy](#provider-proxy)
- [Claude Code](#claude-code)
- [VSLLM Integration](#vsllm-integration)
- [Automatic Switching](#automatic-switching)
- [OpenClaw and Pinned Routes](#openclaw-and-pinned-routes)
- [Operations](#operations)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Current Limitations](#current-limitations)

## Capabilities

- Store and switch between ChatGPT/Codex authentication snapshots.
- Store OpenAI-compatible API-key accounts with independent provider URLs.
- Keep Codex pointed at one stable localhost URL while the active upstream account changes.
- Point Claude Code at the same proxy through the Anthropic Messages API.
- Organize accounts into independent `CODEX_HOME` groups.
- Launch `codext` with the model and reasoning settings from the selected group.
- Give OpenClaw or another client a route pinned to one API account.
- Preserve requested models and reasoning effort through the proxy.
- Route selected Codex model names to current VSLLM model IDs.
- Keep official Claude models on Claude Code OAuth while exposing clearly labeled VSLLM alternatives in the same picker.
- Discover every VSLLM model that advertises Anthropic Messages support, and bridge selected Responses-only models for Claude Code.
- Send compact requests to the provider-native compact endpoint with a local fallback.
- Read authoritative VSLLM/New API subscription usage and exact reset timestamps.
- Retry transient VSLLM usage-limit responses without immediately exhausting an available account.
- Drain active HTTP streams before restarting the proxy.

## How It Works

The project has four runtime layers:

1. **Vendored account manager**

   The native `codex-auth-advanced` binary handles the original account registry, login, import, grouping, and ChatGPT usage workflows.

2. **JavaScript composition wrapper**

   [`bin/codex-auth-advanced-wrapper.js`](bin/codex-auth-advanced-wrapper.js) validates the runtime, composes the services under [`src/`](src/), adapts arguments, and delegates to either a wrapper command or the vendored binary. Provider, account, client, and manager behavior lives in focused modules rather than in the entrypoint.

3. **Provider proxy**

   The proxy listens on `127.0.0.1:47778` by default. Codex and Claude Code use stable local base URLs while the proxy reads the active account from its registry for each request.

4. **Background manager**

   When auto-switching is enabled, one manager refreshes usage for all enabled groups every 30 seconds and switches away from exhausted active accounts.

ChatGPT account switches normally require restarting the Codex client so it reloads credentials. API-to-API switches can remain hot after Codex has been configured to use the local proxy. `codext` can launch against a selected group and carry its current model configuration into resumed sessions.

### Source Architecture

| Module | Responsibility |
| --- | --- |
| `src/storage.mjs` | Private file writes, account paths, managed group paths, JSON/text reads, and backups. |
| `src/codex-config.mjs` | TOML parsing/merging, API account templates, and Codex provider configuration. |
| `src/codex-model-catalog.mjs` | Installed Codex catalog discovery and removal of retired VSLLM picker entries. |
| `src/provider-policy.mjs` | Provider error classification, VSLLM subscription windows, spend state, retries, and model aliases. |
| `src/provider-client.mjs` | Provider health, billing, New API dashboard access, and dashboard credential lookup. |
| `src/claude-gateway.mjs` | Claude gateway model discovery metadata and per-model upstream wire protocol. |
| `src/claude-responses-bridge.mjs` | Claude Messages to OpenAI Responses request, response, tool-use, token-count, and SSE translation. |
| `src/proxy-transforms.mjs` | Request rewriting, compressed JSON decoding, encrypted-content repair, SSE normalization, and compact fallback. |
| `src/provider-proxy.mjs` | Route parsing, pinned/default targeting, HTTP/WebSocket transport, failover orchestration, streaming, and graceful lifecycle. |
| `src/account-service.mjs` | Registry loading, account selection, target resolution, exhaustion mutation, and account activation. |
| `src/client-config.mjs` | Codex and Claude Code configuration through the local proxy. |
| `src/cli-service.mjs` | Wrapper-owned account, usage, dashboard, auto-switch, list, and proxy commands. |
| `src/manager-service.mjs` | Background manager lifecycle, macOS LaunchAgent handling, and status augmentation. |

Keep new domain behavior in the owning module. The wrapper should remain limited to composition, launch argument handling, help/version adaptation, native binary resolution, and final dispatch.

## Requirements

- Node.js 22 or newer.
- The OpenAI Codex CLI for login and normal Codex workflows.
- Claude Code 2.1.170 or newer when using Fable 5.
- macOS arm64 for the vendored binary currently included in this checkout.

Install Codex if needed:

```shell
npm install -g @openai/codex
```

The wrapper can support another platform when a matching native binary is added under:

```text
vendor/<platform>-<arch>/bin/
```

## Installation

The macOS installer is idempotent and can be run directly from a clone:

```shell
cd /path/to/codex-auth-advanced
./scripts/install.zsh
```

It:

1. Runs `npm link` for the local CLI.
2. Configures Codex when it is installed and an API-key account is active.
3. Configures Claude Code when it is installed, preserving unrelated settings and creating backups before changes.
4. Installs a per-user launchd service that starts the proxy at login and restarts it after crashes or graceful reloads.

Preview the actions without changing the system:

```shell
./scripts/install.zsh --dry-run
```

For manual CLI-only installation:

```shell
cd /path/to/codex-auth-advanced
npm link
```

Confirm that the global command points to this repository:

```shell
which codex-auth-advanced
realpath "$(which codex-auth-advanced)"
codex-auth-advanced --version
```

Remove the local link with:

```shell
npm uninstall -g codex-auth-advanced
```

Windows installation is intentionally postponed; see [`task.md`](task.md).

## Quick Start

### Add A Codex Account

```shell
codex-auth-advanced login
```

Device authentication is also supported:

```shell
codex-auth-advanced login --device-auth
```

### Add An API-Key Account

Use stdin so the key is not included in the command arguments:

```shell
printf '%s' "$OPENAI_API_KEY" | \
  codex-auth-advanced add-api-key \
    --template openai \
    --alias openai-main \
    --stdin
```

For VSLLM, provide its OpenAI-compatible base URL and optional local display cap:

```shell
printf '%s' "$VSLLM_API_KEY" | \
  codex-auth-advanced add-api-key \
    --template openai \
    --base-url https://vsllm.com/v1 \
    --alias vsllm-main \
    --api-spend-limit-usd 55 \
    --stdin
```

### Start The Proxy

```shell
./scripts/start-proxy.zsh
```

### List And Switch

```shell
codex-auth-advanced list
codex-auth-advanced list --live
codex-auth-advanced switch
codex-auth-advanced switch <alias-or-account-key>
```

## Command Reference

Run the built-in help for the complete upstream command set:

```shell
codex-auth-advanced --help
codex-auth-advanced <command> --help
```

The wrapper adds or extends the commands below.

### Accounts

| Command | Purpose |
| --- | --- |
| `list [--live] [--api\|--skip-api]` | List accounts; live mode refreshes continuously. |
| `status` | Show auto-switch, service, API mode, and active-account status. |
| `login [--device-auth] [--group <name>]` | Run Codex login and save the resulting account. |
| `switch [--live] [--auto]` | Open the account picker; optional live monitoring. |
| `switch <query>` | Switch by row, alias, email, or account-key match. |
| `remove <query>...` | Remove selected stored accounts. |
| `remove --all` | Remove all accounts in the selected registry. |

### Import And API Keys

| Command | Purpose |
| --- | --- |
| `import <path> [--alias <name>]` | Import one auth file or a directory. |
| `import --cpa [<path>]` | Import CLIProxyAPI token JSON. |
| `import --purge [<path>]` | Rebuild `registry.json` from auth files. |
| `add-api-key --template <name> --alias <name> --stdin` | Add or update an API-key account. |
| `config api-spend-limit <account> <amount>` | Set a local dollar cap for an API-key account. |

Supported direct-add templates are `openai`, `codex-everywhere`, and `tcdmx`. A custom `--base-url` can be supplied with the `openai` template.

Generated API-provider configs currently default to:

```toml
model_context_window = 320000
model_auto_compact_token_limit = 250000
```

The current top-level `model`, `review_model`, and `model_reasoning_effort` values are preserved when an API account is created or switched.

### Groups And Projects

| Command | Purpose |
| --- | --- |
| `group list` | List managed groups and their `CODEX_HOME` paths. |
| `group create <name> [<account>...]` | Create a group and optionally copy accounts into it. |
| `group <name> login [--device-auth]` | Add a Codex account directly to a group. |
| `group <name> add-api-key ...` | Add an API-key account directly to a group. |
| `group <name> add\|copy\|move <account>...` | Copy or move accounts between groups. |
| `group <name> switch ...` | Switch inside one group. |
| `group <name> config ...` | Configure one group. |
| `group <name> launch [resume [session]]` | Launch `codext` with that group. |
| `project set-group <name>` | Remember the group for the current project. |
| `launch [resume [session]]` | Launch with the remembered group or `default`. |

The `default` group maps to `~/.codex`. Additional groups normally live under:

```text
~/codex-auth-advanced/groups/<name>/
```

### Proxy

| Command | Purpose |
| --- | --- |
| `proxy status` | Check the local proxy. |
| `proxy start` | Start the proxy when it is stopped. |
| `proxy serve` | Run the proxy in the foreground. |
| `proxy url [account]` | Print the default route or a route pinned to one account. |
| `proxy urls` | List pinned URLs for every API-key account. |

For normal operations, prefer the lifecycle scripts described in [Operations](#operations).

### Client Configuration

| Command | Purpose |
| --- | --- |
| `configure [all]` | Configure Codex and Claude Code; `all` is the default when omitted. |
| `configure codex` | Point Codex at the default proxy route for its active API-key account. |
| `configure claude` | Merge the Claude Code gateway settings and independent VSLLM model discovery into `~/.claude/settings.json`. |

## Account Storage

The default account files are stored under:

```text
~/.codex/accounts/
```

Important files include:

| Path | Contents |
| --- | --- |
| `registry.json` | Non-secret account metadata, active account, usage state, groups, and auto-switch settings. |
| `<account-key>.auth.json` | ChatGPT tokens or an API provider key. |
| `<account-key>.config.toml` | Per-account Codex/provider configuration. |
| `provider-dashboard/<hash>.json` | Private dashboard credentials linked by provider origin and numeric user ID. |

Credential files and the registry are written with mode `0600`; credential directories use mode `0700`.

API account keys are identified internally by a stable SHA-256-derived `account_key`. Editable aliases are used for display and command selection, not as credential identities.

## Provider Proxy

### Default Route

The default proxy route follows the active account in a group:

```text
http://127.0.0.1:47778/_codex-auth-advanced/<group-id>
```

When an API account is activated, the root Codex config points its OpenAI base URL at this local route. Codex and Claude Code append their wire-protocol paths; the proxy normalizes `/v1` before forwarding. The real upstream URL remains in the per-account config.

### Pinned Route

A pinned route always uses one stored API account:

```text
http://127.0.0.1:47778/_codex-auth-advanced/<group-id>/accounts/<account-key>/v1
```

Generate it instead of constructing it manually:

```shell
codex-auth-advanced proxy url <account-key-or-alias>
```

Pinned routes:

- Preserve provider-specific model remapping.
- Replace the caller's placeholder authorization with the stored API key.
- Never change the group's active Codex account.
- Never fail over to another account.

### Control Endpoints

The proxy exposes loopback-only operational endpoints:

```text
GET  /_codex-auth-advanced/health
POST /_codex-auth-advanced/restart
```

The health response includes the proxy start time, restart state, active request count, and active upgrade count.

### Configuration

| Environment variable | Default |
| --- | --- |
| `CODEX_AUTH_ADVANCED_PROXY_HOST` | `127.0.0.1` |
| `CODEX_AUTH_ADVANCED_PROXY_PORT` | `47778` |
| `CODEX_AUTH_ADVANCED_CHATGPT_BASE_URL` | `https://chatgpt.com/backend-api/codex` |
| `CODEX_AUTH_ADVANCED_ANTHROPIC_BASE_URL` | `https://api.anthropic.com` |

Keep the proxy on loopback unless inbound authentication is added. The proxy route itself is not designed to be exposed directly to a LAN or the internet.

## Codex Model Selection

Configure Codex after installation or whenever Codex adds updated model metadata:

```shell
codex-auth-advanced configure codex
```

The command reads the model catalog bundled with the installed Codex CLI, preserves each model's supported reasoning efforts and tool behavior, removes retired VSLLM Pro20x entries, and sets `model_catalog_json` in `~/.codex/config.toml`. The generated catalog is stored at:

```text
~/.codex/model-catalogs/codex-auth-advanced.json
```

Start a new Codex process after configuration because Codex loads `model_catalog_json` only at startup. Open `/model` to choose among these independent routes:

| Picker entry | VSLLM request model |
| --- | --- |
| `gpt-5.6-sol` | `gpt-5.6-sol` |
| `gpt-5.6-terra` | `gpt-5.6-terra` |
| `gpt-5.6-luna` | `gpt-5.6-luna` |

The selected ID is preserved for regular responses, compact requests, compact fallback, and subagent requests.

## Claude Code

Configure both installed clients, or select one explicitly:

```shell
codex-auth-advanced configure
codex-auth-advanced configure all
codex-auth-advanced configure codex
codex-auth-advanced configure claude
```

The macOS installer configures both installed clients and the launchd service:

```shell
./scripts/install.zsh
```

The command backs up an existing `~/.claude/settings.json`, preserves unrelated settings, removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` overrides that would bypass Claude Code OAuth, and sets:

```text
ANTHROPIC_BASE_URL=<default codex-auth-advanced proxy route>
ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

The command also removes `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` when present because that setting suppresses Claude Code's gateway-model support. It refreshes `~/.claude/cache/gateway-models.json` through the local proxy with the current VSLLM catalog, without persisting a Claude API key or marker token. The proxy preserves Claude Code's OAuth headers for official Anthropic requests. It removes caller authentication only when routing a selected VSLLM model, then injects the stored VSLLM key.

Start a new Claude Code process after configuration or a VSLLM catalog change. Claude Code loads gateway choices from this cache for the lifetime of the process. Run `codex-auth-advanced configure claude` again to refresh the VSLLM choices.

Open the interactive model picker:

```text
/model
```

The picker merges two live catalogs without replacing either one:

| Picker entry | Destination |
| --- | --- |
| `Claude Fable 5` | Official Anthropic `claude-fable-5` using Claude Code OAuth |
| `VSLLM: claude-fable-5` | VSLLM `claude-fable-5` using the stored VSLLM API key |
| `VSLLM: claude-fake-5` | VSLLM `claude-fake-5` using the stored VSLLM API key |
| `VSLLM: kimi-k3` | VSLLM `kimi-k3` using the native Anthropic Messages endpoint |
| `VSLLM: grok-4.5` | VSLLM `grok-4.5` through the Responses bridge |

Official Claude Code entries remain first-party picker choices and use Claude Code OAuth. The cache contains only VSLLM entries, built from every live `/v1/models` item whose `supported_endpoint_types` includes `anthropic`; the bridge also adds VSLLM's Responses-only `grok-4.5`. This is data-driven, so running `configure claude` refreshes newly available Anthropic-compatible VSLLM models without maintaining a static allowlist.

Claude Code only accepts discovered IDs beginning with `claude` or `anthropic`, so each VSLLM picker choice has a reversible internal `claude-vsllm-...` ID while its display name remains `VSLLM: <actual-model-id>`. That namespace is what lets official and VSLLM versions of Fable coexist. Kimi K3 and Grok 4.5 retain a `[1m]` suffix so Claude Code budgets their 1M context windows; the suffix is removed before forwarding upstream.

Native VSLLM entries use `/v1/messages`. Grok 4.5 is translated in-process from Claude Messages to `/v1/responses`. The bridge converts system and conversation content, images, thinking configuration, tools, tool choices, tool calls, and tool results. Streaming Responses events are converted back into Anthropic `message_start`, content-block, `message_delta`, and `message_stop` events; non-stream responses are converted into Anthropic message JSON. Account selection, pinned routes, exhaustion detection, retries, and failover remain owned by the same provider proxy.

For bridged models, `/v1/messages/count_tokens` is estimated locally so context accounting does not consume a paid VSLLM request. Native VSLLM models are forwarded to their provider endpoint unchanged. Claude session and agent headers are retained across the bridge, while Anthropic protocol headers are removed from the OpenAI Responses upstream request.

The bridge architecture is informed by the MIT-licensed [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) Claude-to-Codex translator. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Do not restore `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` if the independent gateway models must remain visible in `/model`.

## VSLLM Integration

### Model Routing

For VSLLM accounts, the selected GPT-5.6 tier is forwarded unchanged. The older GPT-5.2 compatibility alias remains rewritten:

| Codex request | VSLLM responses request | VSLLM compact request |
| --- | --- | --- |
| `gpt-5.2` | `gpt-5.5` | `gpt-5.5-openai-compact` |
| `gpt-5.6-sol` | `gpt-5.6-sol` | `gpt-5.6-sol` |
| `gpt-5.6-terra` | `gpt-5.6-terra` | `gpt-5.6-terra` |
| `gpt-5.6-luna` | `gpt-5.6-luna` | `gpt-5.6-luna` |

Retired Pro20x IDs are normalized to their normal-model equivalents for existing sessions. Other model names pass through unchanged.

Claude model routing is separate from the Codex table:

| Claude Code selection | Upstream model | Upstream endpoint |
| --- | --- | --- |
| Official `claude-fable-5` | Official `claude-fable-5` | `https://api.anthropic.com/v1/messages` with Claude Code OAuth |
| `VSLLM: claude-fable-5` | VSLLM `claude-fable-5` | VSLLM `/v1/messages` |
| `VSLLM: claude-fake-5` | VSLLM `claude-fake-5` | VSLLM `/v1/messages` |
| `VSLLM: kimi-k3` | VSLLM `kimi-k3` | VSLLM `/v1/messages` |
| `VSLLM: grok-4.5` | VSLLM `grok-4.5` | VSLLM `/v1/responses` through the Claude bridge |

The request's `reasoning.effort` or `reasoning_effort` value is preserved. During local compact fallback, the same value is forwarded as `reasoning_effort` to the fallback completion request.

### Compact Requests

Codex compact requests are sent to:

```text
/v1/responses/compact
```

The proxy first uses the provider-native endpoint. If it is missing, unavailable, or times out, the proxy creates a summary through `/v1/chat/completions` and returns it in Codex compact-response format.

For provider/account transitions that cannot decrypt earlier reasoning state, the compatibility path can remove encrypted reasoning content and retry with plaintext conversation content. Normal response requests remain pass-through apart from model rewriting and required header normalization.

### Exact Subscription Windows

VSLLM is based on New API. A model API key can report cumulative billing totals, but it cannot query the authenticated subscription reset state. Configure a dashboard system access token for each VSLLM user so the wrapper can use:

```text
GET https://vsllm.com/api/subscription/self
```

The response supplies authoritative fields such as:

- `used_percent`
- `last_reset_time`
- `next_reset_time`
- `end_time`
- active subscription count
- billing preference

This avoids treating a cumulative provider total as spending from the latest 5-hour or 8-hour reset window.

### Obtain Dashboard Credentials

1. Sign in to the VSLLM dashboard account.
2. Open `https://vsllm.com/console/personal`.
3. Under account security, generate or regenerate the **System Access Token**.
4. In the browser console, read the numeric user ID:

```javascript
JSON.parse(localStorage.getItem('user') || '{}').id
```

5. Configure the account locally:

```shell
codex-auth-advanced config vsllm-dashboard \
  --user-id <numeric-user-id> \
  --alias <dashboard-alias>
```

The terminal asks for the dashboard token with hidden input. Do not put it in the command line or in this repository.

The setup command:

- Authenticates `/api/subscription/self`.
- Fetches the dashboard's masked API-token list.
- Compares masked values against local keys without sending local model keys to the dashboard.
- Links the dashboard identity to the matching stable API account key.
- Stores the access token only in a private credential file.

For VSLLM, `https://vsllm.com` and `https://api.vsllm.com` are treated as the same official provider identity. A dashboard credential stored for either hostname refreshes the subscription state for model requests sent through the other.

Use `--account <selector>` only if masked-key matching finds multiple local candidates. Use `--origin <url>` for another New API deployment. `--stdin` and `CODEX_AUTH_ADVANCED_VSLLM_ACCESS_TOKEN` are available for non-interactive automation, but the hidden prompt is preferred.

### Subscription Availability Rules

For `billing_preference = "subscription_only"`, an account is considered exhausted when:

- There are no active subscriptions, or
- Every active, non-unlimited subscription reports `used_percent >= 100`.

If any active subscription is unlimited or below 100%, the account remains usable. When a reset makes a subscription available again, the next refresh clears the exhausted state and returns the account to the candidate pool.

The manager does not proactively switch back to a newly reset account while the current account remains usable. It becomes available for the next required switch.

When dashboard credentials have never been configured, VSLLM usage falls back to the older local rolling estimate based on cumulative billing changes. That fallback is less authoritative and should not be preferred for fixed New API subscription windows.

After a dashboard identity has been configured successfully, a temporary dashboard outage does not reactivate the rolling estimate. The wrapper preserves the last authoritative subscription state until a later dashboard refresh succeeds.

## Automatic Switching

Auto-switching is disabled by default.

```shell
codex-auth-advanced config auto enable
codex-auth-advanced config auto disable
```

For a managed group:

```shell
codex-auth-advanced group <name> auto enable
codex-auth-advanced group <name> auto disable
```

### Scheduled Manager Behavior

The manager refreshes all enabled groups every 30 seconds.

- ChatGPT accounts use their configured 5-hour and weekly thresholds.
- API-key accounts switch only when their tracked provider state is exhausted.
- VSLLM dashboard-linked accounts use exact active-subscription availability.
- Exhausted candidates are skipped.
- A newly reset account becomes eligible but does not force failback.

Configure ChatGPT thresholds with:

```shell
codex-auth-advanced config auto --5h <percent> --weekly <percent>
```

On macOS, the manager uses LaunchAgent label:

```text
com.mouaadsk.codex-auth-advanced.manager
```

### Request-Time Behavior

For VSLLM, the proxy distinguishes hard exhaustion from transient responses:

- `You've hit your usage limit. Try again later.` and equivalent HTTP 429 responses are retried once on the same account while subscription quota remains available.
- The Chinese temporary subscription-unavailable response is treated the same way when provider subscription data says the account remains usable.
- HTTP 503 responses with `error.code = "server_is_overloaded"` or `"slow_down"` are retried three times on the same account with 1s, 2s, and 4s backoff.
- After the same-account retry, a normal non-pinned route can try another usable account when auto-switching is enabled.
- Model-capacity responses do not mark an account exhausted; unrelated HTTP 503 responses are not repeatedly sent to the same account.
- A direct no-active-subscription rejection is treated as authoritative hard exhaustion and can trigger immediate failover on the default route.
- Pinned routes never fail over.

## OpenClaw And Pinned Routes

Use a pinned route when OpenClaw must stay on one VSLLM account while Codex uses another:

```shell
codex-auth-advanced proxy url <openclaw-account>
```

Example OpenClaw provider configuration:

```json5
{
  agents: {
    defaults: {
      model: { primary: "codex-auth-vsllm/gpt-5.6-terra" },
      models: {
        "codex-auth-vsllm/gpt-5.6-terra": { alias: "Terra" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      "codex-auth-vsllm": {
        baseUrl: "<output of: codex-auth-advanced proxy url <account>>",
        apiKey: "local-codex-auth-advanced",
        api: "openai-completions",
        timeoutSeconds: 300,
        models: [
          {
            id: "gpt-5.6-terra",
            name: "GPT-5.6 Terra",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 320000,
            maxTokens: 32768,
          },
        ],
      },
    },
  },
}
```

The marker `apiKey` is not sent upstream; the local proxy replaces it with the stored account key. Do not append another `/v1` because the generated URL already includes it.

A pinned route prevents OpenClaw requests from changing Codex's active account. It does not reserve that account from the scheduled Codex candidate pool. Put exclusive clients in separate groups or keep auto-switch disabled for a shared group when strict ownership is required.

## Operations

### Start A Stopped Proxy

```shell
./scripts/start-proxy.zsh
```

The script is idempotent. If the proxy is already healthy, it reports the existing process instead of starting another one.

### Restart A Running Proxy

```shell
./scripts/restart-proxy.zsh
```

The restart script:

1. Requests a loopback graceful restart.
2. Stops accepting new work.
3. Waits for active requests and upgraded connections to drain.
4. Lets the installed launchd supervisor start the replacement, or starts a detached replacement when no service is installed.
5. Verifies the replacement health endpoint.

Never use `kill`, `pkill`, or direct process termination to restart the provider proxy. Doing so can cut an in-flight Codex stream and leave the current session blocked.

If the running proxy predates graceful restart support, the restart script refuses to terminate it. Wait until the session is idle before replacing that legacy process.

### Logs

The macOS launchd service writes output to:

```text
~/Library/Logs/codex-auth-advanced/proxy.log
~/Library/Logs/codex-auth-advanced/proxy.error.log
```

An unmanaged detached proxy writes output to:

```text
scratch/proxy.log
```

Authorization headers and dashboard tokens are not intentionally logged. Treat the log as local operational data and do not commit `scratch/`.

### Health Check

```shell
curl -sS http://127.0.0.1:47778/_codex-auth-advanced/health
```

### Rebuild Account Metadata

```shell
codex-auth-advanced import --purge
```

This rebuilds `registry.json` from existing account auth files. API metadata maintained by the wrapper is preserved when possible.

## Testing

Run the complete syntax and integration suite:

```shell
npm test
```

The test suite covers:

- Direct storage, TOML, provider-policy, transform, routing, account-selection, and client-configuration contracts.
- Proxy model remapping and reasoning-effort forwarding.
- Claude Fable/Kimi native routing, Grok Responses bridging, local token counting, model discovery, tools, and streaming/non-stream conversion.
- Native and fallback compaction.
- Encrypted-content compatibility repair.
- Pinned account routing.
- Transient usage-limit retry and failover behavior.
- Hard subscription exhaustion behavior.
- Graceful restart draining.
- Dashboard-token storage and masked-key account discovery.
- Exact subscription reset and multi-window usage persistence.
- Idempotent macOS client/service installation.
- launchd-managed graceful proxy replacement.

## Troubleshooting

### The Proxy Is Stopped

```shell
./scripts/start-proxy.zsh
```

Do not use the restart script as a process killer. It intentionally protects active streams.

### Official Claude Models Are Unavailable

Official Claude choices require a current Claude Code OAuth login. Check it with:

```shell
claude auth status
```

If it reports `loggedIn: false`, sign in again and start a new Claude Code process:

```shell
claude auth login
```

### Code Changed But Runtime Behavior Did Not

Reload a running proxy gracefully:

```shell
./scripts/restart-proxy.zsh
```

### `Stream disconnected before completion`

Check proxy health and the proxy log. Common causes include upstream SSE termination, a provider timeout, compressed stream handling, or a proxy process being terminated while a request is active.

```shell
curl -sS http://127.0.0.1:47778/_codex-auth-advanced/health
tail -n 100 scratch/proxy.log
```

Always use the graceful restart script when reloading proxy code.

### VSLLM Shows The Wrong Exhaustion State

Confirm that the account has dashboard metadata and that usage source is `provider_subscription`:

```shell
codex-auth-advanced list --live
```

If setup is missing or the dashboard token was regenerated, configure it again:

```shell
codex-auth-advanced config vsllm-dashboard \
  --user-id <numeric-user-id> \
  --alias <dashboard-alias>
```

The provider can take up to roughly one reset-task interval plus the 30-second local polling interval to report a newly reset subscription.

### The Correct Account Does Not Switch Automatically

Check both the feature flag and manager status:

```shell
codex-auth-advanced status
```

Auto-switch must be enabled. A usable current account is not replaced merely because another account reset.

### The Wrong Account Receives OpenClaw Requests

Use the output of `proxy url <account>` as OpenClaw's base URL. The default proxy URL follows Codex's active account and is not appropriate for a client that must remain pinned.

### Local ChatGPT Usage Is Stale

Local rollout files can contain `rate_limits: null` or old snapshots. Enable API-backed ChatGPT usage when acceptable:

```shell
codex-auth-advanced config api enable
```

This setting is separate from VSLLM dashboard subscription access.

## Security

- Do not paste model API keys, dashboard access tokens, browser cookies, or session headers into issues or chat transcripts.
- Prefer hidden prompts or stdin over command-line secret arguments.
- Regenerating a New API system access token invalidates the previous management token but does not replace model API keys.
- Dashboard access tokens have broader account-management privileges than model keys. Store them only in the generated private credential files.
- Keep the proxy bound to loopback.
- Pinned proxy URLs are local routing identifiers, not authentication boundaries.
- Review `config api enable` before using it with ChatGPT accounts. It sends the stored ChatGPT access token to OpenAI account and usage endpoints.

When ChatGPT API refresh is enabled, the tool may contact endpoints including:

```text
https://chatgpt.com/backend-api/wham/usage
https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27
```

Use of automated account or usage APIs can carry provider policy and account-restriction risk. You are responsible for deciding whether that behavior is acceptable for your accounts.

## Current Limitations

- This checkout currently vendors only the macOS arm64 native binary.
- Automated system installation currently supports macOS only; Windows service and client setup are postponed.
- Auto-switching is still considered experimental.
- A newly reset fallback account becomes eligible but does not trigger automatic failback while the active account remains usable.
- Without dashboard credentials, fixed VSLLM subscription windows can only use the less accurate rolling billing fallback.
- Pinned routes isolate routing but do not reserve an account from other group workflows.

## Disclaimer

This project is provided as-is. Account switching, direct provider APIs, dashboard automation, and proxy behavior can interact with provider policies and subscription rules. Use it at your own risk.
