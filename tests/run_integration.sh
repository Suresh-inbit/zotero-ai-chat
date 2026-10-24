#!/usr/bin/env bash
# End-to-end test: runs the plugin inside a throwaway Zotero profile and data
# directory (your real library is never opened), against a local fake API server.
#
# Usage: tests/run_integration.sh [WORKDIR]
#   ZOTERO_BIN  path to the zotero launcher (default /opt/zotero/zotero)
#   HEADLESS=0  show the Zotero window while testing
#   XPI=path    test a built .xpi instead of the src/ folder
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
work="${1:-}"
if [ -z "$work" ]; then
	work="$(mktemp -d)"
fi
mkdir -p "$work"
work="$(cd "$work" && pwd)"
zotero="${ZOTERO_BIN:-/opt/zotero/zotero}"

rm -rf "$work/profile" "$work/out"
mkdir -p "$work/profile/extensions" "$work/out"
: > "$work/requests.jsonl"

port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 "$here/make_test_pdf.py" "$work/test-paper.pdf"

# Proxy files make Zotero load the plugins straight from their source folders
if [ -n "${XPI:-}" ]; then
	cp "$XPI" "$work/profile/extensions/zotero-ai-chat@suresh-inbit.xpi"
	echo "Testing packaged plugin: $XPI"
else
	printf '%s' "$repo/src" > "$work/profile/extensions/zotero-ai-chat@suresh-inbit"
fi
printf '%s' "$here/harness" > "$work/profile/extensions/ui-harness@test.local"

cat > "$work/profile/user.js" <<EOF
user_pref("extensions.zotero.dataDir", "$work/profile/zotero-data");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.startupScanScopes", 15);
user_pref("extensions.update.enabled", false);
user_pref("extensions.zotero.httpServer.enabled", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("extensions.uiharness.outDir", "$work/out");
user_pref("extensions.uiharness.port", $port);
user_pref("extensions.uiharness.pdfPath", "$work/test-paper.pdf");
user_pref("extensions.uiharness.logPath", "$work/requests.jsonl");
EOF

python3 "$here/mock_server.py" "$port" "$work/requests.jsonl" > "$work/mock.log" 2>&1 &
mock=$!
trap 'kill "$mock" 2>/dev/null || true' EXIT

echo "Running Zotero (work dir: $work) ..."
set +e
MOZ_HEADLESS="${HEADLESS:-1}" timeout 300 "$zotero" -no-remote -profile "$work/profile" \
	-datadir "$work/profile/zotero-data" -ZoteroDebugText > "$work/zotero.log" 2>&1
status=$?
set -e
echo "Zotero exited with status $status"

python3 - "$work/out/results.json" <<'EOF'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except FileNotFoundError:
    print("No results file: the harness did not finish. See zotero.log in the work dir.")
    sys.exit(2)
failed = [r for r in data["results"] if not r["ok"]]
for r in data["results"]:
    print(("  ok   " if r["ok"] else "  FAIL ") + r["name"] + ("" if r["ok"] else "\n       " + r["detail"].replace("\n", "\n       ")))
print(f"\n{len(data['results']) - len(failed)}/{len(data['results'])} checks passed")
sys.exit(1 if failed else 0)
EOF
