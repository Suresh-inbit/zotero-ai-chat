#!/usr/bin/env bash
# Install the current build over an older one without restarting Zotero, then check
# that the new styles are in effect (the crop overlay must cover the whole window) and
# that maths renders with the fonts inside the new build.
# Runs in a throwaway profile; your real library is never opened.
#
# Usage: tests/run_reinstall_test.sh [WORKDIR]
#   OLD_REF     git ref of the build installed first (default v1.0.0)
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

rm -rf "$work/old" "$work/profile" "$work/result.json"
mkdir -p "$work/old" "$work/profile/extensions"
git -C "$repo" archive "${OLD_REF:-v1.0.0}" src | tar -x -C "$work/old"
(cd "$work/old/src" && zip -r -X -q "$work/old.xpi" . -x '.*')
"$repo/build.sh" > /dev/null
version=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$repo/src/manifest.json")
cp "$repo/build/zotero-ai-chat-$version.xpi" "$work/new.xpi"

cp "$work/old.xpi" "$work/profile/extensions/zotero-ai-chat@suresh-inbit.xpi"
printf '%s' "$here/reinstall" > "$work/profile/extensions/reinstall-test@test.local"
cat > "$work/profile/user.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$work/profile/zotero-data");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.update.enabled", false);
user_pref("app.update.enabled", false);
user_pref("extensions.zotero.httpServer.enabled", false);
user_pref("extensions.reinstalltest.newXpi", "$work/new.xpi");
user_pref("extensions.reinstalltest.out", "$work/result.json");
PREFS

echo "Running Zotero (work dir: $work) ..."
MOZ_HEADLESS="${HEADLESS:-1}" timeout 180 "$zotero" -no-remote -profile "$work/profile" \
	-datadir "$work/profile/zotero-data" > "$work/zotero.log" 2>&1 || true

python3 - "$work/result.json" <<'PY'
import json, sys
try:
    r = json.load(open(sys.argv[1]))
except FileNotFoundError:
    print("FAIL: no result; see zotero.log in the work dir"); sys.exit(2)
if "error" in r:
    print("FAIL:", r["error"]); sys.exit(1)
o, w = r["overlay"], r["window"]
checks = [
    ("old build loaded first", r.get("oldVersionLoaded")),
    ("new build replaced it without a restart", r.get("newVersionLoaded")),
    ("chat uses the new build's styles", r.get("composerRadius") == "10px"),
    ("crop overlay uses the new styles (position: fixed)", o["position"] == "fixed"),
    ("crop overlay covers the whole window",
     o["left"] <= 1 and o["top"] <= 1 and o["width"] >= w["w"] - 1 and o["height"] >= w["h"] - 1),
    ("maths renders after the upgrade", r.get("formulas") == 2),
    ("KaTeX fonts load from the new build",
     r.get("katexFontsLoaded", 0) >= 2 and r.get("katexFontsFailed") == 0),
]
for name, ok in checks:
    print(("  ok   " if ok else "  FAIL ") + name)
print(f"  overlay {o['left']:.0f},{o['top']:.0f} {o['width']:.0f}x{o['height']:.0f} in window {w['w']}x{w['h']}")
sys.exit(0 if all(ok for _, ok in checks) else 1)
PY
