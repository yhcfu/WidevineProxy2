#!/usr/bin/env bash
set -euo pipefail

EXTENSION_ID=${EXTENSION_ID:-${EXTENSION:-}}
MANIFEST_NAME=${MANIFEST_NAME:-com.widevineproxy2.downloader.json}

if [[ -z "$EXTENSION_ID" ]]; then
  echo "[error] 環境変数 EXTENSION_ID を設定してください。" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR_MACOS="${SCRIPT_DIR}/bin/macos/widevineproxy2-host"
BIN_DIR_LINUX="${SCRIPT_DIR}/bin/linux/widevineproxy2-host"
LEGACY_BIN="${SCRIPT_DIR}/widevineproxy2-host"
TARGET_RELEASE_BIN="${SCRIPT_DIR}/target/release/widevineproxy2-host"
BINARY_OVERRIDE="${BINARY_SOURCE:-${NATIVE_HOST_BINARY_SOURCE:-}}"

if [[ -n "$BINARY_OVERRIDE" ]]; then
  if [[ -f "$BINARY_OVERRIDE" ]]; then
    BINARY_SOURCE="$BINARY_OVERRIDE"
  else
    echo "[error] 指定されたバイナリが見つかりません: $BINARY_OVERRIDE" >&2
    exit 1
  fi
elif [[ -f "$BIN_DIR_MACOS" ]]; then
  BINARY_SOURCE="$BIN_DIR_MACOS"
elif [[ -f "$BIN_DIR_LINUX" ]]; then
  BINARY_SOURCE="$BIN_DIR_LINUX"
elif [[ -f "$LEGACY_BIN" ]]; then
  BINARY_SOURCE="$LEGACY_BIN"
elif [[ -f "$TARGET_RELEASE_BIN" ]]; then
  BINARY_SOURCE="$TARGET_RELEASE_BIN"
else
  cat >&2 <<'MSG'
[error] widevineproxy2-host が見つかりません。
[hint] `scripts/build-native-host.sh macos` もしくは `cargo build --release -p native-host` でバイナリを生成し、install.sh を再実行してください。
MSG
  exit 1
fi

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

MANIFEST_TEMPLATE="${SCRIPT_DIR}/${MANIFEST_NAME}"
if [[ ! -f "$MANIFEST_TEMPLATE" ]]; then
  echo "[error] マニフェストテンプレートが見つかりません: $MANIFEST_TEMPLATE" >&2
  exit 1
fi

mkdir -p "$TARGET_ROOT" "$MANIFEST_DIR"

MANIFEST_TARGET="${MANIFEST_DIR}/${MANIFEST_NAME}"
BINARY_DEST="${TARGET_ROOT}/widevineproxy2-host"

python3 - "$MANIFEST_TEMPLATE" "$MANIFEST_TARGET" "$BINARY_DEST" "$EXTENSION_ID" <<'PY'
import pathlib
import sys

template_path = pathlib.Path(sys.argv[1])
target_path = pathlib.Path(sys.argv[2])
binary_path = pathlib.Path(sys.argv[3]).resolve()
extension_id = sys.argv[4]

content = template_path.read_text(encoding="utf-8")
content = content.replace("__HOST_BINARY__", str(binary_path))
content = content.replace("__EXTENSION_ID__", extension_id)
target_path.write_text(content, encoding="utf-8")
PY

cp "$BINARY_SOURCE" "$BINARY_DEST"
chmod +x "$BINARY_DEST"

echo "[info] マニフェストを ${MANIFEST_TARGET} に配置しました。"
echo "[info] バイナリを ${BINARY_DEST} に配置しました。"

if [[ "$OS_NAME" == "Darwin" ]]; then
  LEGACY_MANIFEST="/Library/Google/Chrome/NativeMessagingHosts/${MANIFEST_NAME}"
  LEGACY_BINARY="/Library/WidevineProxy2/widevineproxy2-host"
  if [[ -e "$LEGACY_MANIFEST" ]]; then
    if rm -f "$LEGACY_MANIFEST" 2>/dev/null; then
      echo "[info] 旧システムスコープのマニフェスト(${LEGACY_MANIFEST})を削除しました。"
    else
      echo "[warn] 旧マニフェストが /Library 配下に残っています: ${LEGACY_MANIFEST} (削除には sudo が必要です)" >&2
    fi
  fi
  if [[ -e "$LEGACY_BINARY" ]]; then
    if rm -f "$LEGACY_BINARY" 2>/dev/null; then
      echo "[info] 旧バイナリ(${LEGACY_BINARY})を削除しました。"
    else
      echo "[warn] /Library/WidevineProxy2 の旧バイナリを削除できませんでした (root 権限が必要です)" >&2
    fi
  fi
else
  LEGACY_MANIFEST="/etc/opt/chrome/nativeMessagingHosts/${MANIFEST_NAME}"
  if [[ -e "$LEGACY_MANIFEST" ]]; then
    echo "[warn] system-wide manifest が残っています: ${LEGACY_MANIFEST} (sudo で削除してください)" >&2
  fi
  LEGACY_MANIFEST_CHROMIUM="/etc/chromium/nativeMessagingHosts/${MANIFEST_NAME}"
  if [[ -e "$LEGACY_MANIFEST_CHROMIUM" ]]; then
    echo "[warn] system-wide Chromium manifest が残っています: ${LEGACY_MANIFEST_CHROMIUM}" >&2
  fi
fi

cat <<EOS
[info] インストールが完了しました。
[next] 1) Chrome/Edge で chrome://extensions/ を開き、WidevineProxy2 を「再読み込み」。
[next] 2) 「Service Worker」のコンソールで "Native host: connected" が表示されるか確認。
[next] 3) ~/.local/share/WidevineProxy2/widevineproxy2-host --self-test を実行し、pong 応答を確認してください。
EOS
