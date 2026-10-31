import assert from "node:assert/strict";
import { redactProxyLogValue } from "./src/provider-proxy-http.mjs";

for (const name of ["key", "api_key", "api-key", "access_token", "token", "authorization", "signature", "KEY"]) {
  const url = `https://example.test/generate?${name}=private-secret&alt=sse`;
  const result = redactProxyLogValue(url);
  assert.ok(!result.includes("private-secret"), name);
  assert.ok(result.includes("&alt=sse"), "preserve non-secret diagnostics");
  assert.ok(result.includes("[REDACTED]"));
  assert.ok(!redactProxyLogValue(JSON.stringify({ url })).includes("private-secret"));
}
assert.equal(
  redactProxyLogValue("https://username:password@example.test/v1"),
  "https://[REDACTED]@example.test/v1"
);
assert.equal(redactProxyLogValue("status=502 model=example"), "status=502 model=example");
console.log("provider proxy HTTP redaction ok");
