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
