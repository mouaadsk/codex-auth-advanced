import { spawnSync } from "node:child_process";

// All of these tests use local fixtures or mocked fetch, not live providers.
const tests = [
  "test-chat-responses-bridge.mjs",
  "test-antigravity-bridge.mjs",
  "test-endpoint-chain.mjs",
  "test-shape-translator.mjs",
  "test-shape-probe.mjs",
  "test-shape-probe-store.mjs",
  "test-shape-probe-live.mjs",
  "test-provider-proxy-http.mjs",
  "test-provider-proxy-regressions.mjs"
];

for (const test of tests) {
  const checked = spawnSync(process.execPath, ["--check", test], { stdio: "inherit" });
  if (checked.error) throw checked.error;
  if (checked.status !== 0) process.exit(checked.status || 1);
  const result = spawnSync(process.execPath, [test], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
