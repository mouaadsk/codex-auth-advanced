# Claude Code Project Instructions

Read `AGENTS.md` and `PROJECT_GUIDE.md` before changing runtime behavior, routing, account state, client configuration, compaction, retries, or proxy lifecycle code.

After an impacting runtime change, run the required deterministic tests first, then activate the change with `./scripts/restart-proxy.zsh` and verify that `started_at_ms` advanced at `http://127.0.0.1:47778/_codex-auth-advanced/health`. Never use `kill`, `pkill`, or direct process termination to restart the provider proxy; doing so can drop in-flight streams and block active sessions.
