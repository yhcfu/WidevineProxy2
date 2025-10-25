#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
PACKAGE_NAME="${1:-${PACKAGE_NAME:-WidevineProxy2}}"
MAC_BIN="${ROOT_DIR}/native-host/bin/macos/widevineproxy2-host"
WIN_BIN="${ROOT_DIR}/native-host/bin/windows/widevineproxy2-host.exe"
OUTPUT_ZIP="${DIST_DIR}/${PACKAGE_NAME}.zip"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[error] '$1' が見つかりません。インストールしてから再実行してください。" >&2
    exit 1
  fi
}

require_cmd zip

if [[ ! -f "$MAC_BIN" || ! -f "$WIN_BIN" ]]; then
  echo "[error] バイナリが揃っていません。macOS: $MAC_BIN / Windows: $WIN_BIN" >&2
  echo "macOS で 'scripts/build-native-host.sh macos'、Windows で 'scripts/build-native-host.ps1' を実行してから再度パッケージ化してください。" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
rm -f "$OUTPUT_ZIP"
pushd "$ROOT_DIR" >/dev/null
zip -r "$OUTPUT_ZIP" . \
  -x '.git/*' \
     'dist/*' \
     'native-host/target/*' \
     'native-host/widevineproxy2-host' \
     'native-host/widevineproxy2-host.exe' \
     '*.DS_Store' \
     '*.log' \
     '*.tmp' \
     '*.swp'
popd >/dev/null

echo "[done] Release ZIP -> $OUTPUT_ZIP"
