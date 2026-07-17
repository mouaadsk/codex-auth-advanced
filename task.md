# Tasks

## Postponed

- [ ] Add Windows installation and service management.
  - Install or link the CLI from a cloned checkout.
  - Register the provider proxy as a per-user Windows background service.
  - Configure installed Codex and Claude Code clients without overwriting unrelated settings.
  - Preserve the same graceful drain-and-restart lifecycle used on macOS.

- [ ] Add account/profile-level VSLLM model tier selection.
  - Store `vsllm_model_tier = "normal" | "pro20x"` per account or profile.
  - Route the same Codex model name to either the normal VSLLM model or its `-pro20x` variant based on the active account/profile.
  - Keep the current default behavior until this task is resumed: `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` route to their VSLLM `-pro20x` variants.
  - Do not expose or activate tier switching yet.
