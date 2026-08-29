# Project Instructions

## Required Project Context

- Read `PROJECT_GUIDE.md` before changing runtime behavior, routing, account state, client configuration, compaction, retries, or proxy lifecycle code.
- Treat `PROJECT_GUIDE.md` as the maintainer/agent architecture and invariant reference. Treat `README.md` as the user-facing command and installation reference.
- Preserve the module ownership, credential safety, pinned-route, endpoint-chain, retry, testing, and definition-of-done rules documented in `PROJECT_GUIDE.md`.

## Provider Proxy Lifecycle

- Never use `kill`, `pkill`, or direct process termination to restart the provider proxy. It drops in-flight API streams and can leave the active Codex session blocked.
- Use `./scripts/start-proxy.zsh` only to start a stopped proxy.
- Use `./scripts/restart-proxy.zsh` to restart a running proxy. It asks the proxy to drain active requests before stopping it, then starts a healthy replacement.
- When updating a proxy that predates graceful restart support, leave it running until the current Codex session is idle. The restart script intentionally refuses to terminate that legacy process.

## Restarting the proxy after an impacting change

The provider proxy loads all `src/*.mjs` modules at startup. Editing those files does NOT change the running proxy's behavior; the new code is only used after the proxy restarts. After any change that affects runtime behavior, routing, account state, client configuration, compaction, retries, or proxy lifecycle code, run `./scripts/restart-proxy.zsh` once the relevant tests are green and the change is ready to take effect. Do not stop here just because the file was saved — the change is not live until the proxy has been restarted.

- Order: deterministic tests first (`npm test` + the relevant additional bridge/shape tests), then `./scripts/restart-proxy.zsh`, then verify with `curl -sS http://127.0.0.1:47778/_codex-auth-advanced/health` that `started_at_ms` advanced.
- Restart only when the new runtime must be activated and active streams can drain safely. If a Codex session is in the middle of streaming a turn, finish the turn first.
- A restart is required even when only one of several changed modules is the affected runtime path; the wrapper script restarts the whole proxy, not individual modules.
- The restart script refuses to terminate legacy proxies that lack the graceful-restart endpoint. In that case leave the process alone until the current Codex session is idle.
