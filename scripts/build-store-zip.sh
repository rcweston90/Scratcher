#!/usr/bin/env bash
# Builds the Chrome Web Store upload: only the files the extension runs on.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
out="dist/scratcher-${version}.zip"
mkdir -p dist
rm -f "$out"
zip -X -q "$out" manifest.json background.js panel.html panel.css panel.js \
  icons/16.png icons/32.png icons/48.png icons/128.png
echo "$out"
