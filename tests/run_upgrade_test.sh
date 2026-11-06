#!/usr/bin/env bash
# Install the current build over an older one that has saved chats, with AI Chat moved to
# the top of the item pane and a PDF tab open, without restarting Zotero. The chats must
# show in the library and in the PDF tab that stayed open, and again after a restart.
# Runs in a throwaway profile; your real library is never opened.
#
# Usage: tests/run_upgrade_test.sh [WORKDIR]
#   OLD_REF     git ref of the build installed first (default dcf7874, which is 1.3.1)
#   ZOTERO_BIN  path to the zotero launcher (default /opt/zotero/zotero)
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

rm -rf "$work/old" "$work/profile" "$work"/result*.json
mkdir -p "$work/old" "$work/profile/extensions"
git -C "$repo" archive "${OLD_REF:-dcf7874}" src | tar -x -C "$work/old"
(cd "$work/old/src" && zip -r -X -q "$work/old.xpi" . -x '.*')
"$repo/build.sh" > /dev/null
version=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$repo/src/manifest.json")
cp "$repo/build/zotero-ai-chat-$version.xpi" "$work/new.xpi"
python3 "$here/make_test_pdf.py" "$work/paper.pdf"

cp "$work/old.xpi" "$work/profile/extensions/zotero-ai-chat@suresh-inbit.xpi"
printf '%s' "$here/upgrade" > "$work/profile/extensions/upgrade-test@test.local"
cat > "$work/profile/user.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$work/profile/zotero-data");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.update.enabled", false);
user_pref("app.update.enabled", false);
user_pref("extensions.zotero.httpServer.enabled", false);
user_pref("extensions.upgradetest.newXpi", "$work/new.xpi");
user_pref("extensions.upgradetest.newVersion", "$version");
user_pref("extensions.upgradetest.pdf", "$work/paper.pdf");
PREFS

run_zotero() {
	MOZ_HEADLESS="${HEADLESS:-1}" timeout 240 "$zotero" -no-remote -profile "$work/profile" \
		-datadir "$work/profile/zotero-data" > "$work/zotero-$1.log" 2>&1 || true
}

echo "Running Zotero: old build, then the new one installed over it (work dir: $work) ..."
echo "user_pref(\"extensions.upgradetest.out\", \"$work/result1.json\");" >> "$work/profile/user.js"
run_zotero 1
echo "Restarting Zotero with the new build ..."
echo "user_pref(\"extensions.upgradetest.out\", \"$work/result2.json\");" >> "$work/profile/user.js"
echo 'user_pref("extensions.upgradetest.phase", 2);' >> "$work/profile/user.js"
run_zotero 2

python3 - "$work/result1.json" "$work/result2.json" <<'PY'
import json, sys
results = []
for path in sys.argv[1:]:
    try:
        results += json.load(open(path))
    except FileNotFoundError:
        results.append({"name": f"{path} was not written", "ok": False, "detail": "see zotero-*.log in the work dir"})
for r in results:
    print(("  ok   " if r["ok"] else "  FAIL ") + r["name"] + ("" if r["ok"] or not r["detail"] else "\n       " + r["detail"]))
failed = [r for r in results if not r["ok"]]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)
PY
