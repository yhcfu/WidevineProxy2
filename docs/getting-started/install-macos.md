# macOS でのインストール手順

## 1. 拡張の読み込み
1. Chrome で `chrome://extensions/` を開き、`Load unpacked` でリポジトリを読み込む。
2. カードの `ID` を控える。manifest の `allowed_origins` に必要。

## 2. ネイティブホストの導入
1. ターミナルでリポジトリルートへ移動。
2. 実行権限を付与してインストーラを起動。
   ```bash
   chmod +x install-macos-native-host.sh
   ./install-macos-native-host.sh
   ```
3. プロンプトに沿って `EXTENSION_ID` や出力先を指定。`~/Library/Application Support/Google/Chrome/NativeMessagingHosts` 以下に manifest が生成される。

## 3. 動作確認
- `~/.local/share/WidevineProxy2/widevineproxy2-host --self-test` で `pong` を確認。
- Chrome の Service Worker コンソールに `Native host: connected` が表示されるかチェック。

## 4. 旧版クリーンアップ
- 旧 `/Library/WidevineProxy2` や `/Library/Google/Chrome/NativeMessagingHosts` に残る manifest は削除。
- `install-macos-native-host.sh --manifest-only` で ID 更新のみ可能。

## 5. トラブルシュート
| 症状 | 対処 |
| --- | --- |
| `permission denied` | `chmod +x install-macos-native-host.sh` を再実行。|
| `yt-dlp: command not found` | `brew install yt-dlp` または `WIDEVINEPROXY2_BIN_yt_dlp` を使用。|
| `Native host disconnected` | `launchctl list | grep widevineproxy2` でプロセス確認、`--self-test` で再チェック。|
