#!/usr/bin/env bash
# Probe whether VSLLM's gpt-5.6-sol reliably supports Codex 0.147's
# responses-lite wire shape (tools inside input[0] "additional_tools",
# no top-level tools array). Run: bash scripts/check-vsllm-responses-lite.sh [runs]
#
# Success = every run returns a custom_tool_call to exec with the full
# ~13.9k-token input. A working run has outputs like ('custom_tool_call','exec');
# a broken-backend run returns only a message claiming no tools, or errors.
set -u
RUNS="${1:-5}"
PROXY="http://127.0.0.1:47778/_codex-auth-advanced/L1VzZXJzL21vdWFhZC1tYWMvLmNvZGV4"
REQ=/tmp/vsllm-lite-probe-request.json
WORK=/tmp/vsllm-lite-probe

# The request below is a real Codex 0.147 responses-lite payload captured from
# `codex exec --model gpt-5.6-sol` (77,962 bytes, additional_tools namespace).
# Regenerate it if Codex changes the shape: start a capture mirror on the
# openai_base_url and run with a catalog forcing use_responses_lite=true.
if [ ! -f "$REQ" ]; then
  echo "missing $REQ — capture one first (see comment in this script)" >&2
  exit 2
fi

mkdir -p "$WORK"
ok=0
for i in $(seq 1 "$RUNS"); do
  out="$WORK/resp-$i.txt"
  code=$(curl -s -o "$out" -w "%{http_code}" -X POST "$PROXY/responses" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer codex-auth-advanced" \
    --data-binary "@$REQ")
  python3 - "$i" "$code" "$out" <<'EOF'
import json, sys
i, code, path = sys.argv[1], sys.argv[2], sys.argv[3]
body = open(path).read()
usage, outs, err = {}, [], None
for line in body.splitlines():
    if not line.startswith("data: "):
        continue
    try:
        d = json.loads(line[6:])
    except Exception:
        continue
    if d.get("type") == "error":
        err = d.get("code") or d.get("message")
    if d.get("type") == "response.completed":
        r = d.get("response", {})
        usage = r.get("usage", {}) or {}
        outs = [(o.get("type"), o.get("name")) for o in r.get("output", [])]
tool = any(t == "custom_tool_call" for t, _ in outs)
print(f"run {i}: http={code} input={usage.get('input_tokens')} "
      f"tool_call={tool} error={err} outputs={outs}")
sys.exit(0 if tool and not err else 1)
EOF
  [ $? -eq 0 ] && ok=$((ok + 1))
  sleep 2
done
echo "----"
echo "$ok/$RUNS runs used tools via responses-lite"
[ "$ok" -eq "$RUNS" ] && echo "VERDICT: lite format looks supported" || echo "VERDICT: keep direct-mode override"
