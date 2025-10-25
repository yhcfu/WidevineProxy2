#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SCRIPT="${ROOT_DIR}/native-host/install.sh"
GUIDE_URL="https://github.com/yhcfu/WidevineProxy2/blob/main/docs/getting-started/install-macos.md"
BIN_CANDIDATES=(
  "${ROOT_DIR}/native-host/bin/macos/widevineproxy2-host"
  "${ROOT_DIR}/native-host/widevineproxy2-host"
  "${ROOT_DIR}/native-host/target/release/widevineproxy2-host"
)

if [[ ! -f "$INSTALL_SCRIPT" ]]; then
  cat >&2 <<MSG
[warn] native-host/install.sh が見つかりません: $INSTALL_SCRIPT
[hint] ネイティブホスト導入手順 ($GUIDE_URL) を開き、ZIP を最新化するか再展開してください。
[help] `git clean -fdx && git checkout -- .` でも必要ファイルを取り直せます (未コミット変更に注意)。
MSG
  exit 1
fi

BINARY_SOURCE=""
for candidate in "${BIN_CANDIDATES[@]}"; do
  if [[ -f "$candidate" ]]; then
    BINARY_SOURCE="$candidate"
    break
  fi
done

if [[ -z "$BINARY_SOURCE" ]]; then
cat >&2 <<MSG
[warn] 事前ビルド済み macOS バイナリが見つかりませんでした。
[todo] まずは `scripts/build-native-host.sh macos` で `native-host/bin/macos/` 以下に生成するか、$GUIDE_URL 内のリリース手順で ZIP を取得してください。
[hint] バイナリ配置後に再度 install-macos-native-host.sh を実行してください。
MSG
  exit 1
fi

echo "[info] Chrome の拡張カードに表示された Extension ID を入力してください。"
read -rp "Extension ID: " EXT_ID
if [[ -z "$EXT_ID" ]]; then
  echo "[error] Extension ID が空です。" >&2
  exit 1
fi

export EXTENSION_ID="$EXT_ID"
export MANIFEST_NAME="com.widevineproxy2.downloader.json"
export BINARY_SOURCE="$BINARY_SOURCE"

( cd "$ROOT_DIR/native-host" && ./install.sh )

echo "[done] インストール完了: ~/.local/share/WidevineProxy2/widevineproxy2-host"
echo "[hint] 次のコマンドで動作確認できます: ~/.local/share/WidevineProxy2/widevineproxy2-host --self-test"
