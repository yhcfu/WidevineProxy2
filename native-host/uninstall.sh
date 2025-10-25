#!/usr/bin/env bash
set -euo pipefail

MANIFEST_NAME=${MANIFEST_NAME:-com.widevineproxy2.downloader.json}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Darwin)
    MANIFEST_DIR=${MANIFEST_DIR:-"$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"}
    TARGET_ROOT=${TARGET_ROOT:-"$HOME/.local/share/WidevineProxy2"}
    ;;
  Linux*)
    MANIFEST_DIR=${MANIFEST_DIR:-$HOME/.config/google-chrome/NativeMessagingHosts}
    TARGET_ROOT=${TARGET_ROOT:-$HOME/.local/share/WidevineProxy2}
    ;;
  *)
    echo "[error] 未対応の OS です: $OS_NAME" >&2
    exit 1
    ;;
esac

: "${TARGET_ROOT:?TARGET_ROOT が空です}"

MANIFEST_TARGET="${MANIFEST_DIR}/${MANIFEST_NAME}"
if [[ -f "$MANIFEST_TARGET" ]]; then
  rm -f "$MANIFEST_TARGET"
  echo "[info] マニフェストを削除しました: $MANIFEST_TARGET"
fi

if [[ -f "${TARGET_ROOT}/widevineproxy2-host" ]]; then
  rm -f "${TARGET_ROOT}/widevineproxy2-host"
  echo "[info] バイナリを削除しました: ${TARGET_ROOT}/widevineproxy2-host"
fi

if [[ -d "$TARGET_ROOT" ]]; then
  rmdir "$TARGET_ROOT" 2>/dev/null || true
fi

if [[ "$OS_NAME" == "Darwin" ]]; then
  LEGACY_MANIFEST="/Library/Google/Chrome/NativeMessagingHosts/${MANIFEST_NAME}"
  LEGACY_BINARY="/Library/WidevineProxy2/widevineproxy2-host"
  if [[ -e "$LEGACY_MANIFEST" ]]; then
    if rm -f "$LEGACY_MANIFEST" 2>/dev/null; then
      echo "[info] システムスコープの旧マニフェスト(${LEGACY_MANIFEST})も削除しました。"
    else
      echo "[warn] システムスコープのマニフェストを削除できませんでした。sudo で手動削除してください: ${LEGACY_MANIFEST}" >&2
    fi
  fi
  if [[ -e "$LEGACY_BINARY" ]]; then
    if rm -f "$LEGACY_BINARY" 2>/dev/null; then
      echo "[info] /Library/WidevineProxy2 の旧バイナリを削除しました。"
    else
      echo "[warn] /Library/WidevineProxy2/widevineproxy2-host を削除できませんでした。sudo で削除してください。" >&2
    fi
  fi
fi

echo "[info] アンインストールが完了しました。"
