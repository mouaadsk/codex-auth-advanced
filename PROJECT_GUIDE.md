# Codex Auth Advanced: Maintainer and Agent Guide

This is the starting point for anyone changing this repository. Read it before editing runtime behavior, account state, routing, compaction, client configuration, or proxy lifecycle code. [`README.md`](README.md) is the user-facing command and installation reference; this document explains the internal system, its invariants, and how to change it safely.

## 1. Project Purpose

`codex-auth-advanced` is a local multi-client, multi-account routing layer. It manages Codex/ChatGPT credential snapshots and API-key accounts, configures Codex, Claude Code, and Grok Build to use a stable loopback address, and forwards every request to the appropriate active or pinned upstream account.

The project does not assume an official OpenAI API endpoint. API-key accounts can point at VSLLM/New API, LLMAPI, or another compatible provider. “OpenAI” in module or protocol names usually describes the wire shape—Responses or Chat Completions—not the company operating the upstream service.

The important capabilities are:

- Independent account registries per `CODEX_HOME` group.
- Hot API-account selection behind a stable local base URL.
- Pinned account URLs for clients that must not follow the active account.
- Four supported request/response wire shapes: OpenAI Responses, OpenAI Chat Completions, Anthropic Messages, and Gemini/Antigravity.
- Translation and same-account endpoint failover between those shapes.
- Provider usage classification, bounded transient retries, exhaustion handling, and optional account failover.
- Provider-compatible Codex and Claude Code compaction.
- Safe background operation and graceful proxy replacement without dropping active streams.

The current package is a macOS-focused local checkout. A native upstream account-manager binary is vendored only for `darwin-arm64`.

## 2. Non-Negotiable Rules

These rules define correct behavior. Do not weaken them for a quick fix.

### Proxy lifecycle

- Never use `kill`, `pkill`, or another direct process-termination command to reload the provider proxy.
- Use `./scripts/start-proxy.zsh` only when the proxy is stopped.
- Use `./scripts/restart-proxy.zsh` to apply proxy code changes. It requests a graceful drain, refuses new work, waits for active HTTP requests and upgrades, and then starts or waits for a healthy replacement.
- If a running legacy proxy has no graceful-restart endpoint, leave it alive until its sessions are idle. The restart script intentionally refuses to terminate it.
- Do not restart the live proxy merely because code was edited. Run deterministic tests first, then restart only when the new runtime must be activated and active work can drain safely.

### Credentials and local state

- Never log, commit, or expose provider API keys, ChatGPT tokens, dashboard system access tokens, cookies, or raw authorization headers.
- Keep credential files at mode `0600` and their directories at `0700`.
- Prefer the helpers in [`src/storage.mjs`](src/storage.mjs) for private and atomic writes.
- Back up user-owned configuration before replacing it, and preserve unrelated keys and sections.
- Treat aliases as display/selectors only. `account_key` is the stable identity used in registries and pinned routes.

### Routing and retries

- A pinned route must never change the group’s active account and must never fail over to a different account.
- Endpoint-shape failover happens on the same account before account-level failover is considered.
- Account switching is reserved for classified exhaustion or explicitly supported transient failover. Do not turn arbitrary server errors into persistent account mutations.
- Preserve the user’s model ID and reasoning effort through translation, fallback, retry, and compaction unless an explicit compatibility mapping owns that transformation.
- Never silently downgrade `max` to `xhigh`, or drop reasoning effort to make a request pass.
- Retry only classified, bounded, safe cases. A normal streaming generation must not be replayed for a generic transport error after output may have begun.
- Compaction summarization is a non-streaming, idempotent one-shot call and can therefore use the bounded retry policy described below.

### Scope and ownership

- Keep the wrapper thin. Put domain logic in the owning `src/` module.
- Extend the universal shape translator and endpoint planner instead of adding provider-specific translation branches directly to the main proxy loop.
- Preserve existing user changes in a dirty worktree and avoid destructive Git operations.
- Every behavioral change needs a regression test near the owning module plus an integration test when it crosses routing, state, or protocol boundaries.

## 3. Runtime Architecture

A request moves through the system as follows:

```text
Codex / Claude Code / Grok Build / another compatible client
                         |
                         v
       loopback URL on 127.0.0.1:47778
                         |
                         v
          provider-proxy-routing.mjs
       decodes group and optional pinned account
                         |
                         v
             account-service.mjs
      reconciles registry + auth.json and loads key
                         |
                         v
              provider-proxy.mjs
     rewrites body, classifies shape, sends request
                         |
          +--------------+--------------+
          |                             |
          v                             v
 endpoint-chain / shape translator   direct upstream
 same-account shape fallback         compatible shape
          |                             |
          +--------------+--------------+
                         |
                         v
             response/SSE transforms
                         |
                         v
                       client
```

There are five runtime layers:

1. The vendored native account manager owns the original login, import, group, and ChatGPT account workflows.
2. [`bin/codex-auth-advanced-wrapper.js`](bin/codex-auth-advanced-wrapper.js) composes the JavaScript services, adapts wrapper-owned commands, and delegates remaining commands to the native binary.
3. [`src/account-service.mjs`](src/account-service.mjs) owns registry reconciliation, account activation, credential/config lookup, and account candidates.
4. [`src/provider-proxy.mjs`](src/provider-proxy.mjs) owns HTTP/WebSocket transport, request orchestration, retries, shape walking, response translation, stream watchdogs, and graceful restart state.
5. [`src/manager-service.mjs`](src/manager-service.mjs) and wrapper daemon logic refresh usage and perform optional scheduled switching.

Client configuration is separate from request routing. [`src/client-config.mjs`](src/client-config.mjs) edits Codex, Claude Code, and Grok Build files so those clients reach the local proxy, but the proxy resolves the actual upstream account on each request.

## 4. Repository Map

### Entrypoints and composition

| Path | Responsibility |
| --- | --- |
| `bin/codex-auth-advanced.js` | Small executable entry that loads the wrapper. |
| `bin/codex-auth-advanced-wrapper.js` | Dependency composition, runtime constants, native delegation, launch argument/config handling. |
| `vendor/darwin-arm64/bin/codex-auth-advanced` | Vendored native account manager; treat it as an external binary. |

### Account, configuration, and provider state

| Path | Responsibility |
| --- | --- |
| `src/storage.mjs` | Paths, private files, atomic writes, backups, group locations. |
| `src/account-service.mjs` | Registry loading/reconciliation, active and pinned targets, switching, exhaustion mutation, candidates. |
| `src/codex-config.mjs` | TOML parsing/merging, provider sections, API templates, session settings. |
| `src/codex-model-catalog.mjs` | Installed Codex model-catalog discovery and managed catalog generation. |
| `src/provider-client.mjs` | Provider health, billing, New API dashboard calls, response-body reading. |
| `src/provider-policy.mjs` | Provider identity, model aliases, usage/exhaustion classification, shape capabilities, retry classification. |
| `src/cli-vsllm-dashboard.mjs` | VSLLM/New API dashboard credential setup and masked-key matching. |

### Proxy, routing, and compatibility

| Path | Responsibility |
| --- | --- |
| `src/provider-proxy.mjs` | Main server and orchestration loop. |
| `src/provider-proxy-routing.mjs` | Loopback route parsing, group IDs, target URL construction, shape URLs. |
| `src/provider-proxy-http.mjs` | Safe request/response headers, control responses, socket helpers. |
| `src/provider-proxy-upgrade.mjs` | WebSocket upgrades and tunnels. |
| `src/proxy-body-transforms.mjs` | JSON decoding, model/body rewrites, remote-compaction detection, encrypted-content tags. |
| `src/proxy-compaction.mjs` | Compact detection, transcript extraction, provider summarization, retries, compact envelopes. |
| `src/proxy-sse-transforms.mjs` | Responses stream normalization, fallback model injection, stream diagnostics. |
| `src/endpoint-chain.mjs` | Ordered per-source shape attempts, pruned by account/model capabilities. |
| `src/shape-translator.mjs` | Universal cross-shape request, response, bridge, and SSE dispatch. |
| `src/shape-probe.mjs` | Minimal live probes for per-model endpoint support. |
| `src/shape-probe-store.mjs` | Persistent per-provider/model capability cache. |

### Protocol bridges

| Path | Responsibility |
| --- | --- |
| `src/chat-responses-core.mjs` / `chat-responses-sse.mjs` | Chat Completions ↔ Responses. |
| `src/claude-responses-core.mjs` / `claude-responses-responses.mjs` / `claude-responses-sse.mjs` | Anthropic Messages ↔ Responses/Chat, including tools and streaming. |
| `src/claude-gateway.mjs` | Official and VSLLM Claude model discovery metadata. |
| `src/antigravity-bridge.mjs` | Responses/Chat/Messages ↔ Gemini/Antigravity. |

### CLI, clients, services, and tests

| Path | Responsibility |
| --- | --- |
| `src/cli-service.mjs` | Wrapper-owned list/switch/API/usage/dashboard/proxy/auto commands. |
| `src/client-config.mjs` | Codex, Claude Code, and Grok Build configuration. |
| `src/grok-config.mjs` | Managed Grok Build VSLLM provider/model TOML. |
| `src/manager-service.mjs` | Auto-switch manager process and status integration. |
| `scripts/` | Installer, proxy supervisor, start/restart scripts, and explicit probes. |
| `test-*.mjs` | Deterministic unit/integration scripts; see the test matrix below. |

## 5. Local State Model

The default group maps to the current default `CODEX_HOME`, normally `~/.codex`. Named groups normally live at `~/codex-auth-advanced/groups/<name>`. The native global group registry is read from `~/codex-auth-advanced/config.json`, and remembered project-to-group mappings live in `~/codex-auth-advanced/projects.json`.

Within each group:

```text
<CODEX_HOME>/
  auth.json                              active credential identity used by Codex
  config.toml                            active Codex runtime configuration
  model-catalogs/codex-auth-advanced.json
  cache/model-shape-capabilities.json
  accounts/
    registry.json                        account metadata and active key
    <account-key>.auth.json              stored credential snapshot
    <account-key>.config.toml             stored per-account provider config
    provider-dashboard/<hash>.json       private New API dashboard credential
```

### Active-account invariant

`registry.active_account_key` is canonical for proxy routing. Older native registries may also contain `activeAccountKey` or per-account `active` flags. `account-service.mjs` reconciles those legacy forms and `auth.json` so list, switch, normal requests, and compaction resolve the same account.

An explicit switch must update all of the following as one logical operation:

- Root `auth.json`, including the stable `account_key` and a switch nonce.
- Root `config.toml`, preserving current session model/reasoning settings while pointing API traffic at the local proxy.
- Canonical registry active key and any legacy active markers already present.
- Activation and last-used timestamps.

The proxy does not cache the active API target across requests. A default-route request reads the current group registry; this is why an API-to-API switch can affect both chat and compaction without restarting Codex. A running Codex client may still need restart for client-loaded model catalogs or first-party ChatGPT credentials.

### Display names and selectors

The UI label is resolved consistently as `alias`, then `email`, then `account_name`, then `account_key`. Switch queries may match those fields, and numeric selectors refer to the same sorted registry rows displayed by the wrapper-owned list/switch code. Do not invent a separate naming path for one command.

## 6. Proxy Routes and Selection

Control endpoints are not group-scoped:

```text
GET  http://127.0.0.1:47778/_codex-auth-advanced/health
POST http://127.0.0.1:47778/_codex-auth-advanced/restart
```

The default route follows a group’s active account:

```text
http://127.0.0.1:47778/_codex-auth-advanced/<base64url-absolute-CODEX_HOME>
```

Pinned routes contain a stable account selector:

```text
http://127.0.0.1:47778/_codex-auth-advanced/<group-id>/accounts/<account-key>/v1
```

Always generate pinned routes with `codex-auth-advanced proxy url <selector>`. They are appropriate for Grok Build and other clients that must remain on one VSLLM account while Codex switches independently.

The request path after the proxy prefix is appended to the upstream base URL. The proxy strips caller secrets and incompatible protocol headers, injects the selected stored credential, uses `accept-encoding: identity` for provider requests, and removes hop-by-hop headers on both sides.

## 7. Wire Shapes and Endpoint Chain

The four internal shape IDs are:

| Shape | Typical path |
| --- | --- |
| `responses` | `/v1/responses` or `/v1/responses/compact` |
| `chat_completions` | `/v1/chat/completions` |
| `messages` | `/v1/messages` or `/v1/messages/count_tokens` |
| `antigravity` | `/v1beta/models/<model>:generateContent` |

Each source keeps its native shape first:

| Client/source shape | Same-account attempt order |
| --- | --- |
| Responses | Responses → Chat Completions → Messages → Antigravity |
| Chat Completions | Chat Completions → Responses → Messages → Antigravity |
| Messages | Messages → Responses → Chat Completions → Antigravity |
| Antigravity | Antigravity → Responses → Chat Completions → Messages |

The planner intersects this order with account capabilities and per-model capabilities. Known VSLLM Grok 4/4.5/4.6 models are statically Chat-Completions-only. Unknown models may be probed in the background, and successful probe results are stored per `(provider slug, model)` so the same model may have different shapes on VSLLM and LLMAPI.

Shape fallback is for transport failures, timeouts, 404/405, selected gateway failures, and recognized endpoint-unsupported validation responses. The universal translator converts the request before retrying and converts unary JSON or SSE back to the client’s source shape.

Do not confuse shape failover with account failover:

- Shape failover changes the endpoint/protocol on the same account.
- Account failover changes credentials and happens only after classified exhaustion or a supported transient-account rule.
- A pinned route stays on the caller-selected wire shape and never account-fails over. Configure the client with the correct backend explicitly; for example, the managed Grok Build entries select Chat Completions.

## 8. Client-Specific Behavior

### Codex

`configure codex` points the active group’s provider configuration at the default proxy route and writes a managed model catalog. Codex normally originates Responses requests, so `/responses` is primary. The model selected in `/model` must remain unchanged across normal traffic, compaction, retries, and child-agent requests.

### Claude Code

`configure claude` sets the loopback Anthropic base URL and gateway-model discovery, then refreshes a cache containing VSLLM model entries. Official Claude selections retain Claude Code OAuth and route to official Anthropic. Namespaced `VSLLM:` selections use the stored active provider account.

Native Anthropic-compatible VSLLM models use `/v1/messages`. Models exposed through another shape use the appropriate bridge. Token counting for a bridged model is estimated locally. Claude session and agent headers are preserved, while protocol-specific headers that do not belong on the translated upstream request are removed.

### Grok Build

`configure grok` requires the currently active account to be VSLLM and writes a pinned route for that exact account. Managed picker entries are `vsllm-grok-45` and `vsllm-grok-46`; each explicitly declares `api_backend = "chat_completions"`, so Grok Build appends `/v1/chat/completions` to the shared `/v1` base URL. Re-run configuration to deliberately pin another VSLLM account.

## 9. Compaction Contract

There are three related paths:

1. Legacy/native Codex compact arrives at `/responses/compact`.
2. Codex remote compaction v2 arrives as a normal `/responses` request identified by `client_metadata` and a `compaction_trigger`.
3. Claude Code `/compact` is detected from the summarization prompt in a normal `/v1/messages` request.

### Codex behavior

For a provider-native compact request, the proxy first tries the native compact endpoint. If the endpoint is unsupported, unavailable, or timed out, it extracts readable conversation text and performs provider-compatible summarization.

For remote compaction v2, the proxy directly creates that provider-compatible summary because compatible API-key providers generally do not implement Codex’s private compaction protocol.

Provider-compatible Codex summarization uses:

1. `/v1/responses` with the original selected model and `reasoning.effort`.
2. `/v1/chat/completions` only if Responses cannot return a usable summary, with the same model and `reasoning_effort`.

The proxy never forwards `compaction_trigger` as conversation text. It expands summaries previously created by this proxy from a tagged `encrypted_content` value, preserves readable messages/tool calls/tool outputs, caps the summarization transcript at a safe budget, and returns exactly the envelope Codex expects. Remote compaction v2 emits exactly one `type: "compaction"` output item followed by one `response.completed` event.

If all compatible summary attempts fail, the proxy returns HTTP 502 with a specific reason and `compaction was not applied`. It must not fabricate an empty or placeholder compaction, because that would silently discard context.

### Transient compaction retry policy

Provider-compatible summarization is non-streaming and idempotent. Each shape receives one retry with the exact same account, endpoint, model, reasoning effort, transcript, headers, and JSON body when any of these occur:

- A classified network/socket failure.
- A local fetch or body-read timeout/abort.
- HTTP 408 or 425.
- HTTP 5xx, including Cloudflare 504 and 524.

The Responses endpoint has a 120-second per-attempt watchdog; the Codex Chat Completions fallback has a 30-second per-attempt watchdog. Claude and generic shape summarizers use their call-site budgets. The retry count is bounded; after it is exhausted, the next compatible shape is attempted or the non-lossy 502 is returned.

Do not apply this generic policy to normal streaming turns. A replay after partial output could duplicate work or tool calls.

### VSLLM reasoning-level retry policy

VSLLM/New API may route identical model requests to channels with inconsistent validators. If the exact error says that the requested `max`, `xhigh`, or `ultra` level is unsupported and lists valid levels, the proxy retries the unchanged request up to two times. This narrow rule applies to normal Responses/Chat requests and compaction summaries. It does not translate the effort and does not catch unrelated HTTP 400 responses.

## 10. Provider and Account Failure Policy

Provider errors are classified in `provider-policy.mjs` before mutation or failover.

- A transient VSLLM usage-limit response is retried once on the same account while provider state says quota remains available.
- Model-capacity responses are retried three times with 1s/2s/4s backoff by default.
- A classified per-key restriction can try another usable account for the current request without persisting an exhausted state.
- Hard quota/subscription exhaustion is persisted and can switch the active account when auto-switching or the force rule permits it.
- Generic 5xx errors do not automatically mark an account exhausted.
- Pinned requests never switch accounts.

VSLLM is treated as a New API deployment. The authoritative fixed-window state comes from `/api/subscription/self` when dashboard credentials are configured; cumulative API billing totals alone cannot identify subscription reset windows reliably.

## 11. Streaming and Stall Protection

Normal Responses streams are passed or translated as SSE. The proxy sends headers promptly, records completion diagnostics, and watches raw upstream bytes. The default stream-stall watchdog is 90 seconds and can be changed with `CODEX_AUTH_ADVANCED_STREAM_STALL_WATCHDOG_MS`; `0` disables it.

If a stream sends no bytes within the watchdog, the proxy writes a terminal SSE error and closes the stalled upstream instead of leaving the client blocked indefinitely. A pre-header stall becomes a transient 524 so the endpoint chain can try the next compatible shape. Do not make locally generated heartbeats reset the upstream liveness timer—only real upstream bytes prove the provider is alive.

## 12. Proxy Lifecycle and Operations

The health payload contains:

- `started_at_ms`
- `restart_requested`
- `active_requests`
- `active_upgrades`

`POST /_codex-auth-advanced/restart` is loopback-only. Once requested, the proxy rejects new work, drains tracked requests and upgrades, closes idle connections, and exits. The macOS LaunchAgent or the detached start script creates the replacement.

Operational commands:

```shell
./scripts/start-proxy.zsh
./scripts/restart-proxy.zsh
curl -sS http://127.0.0.1:47778/_codex-auth-advanced/health
```

Managed logs:

```text
~/Library/Logs/codex-auth-advanced/proxy.log
~/Library/Logs/codex-auth-advanced/proxy.error.log
```

An unmanaged start writes `scratch/proxy.log` in this checkout. Logs are operational data and must not be committed.

When checking health, use the global control path shown above. A group-scoped `<group-id>/health` path is treated as provider traffic and does not report proxy health.

## 13. Testing and Verification

The required deterministic gate is:

```shell
npm test
```

It performs syntax checks and runs the core account/config/provider tests, Claude Responses bridge integration, provider proxy/compaction integration, SSE transforms, VSLLM dashboard extraction, macOS installer configuration, and managed proxy lifecycle tests.

Additional deterministic tests exist and should be run when their domains change:

```shell
node test-chat-responses-bridge.mjs
node test-antigravity-bridge.mjs
node test-endpoint-chain.mjs
node test-shape-translator.mjs
node test-shape-probe.mjs
node test-shape-probe-store.mjs
node test-shape-probe-live.mjs
```

`test-shape-probe-live.mjs` uses a mocked global `fetch`; despite its name, it does not contact a real provider. `scripts/check-vsllm-responses-lite.sh` is a separate explicit provider probe that requires a captured request at `/tmp/vsllm-lite-probe-request.json`; it is not part of the deterministic suite and may incur provider usage.

Use this verification order for runtime changes:

1. Run `node --check` on touched executable modules while iterating.
2. Run the nearest focused test.
3. Run `npm test`.
4. Run relevant additional deterministic bridge/shape tests.
5. Run `git diff --check` and inspect the diff for secret or unrelated changes.
6. If live activation is required, check the global health endpoint, then use the graceful restart script. Do not interrupt active streams.
7. Inspect the managed log for the expected route/retry behavior without printing authorization data.

Live provider tests are optional and must be deliberate. Never infer permission to spend provider quota merely from a request to run the normal test suite.

## 14. Change Recipes

### Add or change a provider template

1. Define configuration defaults and inference in `codex-config.mjs`.
2. Add provider identity/capabilities/error policy in `provider-policy.mjs` only where necessary.
3. Resolve credentials and base URL in `account-service.mjs`.
4. Use the universal shape layer for protocol compatibility.
5. Add config, policy, account-target, and proxy integration tests.

### Add a model with limited endpoint support

1. Prefer provider-advertised data or the shape probe when reliable.
2. Add a static `MODEL_SHAPE_CAPABILITIES` entry only for a known deterministic restriction.
3. Preserve the upstream model ID unless a documented compatibility alias owns the mapping.
4. Test the planner and end-to-end proxy route.

### Add a protocol translation

1. Implement pure unary request/response conversion in the relevant bridge module.
2. Add SSE translation when streaming is possible.
3. Register it through `shape-translator.mjs` and `endpoint-chain.mjs`.
4. Preserve tools, tool IDs, usage, finish reasons, model, reasoning, and stream termination.
5. Test all supported direction pairs plus an end-to-end proxy request.

### Change retry behavior

1. State why replay is safe for that request class.
2. Match a narrow status/body/error classifier.
3. Bound attempts and delay.
4. Preserve account, endpoint, body, model, and reasoning unless the policy explicitly says otherwise.
5. Cancel discarded response bodies.
6. Test recovery, persistent failure, body equality, non-retryable errors, and pinned/default behavior.

### Change account switching

1. Treat `registry.active_account_key` as canonical.
2. Keep `auth.json`, root config, registry metadata, list output, and proxy target synchronized.
3. Test top-level and `group default` commands, interactive selection, aliases, row selectors, and ambiguous matches.
4. Test a normal chat request and a compaction request immediately after switching.

### Change proxy startup or restart

1. Preserve `/health` and `/restart` contracts.
2. Preserve active request and upgrade accounting.
3. Test managed and unmanaged ownership transfer.
4. Use only the start/restart scripts against the live process.

## 15. Common Failure Patterns

### Automatic compaction returns 502 after a long wait

Look for `Proxy Local Compaction` in `proxy.error.log`. A typical upstream outage shows a Responses timeout or Cloudflare 504 followed by a Chat Completions timeout. The proxy now retries each idempotent summary endpoint once; a final 502 means all bounded attempts failed and the original context was intentionally left intact. Manual `/compact` may work later simply because a later provider channel completed.

### `level "max" not supported`

This is usually a VSLLM/New API channel inconsistency, not proof that the public model never supports `max`. The proxy retries only the exact high-effort validation error. If it persists after the bounded retries, inspect the provider/model capability instead of silently changing the effort.

### Grok Build reports a missing `model` field

Confirm the selected Grok picker entry is the managed `vsllm-grok-45` or `vsllm-grok-46`, not an official model entry. Confirm `~/.grok/config.toml` has the pinned VSLLM `/v1` base and per-model `api_backend = "chat_completions"`, then gracefully restart the proxy if code—not just configuration—changed.

### Account list and switch disagree

Inspect the group’s `registry.json` and root `auth.json` identity, then use the reconciliation and label helpers in `account-service.mjs`. Do not patch only rendered output. The list, picker, direct switch, proxy, and compaction must all derive from the same registry and label rules.

### Code changed but runtime behavior did not

First run tests. Then check the global health endpoint’s `started_at_ms`. If live activation is needed, use `./scripts/restart-proxy.zsh`; never terminate the process directly.

## 16. Definition of Done

A change is complete only when:

- The behavior is implemented in the owning module without bypassing system invariants.
- Regression coverage includes the success case and the relevant failure/boundary cases.
- `npm test`, relevant additional deterministic tests, and `git diff --check` pass.
- No secrets or unrelated user changes are included.
- User-facing behavior and maintainer rules are documented when they changed.
- Any live proxy reload used the graceful lifecycle and health was verified afterward.
- The commit is pushed when the user requested commit and push.
