# Codex Auth Advanced [![latest release](https://img.shields.io/github/v/release/mouaadsk/codex-auth-advanced?sort=semver&label=latest)](https://github.com/mouaadsk/codex-auth-advanced/releases/latest) [![latest pre-release](https://img.shields.io/github/v/release/mouaadsk/codex-auth-advanced?include_prereleases&sort=semver&filter=*-*&label=pre-release)](https://github.com/mouaadsk/codex-auth-advanced/releases)

![command list](https://github.com/user-attachments/assets/6c13a2d6-f9da-47ea-8ec8-0394fc072d40)

`codex-auth-advanced` is a command-line tool for switching Codex accounts.

> [!IMPORTANT]
> For **Codex CLI** and **Codex App** users, switch accounts, then restart the client for the new account to take effect.
>
> If you use the CLI and want seamless automatic account switching without restarting, use `codext`, an enhanced Codex CLI.

## Supported Platforms

`codex-auth-advanced` works with these Codex clients:

- Codex CLI
- VS Code extension
- Codex App

For the best experience, install the Codex CLI even if you mainly use the VS Code extension or the App, because it makes adding accounts easier:

```shell
npm install -g @openai/codex
```

After that, you can use `codex login`, `codex login --device-auth`, `codex-auth-advanced login`, `codex-auth-advanced login --device-auth`, or `codex-auth-advanced login --group <name>` to sign in and add accounts more easily.

## Local Setup

This project is maintained as a local laptop checkout. The npm package name is `codex-auth-advanced`, but this repository is not set up for registry publishing. The macOS arm64 binary is vendored under `vendor/darwin-arm64/bin/`, and the JavaScript wrapper runs that local binary directly.

Link this checkout into your active Node install:

```shell
npm link
```

Confirm the global command resolves to this repository:

```shell
which codex-auth-advanced
realpath "$(which codex-auth-advanced)"
```

The current vendored binary supports macOS arm64. Other platforms need matching binaries added under `vendor/<platform>-<arch>/bin/`.

### Uninstall

#### npm

Remove the local npm link:

```shell
npm uninstall -g codex-auth-advanced
```

#### Legacy Bash Installer

> [!NOTE]
> If you only installed `codex-auth-advanced` with npm, you do not need any legacy cleanup steps.
> Older Bash/PowerShell GitHub-release installs could leave a standalone `codex-auth-advanced` binary outside npm's install path.
> If you previously used those legacy installers, remove the leftover binaries and profile changes during migration.
> API-backed usage refresh and team-name refresh use Node.js `fetch`.
> npm installs already satisfy that requirement.

For non-npm installs on Linux/macOS/WSL2 only:

```shell
rm -f ~/.local/bin/codex-auth-advanced
rm -f ~/.local/bin/codex-auth-advanced-auto
sed -i '/# Added by codex-auth-advanced installer/,+1d' ~/.bashrc ~/.bash_profile ~/.profile ~/.zshrc ~/.zprofile 2>/dev/null || true
```

If you used fish, also remove the old profile entry:

```shell
sed -i '/# Added by codex-auth-advanced installer/,+3d' ~/.config/fish/config.fish 2>/dev/null || true
```

#### Legacy PowerShell Installer

For non-npm installs on Windows only:

```powershell
Remove-Item "$env:LOCALAPPDATA\codex-auth-advanced\bin\codex-auth-advanced.exe" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\codex-auth-advanced\bin\codex-auth-advanced-auto.exe" -Force -ErrorAction SilentlyContinue
[Environment]::SetEnvironmentVariable(
  "Path",
  (($env:Path -split ';' | Where-Object { $_ -and $_ -ne "$env:LOCALAPPDATA\codex-auth-advanced\bin" }) -join ';'),
  "User"
)
```

## Commands

### Account Management

| Command | Description |
|---------|-------------|
| `codex-auth-advanced list [--live] [--api\|--skip-api]` | List all accounts. `--live` keeps refreshing the terminal view; `--api` forces remote refresh, while `--skip-api` forbids remote API use for this command. |
| `codex-auth-advanced login [--device-auth] [--group <name>]` | Run `codex login` (optionally with `--device-auth`), then add the current account |
| `codex-auth-advanced switch [--live] [--auto] [--api\|--skip-api]` | Switch the active account interactively. Without `--live` it exits after one switch; with `--live` it stays open and keeps refreshing. `--auto` requires `--live` and auto-switches away from the current account when the live view shows it as exhausted or returns a non-200 usage API status. |
| `codex-auth-advanced switch <query>` | Switch the active account directly by row number, alias, or fuzzy match using stored local data only. |
| `codex-auth-advanced remove [--live] [--api\|--skip-api]` | Interactive remove. `--live` keeps the picker open after each deletion; `--api` forces remote refresh and `--skip-api` forbids remote API use for this command. |
| `codex-auth-advanced remove <query> [<query>...]` | Remove one or more accounts by row number, alias, email, account name, or `account_key` match using stored local data. |
| `codex-auth-advanced remove --all` | Remove all stored accounts. |
| `codex-auth-advanced status` | Show auto-switch, service, and usage status |

### Import

| Command | Description |
|---------|-------------|
| `codex-auth-advanced import <path> [--alias <alias>] [--api-spend-limit-usd <amount>]` | Import a single file or batch import from a folder |
| `codex-auth-advanced import --cpa [<path>] [--api-spend-limit-usd <amount>]` | Import [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) token JSON |
| `codex-auth-advanced import --purge [<path>]` | Rebuild `registry.json` from existing auth files |
| `codex-auth-advanced add-api-key --template openai\|codex-everywhere\|tcdmx --alias <alias> --stdin` | Add an API key directly without creating a JSON file |
| `codex-auth-advanced proxy status\|start\|serve` | Inspect or run the local provider proxy used for hot API-provider switching |

### Configuration

| Command | Description |
|---------|-------------|
| `codex-auth-advanced config auto enable\|disable` | Enable or disable experimental background auto-switching |
| `codex-auth-advanced config api-spend-limit <api-account> <amount>` | Set or update the dollar spend limit for an imported API-key account |
| `codex-auth-advanced config api enable\|disable` | Enable or disable both usage refresh and team name refresh API calls |

### Managed Account Groups

| Command | Description |
|---------|-------------|
| `codex-auth-advanced list` | List accounts across managed groups with group sections and a `GROUP` column |
| `codex-auth-advanced group list` | List managed account groups and their `CODEX_HOME` folders |
| `codex-auth-advanced group create <name> [<account>...]` | Create a group under `~/codex-auth-advanced/groups/` and optionally add accounts |
| `codex-auth-advanced group <name> login [--device-auth]` | Log in and add the new account directly to that group |
| `codex-auth-advanced group <name> add-api-key --template openai\|codex-everywhere\|tcdmx --alias <alias> --stdin` | Add an API key directly to that group |
| `codex-auth-advanced group <name> add <account>...` | Copy existing accounts from any known group into the target group |
| `codex-auth-advanced group <name> copy [<account>...]` | Copy accounts into the target group. With no account selector, choose interactively. |
| `codex-auth-advanced group <name> move [<account>...]` | Move accounts into the target group by copying them, then removing them from their source group. With no account selector, choose interactively. |
| `codex-auth-advanced group <name> switch [--live] [--auto] [--api\|--skip-api]` | Switch the active account interactively inside that group |
| `codex-auth-advanced group <name> switch <query>` | Switch directly inside that group by row number, alias, or fuzzy match |
| `codex-auth-advanced group <name> auto enable\|disable` | Enable or disable auto-switching for that group |
| `codex-auth-advanced group <name> config api-spend-limit <api-account> <amount>` | Set or update an API-key dollar spend limit inside that group |
| `codex-auth-advanced group <name> config api enable\|disable` | Enable or disable usage and account API calls for that group |
| `codex-auth-advanced group <name> launch [resume [session]] [-- <codext-arg>...]` | Launch `codext` with that group as `CODEX_HOME` and pass the group's current model settings |
| `codex-auth-advanced project set-group <name>` | Remember a group for the current project directory |
| `codex-auth-advanced launch [resume [session]] [-- <codext-arg>...]` | Launch `codext` using the remembered project group, or `default`, and pass the group's current model settings |

`default` maps to the normal `~/.codex`. Other managed groups live under `~/codex-auth-advanced/groups/`, each gets its own display color for the grouped list dashboard, and the single advanced auto-switch manager can watch all enabled groups at once.

Launch commands read the selected group's `config.toml` and forward its top-level `model` and `model_reasoning_effort` to `codext` unless you already pass `--model` or a matching `-c` override yourself. This keeps resumed sessions aligned with the current group config instead of letting stale saved thread metadata silently restore an older model.

---

## Examples

### List Accounts

> [!IMPORTANT]
> Built-in Node proxy support for API refresh requires Node.js `22.21.0+` or `24.0.0+`.

```shell
codex-auth-advanced list
codex-auth-advanced list --live
codex-auth-advanced list --api        # force usage/team-name API refresh, even if config api is disabled
codex-auth-advanced list --skip-api   # forbid usage/team-name API refresh for this command
```

`--live` keeps the list refreshing inside the terminal UI.
`--api` forces the foreground usage and team-name refresh path for this command only.
`--skip-api` forbids remote refresh for this command only. Usage can still refresh locally for the active account when local rollout data exists.

### Switch Account

```shell
codex-auth-advanced switch
codex-auth-advanced switch --live
codex-auth-advanced switch --live --auto
codex-auth-advanced switch --api
codex-auth-advanced switch --skip-api
```

`codex-auth-advanced switch`
Opens the interactive picker. It shows email, 5h, weekly, and last activity, then exits after one successful switch.

`codex-auth-advanced switch --live`
Keeps the picker open after Enter, keeps refreshing the terminal view, and updates the footer with the latest switch result.

`codex-auth-advanced switch --live --auto`
Keeps watching the current live display and auto-switches only when the active account reaches `0%` on 5h or weekly, or when the usage API returns a non-200 status for the active account.

`codex-auth-advanced switch --api`
Forces a foreground remote refresh before opening the picker.

`codex-auth-advanced switch --skip-api`
Forbids remote API use for this command and relies on local-only usage refresh where available.

`codex-auth-advanced switch <query>`
Switches directly by displayed row number, alias, or fuzzy email/alias match using stored local data only. The row number follows the interactive `switch` list, and the same number from `codex-auth-advanced list` also works because both commands use the same ordering. `switch <query>` does not accept `--live`, `--auto`, `--api`, or `--skip-api`.

When `--live --auto` is active, auto-switch candidates still follow the live picker rules and skip accounts whose current 5h or weekly value is already `0%`.

![command switch](https://github.com/user-attachments/assets/48a86acf-2a6e-4206-a8c4-591989fdc0df)

```shell
codex-auth-advanced switch 02                 # switch by displayed row number
codex-auth-advanced switch john               # fuzzy match by email or alias
codex-auth-advanced switch work               # match by alias set during import
```

If `<query>` matches multiple accounts, the command falls back to interactive selection. Press `q` to quit without switching.

### Remove Accounts

```shell
codex-auth-advanced remove
codex-auth-advanced remove --live
codex-auth-advanced remove --api
codex-auth-advanced remove --skip-api
```

`codex-auth-advanced remove`
Opens the interactive remove picker. It stays local-only by default so deletion is not blocked by API refresh work.

`codex-auth-advanced remove --live`
Keeps the picker open after each deletion so you can continue cleaning up accounts in one session.

`codex-auth-advanced remove --api`
Attempts a best-effort foreground refresh for picker display. Successful rows show live API data when it is available; rows that cannot refresh may show live error overlays such as `403`, `TimedOut`, or `MissingAuth` instead.

`codex-auth-advanced remove --skip-api`
Keeps the picker local-only explicitly and forbids remote API use for this command.

`codex-auth-advanced remove <query> [<query>...]`
Removes one or more accounts by row number, alias, email, account name, or `account_key` match using stored local data only.

`codex-auth-advanced remove --all`
Removes all stored accounts.

Each selector supports the same query forms as `switch`: row number, alias, or fuzzy email/alias match.
The row number follows the interactive `switch` list, and the same number from `codex-auth-advanced list` also works because both commands use the same ordering.
You can pass multiple selectors in one command.
Selector-based `remove` and `remove --all` do not accept `--live`, `--api`, or `--skip-api`.

```shell
codex-auth-advanced remove 01 03
codex-auth-advanced remove work personal
codex-auth-advanced remove 01 jane@example.com
codex-auth-advanced remove --all
```

If any selector matches multiple accounts, `remove` asks for confirmation in interactive terminals before deleting.

### Login (Add Account)

Add the currently logged-in Codex account:

```shell
codex-auth-advanced login
codex-auth-advanced login --device-auth
codex-auth-advanced login --group work --device-auth
codex-auth-advanced group work login --device-auth
```

### Import

#### Single File

```shell
codex-auth-advanced import /path/to/auth.json --alias personal
codex-auth-advanced import /path/to/api-auth.json --alias codex-everywhere --api-spend-limit-usd 50
```

For API-key imports, `--api-spend-limit-usd <amount>` stores a dollar cap on the imported API key. When the API reports HTTP 429 or the tracked spend reaches that cap, the wrapper marks that account as exhausted in local usage data so account switching can move to the next usable account.
For an API key that was already imported, set or update the cap with:

```shell
codex-auth-advanced config api-spend-limit codex-everywhere 50
codex-auth-advanced group default config api-spend-limit codex-everywhere 50
```

#### Direct API-Key Add

Add a token without creating a JSON file by piping it on stdin. The supported templates are `openai`, `codex-everywhere`, and `tcdmx`; the codex-everywhere template uses `https://codex-everywhere.com/` and defaults the spend limit to `$50`, while the tcdmx template uses `https://tcdmx.com` and defaults the spend limit to `$300`.
API-key configs inherit the current top-level `model`, `review_model`, and `model_reasoning_effort` settings when they are created or switched, so changing providers does not downgrade the selected session model. Switching to an API-key account refreshes that account's API runtime fields, including context and auto-compact limits, while preserving unrelated root config such as MCP and feature settings.
Generated API-key configs default `model_context_window` to `512000`; the codex-everywhere template uses `model_auto_compact_token_limit = 300000`, while the tcdmx template uses `model_auto_compact_token_limit = 400000`.
Stored API-key configs use a custom `model_providers.OpenAI` section with `wire_api = "responses"` and the provider-specific `base_url`, so codex-everywhere and tcdmx keep the same Responses-provider structure while pointing at their own domains.
When an API-key account is active, the root `config.toml` keeps `model_provider = "openai"` and points `openai_base_url` at the local `codex-auth-advanced` provider proxy. The per-account config still stores the real upstream URL, and the proxy forwards each request to the currently active upstream with the currently active API key. Keeping the provider id as lowercase `openai` preserves `codext` resume visibility for older sessions. After the first switch that enables the proxy URL, restart any already-running `codext` session once so it picks up the localhost base URL; later API-to-API switches can happen without changing `codext`'s in-memory provider config.
The `tcdmx` template also enables one provider-specific compact retry: if tcdmx rejects a request with `invalid_encrypted_content`, the proxy retries that same request once after removing encrypted reasoning blobs produced by the previous backend. The codex-everywhere template keeps normal pass-through behavior.

```shell
printf '%s' "$OPENAI_API_KEY" | codex-auth-advanced group default add-api-key --template openai --alias openai-main --stdin
printf '%s' "$CODEX_EVERYWHERE_API_KEY" | codex-auth-advanced group default add-api-key --template codex-everywhere --alias codex-everywhere-2 --stdin
printf '%s' "$TCDMX_API_KEY" | codex-auth-advanced group default add-api-key --template tcdmx --alias tcdmx --stdin
```

#### Batch Import from a Folder

Scans all `.json` files in the directory:

```shell
codex-auth-advanced import /path/to/auth-exports
```

Typical output:

```text
Scanning /path/to/auth-exports...
  ✓ imported  token_ryan.taylor.alpha@email.com
  ✓ updated   token_jane.smith.alpha@email.com
  ✗ skipped   token_invalid: MalformedJson
Import Summary: 1 imported, 1 updated, 1 skipped (total 3 files)
```

`stdout` carries scanning, success, and summary lines. Skipped files and warnings stay on `stderr`.

#### Import CLIProxyAPI (CPA) Tokens

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) stores tokens as flat JSON under `~/.cli-proxy-api/`. Import them directly without conversion:

```shell
codex-auth-advanced import --cpa                                  # scan default ~/.cli-proxy-api/*.json
codex-auth-advanced import --cpa /path/to/cpa-dir                 # scan a specific directory
codex-auth-advanced import --cpa /path/to/token.json --alias bob  # import a single CPA file
codex-auth-advanced import --cpa /path/to/token.json --alias bob --api-spend-limit-usd 50
```

#### Fix Broken Account Data (Rebuild Registry)

If `codex-auth-advanced list` shows missing accounts or wrong usage data, the internal registry file may be out of sync with the actual auth files on disk. This command re-reads all auth files and rebuilds the registry from scratch:

```shell
codex-auth-advanced import --purge                                # rebuild from ~/.codex/accounts/*.auth.json
codex-auth-advanced import --purge /path/to/auth-exports          # rebuild from a specific folder
```

This does not import new files. It repairs the registry index for auth snapshots that already exist on disk.

### Show Status

```shell
codex-auth-advanced status
```

### Config

#### Auto-Switch

> [!WARNING]
> Auto-switch is experimental. Behavior, defaults, and platform integration may change in future releases while the feature matures.

Enable or disable:

```shell
codex-auth-advanced config auto enable
codex-auth-advanced config auto disable
```

`config auto enable` prints the current usage mode after installing the watcher, so you can immediately see whether auto-switch is running with default API-backed usage or local-only fallback semantics.

When auto-switching is enabled, a long-running background manager refreshes each enabled group's active account usage and silently switches accounts when:

- 5h remaining reaches or drops below the configured 5h threshold, or
- weekly remaining reaches or drops below the configured weekly threshold

Auto-switch evaluates both 5h and weekly by default. Configure thresholds with `config auto --5h <percent> [--weekly <percent>]` for the default group, or `group <name> auto --5h <percent> [--weekly <percent>]` for a managed group.
Candidates whose current 5h or weekly value is already `0` are skipped.
When choosing the next account, `codex-auth-advanced` prefers a usable account whose remaining quota resets sooner, so a reset at `05:11` wins over `05:30`.

The managed background worker is one long-running manager service on all supported platforms:

- Linux/WSL: persistent `systemd --user` service
- macOS: `LaunchAgent` named `com.mouaadsk.codex-auth-advanced.manager`
- Windows: scheduled task that launches the long-running helper at logon, restarts it after failures, has no 72-hour execution cap, and also starts it immediately on enable

In this local fork, API-key account switching is handled by the JavaScript wrapper for direct switch, live switch, live auto-switch, `list --live`, and the background daemon. API-key accounts are considered usable when their spend cap is not exhausted, group copy/move/add flows repair missing API-key config files when needed, and the local provider proxy keeps `codext` on a stable localhost endpoint while routing requests to the selected API provider.

#### Usage Refresh Source

API-backed fallback:

```shell
codex-auth-advanced config api enable
```

Local-only, no usage API calls:

```shell
codex-auth-advanced config api disable
```

Changing `config api` updates `registry.json` immediately. `api enable` is shown as API mode and `api disable` is shown as local mode.

## Q&A

### Why is my usage limit not refreshing?

If `codex-auth-advanced` is using local-only usage refresh, it reads the newest `~/.codex/sessions/**/rollout-*.jsonl` file. Recent Codex builds often write `token_count` events with `rate_limits: null`. The local files may still contain older usable usage limit data, but in practice they can lag by several hours, so local-only refresh may show a usage limit snapshot from hours ago instead of your latest state.

- Upstream Codex issue: [openai/codex#14880](https://github.com/openai/codex/issues/14880)

You can switch usage limit refresh to the usage API with:

```shell
codex-auth-advanced config api enable
```

Then confirm the current mode with:

```shell
codex-auth-advanced status
```

`status` should show `usage: api`.

Upgrade notes:

- If you are upgrading from `v0.1.x` to the latest `v0.2.x`, API usage refresh is enabled by default.
- If you previously used an early `v0.2` prerelease/test build and `status` still shows `usage: local`, run `codex-auth-advanced config api enable` once to switch back to API mode.

Verify with:

```shell
codex exec "say hello"
```

## Disclaimer

This project is provided as-is and use is at your own risk.

**Usage Data Refresh Source:**
`codex-auth-advanced` supports two sources for refreshing account usage/usage limit information:

1. **API (default):** When `config api enable` is on, the tool makes direct HTTPS requests to OpenAI's endpoints using your account's access token. This enables both usage refresh and team name refresh. npm installs already satisfy the runtime requirement; legacy standalone binary installs need Node.js 22+ on `PATH`.
2. **Local-only:** When `config api disable` is on, the tool scans local `~/.codex/sessions/*/rollout-*.jsonl` files for usage data and skips team name refresh API calls. This mode is safer, but it can be less accurate because recent Codex rollout files often contain `rate_limits: null`, so the latest local usage limit data may lag by several hours.

**API Call Declaration:**
By enabling API(`codex-auth-advanced config api enable`), this tool will send your ChatGPT access token to OpenAI's servers, including `https://chatgpt.com/backend-api/wham/usage` for usage limit and `https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27` for team name. This behavior may be detected by OpenAI and could violate their terms of service, potentially leading to account suspension or other risks. The decision to use this feature and any resulting consequences are entirely yours.
