# Project Instructions

## Provider Proxy Lifecycle

- Never use `kill`, `pkill`, or direct process termination to restart the provider proxy. It drops in-flight API streams and can leave the active Codex session blocked.
- Use `./scripts/start-proxy.zsh` only to start a stopped proxy.
- Use `./scripts/restart-proxy.zsh` to restart a running proxy. It asks the proxy to drain active requests before stopping it, then starts a healthy replacement.
- When updating a proxy that predates graceful restart support, leave it running until the current Codex session is idle. The restart script intentionally refuses to terminate that legacy process.
