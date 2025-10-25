#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_MANIFEST="${ROOT_DIR}/native-host/Cargo.toml"
MAC_BIN_DIR="${ROOT_DIR}/native-host/bin/macos"
PLATFORM="${1:-macos}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[error] '$1' が見つかりません。インストールしてから再実行してください。" >&2
    exit 1
  fi
}

build_macos() {
  require_cmd cargo
  local binary_name="widevineproxy2-host"
  local source_path="${ROOT_DIR}/native-host/target/release/${binary_name}"
  echo "[info] macOS build (cargo)"
  cargo build --release --manifest-path "$CARGO_MANIFEST"
  if [[ ! -f "$source_path" ]]; then
    echo "[error] macOS ビルド成果物が見つかりません: $source_path" >&2
    exit 1
  fi
  mkdir -p "$MAC_BIN_DIR"
  cp "$source_path" "$MAC_BIN_DIR/${binary_name}"
  chmod +x "$MAC_BIN_DIR/${binary_name}"
  echo "[done] macOS バイナリ -> $MAC_BIN_DIR/${binary_name}"
}

case "$PLATFORM" in
  macos) build_macos ;;
  windows)
    echo "[warn] Windows ビルドはサポートされていません。Windows 環境で 'scripts/build-native-host.ps1' を実行してください。" >&2
    exit 1
    ;;
  all)
    build_macos
    echo "[info] Windows 版は Windows 上で 'scripts/build-native-host.ps1' を実行して生成してください。"
    ;;
  *)
    echo "使い方: scripts/build-native-host.sh [macos|windows|all]" >&2
    exit 1
    ;;
esac
