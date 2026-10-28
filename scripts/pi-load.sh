#!/usr/bin/env bash
# Prove the extension factory loads in a real Pi process without any LLM.
# A fake provider points at a dead port (127.0.0.1:9): the model call is
# expected to fail, and we assert that no *extension* load error appears.
# Uses an isolated config dir; never touches the machine's real Pi config.
set -euo pipefail
cd "$(dirname "$0")/.."

npm install -g @earendil-works/pi-coding-agent >/dev/null 2>&1

agent_dir=$(mktemp -d)
trap 'rm -rf "$agent_dir"' EXIT
mkdir -p "$agent_dir"
cat > "$agent_dir/models.json" <<'EOF'
{
  "providers": {
    "fakeci": {
      "baseUrl": "http://127.0.0.1:9/v1",
      "api": "openai-completions",
      "apiKey": "fake",
      "models": [ { "id": "x" } ]
    }
  }
}
EOF

set +e
out=$(PI_CODING_AGENT_DIR="$agent_dir" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 \
  pi -e ./index.ts --model fakeci/x --print "hello" 2>&1)
rc=$?
set -e

echo "--- pi output (tail) ---"
echo "$out" | tail -n 8
echo "-------------------------"

if echo "$out" | grep -qiE "extension error|failed to load extension|cannot find module"; then
  echo "FAIL: extension did not load cleanly in real Pi" >&2
  exit 1
fi
echo "PASS: extension loaded in real Pi without an LLM (model call failed as expected, rc=$rc)"
