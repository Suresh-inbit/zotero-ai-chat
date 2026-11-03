#!/usr/bin/env bash
# Package src/ into an installable Zotero plugin: build/zotero-ai-chat-<version>.xpi
set -euo pipefail

cd "$(dirname "$0")"
version=$(python3 -c 'import json; print(json.load(open("src/manifest.json"))["version"])')
out="build/zotero-ai-chat-${version}.xpi"

mkdir -p build
# Remove older builds so there is only one .xpi to install
rm -f build/zotero-ai-chat-*.xpi
(cd src && zip -r -X -q "../$out" . -x '.*')
echo "Built $out"
