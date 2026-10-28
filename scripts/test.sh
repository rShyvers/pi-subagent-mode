#!/usr/bin/env bash
# Full local test suite. Used by the pre-commit hook and by CI.
# Exits non-zero on any failure. No network, no models required.
set -u
cd "$(dirname "$0")/.."

fail=0
step() { echo; echo "=== $* ==="; }

step "syntax check bin/model-gate.mjs"
node --check bin/model-gate.mjs || fail=1

step "gate smoke tests (expect 25 passed, 0 failed)"
node test/gate-smoke.mjs || fail=1

step "extension smoke tests (mocked ExtensionAPI)"
node --experimental-strip-types test/extension-smoke.mjs 2>&1 | grep -v "ExperimentalWarning\|Use \`node"
[ "${PIPESTATUS[0]}" -ne 0 ] && fail=1

step "package.json sanity"
node -e '
const p = JSON.parse(require("fs").readFileSync("package.json", "utf8"));
const errs = [];
if (!p.name || !/^[a-z0-9][a-z0-9._-]*$|^@[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*$/i.test(p.name)) errs.push("bad name");
if (p.dependencies) errs.push("must not have dependencies (Node built-ins only)");
if (p.peerDependencies?.["@earendil-works/pi-coding-agent"] !== "*") errs.push("peerDependency pi-coding-agent must be *");
if (!p.keywords?.includes("pi-package")) errs.push("keywords must include pi-package");
if (errs.length) { console.error("package.json problems: " + errs.join(", ")); process.exit(1); }
console.log("package.json OK");
' || fail=1

echo
if [ "$fail" -ne 0 ]; then
  echo "SUITE FAILED - do not commit."
  exit 1
fi
echo "Full suite passed."
