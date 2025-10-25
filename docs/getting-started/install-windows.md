# Windows でのインストール手順

## 1. 拡張の読み込み
1. GitHub から ZIP を取得して任意のパスへ展開。
2. Chrome で `chrome://extensions/` → `Developer mode` を ON。
3. `Load unpacked` から展開フォルダを選び、カードに表示される `ID` を控える。

## 2. ネイティブホストの導入
1. PowerShell をリポジトリルートで開く。
2. 一時的にスクリプトを許可してインストーラを実行。
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\install-windows-native-host.ps1
   ```
3. プロンプトで `EXTENSION_ID` と保存先などを入力。`native-host/install.ps1` が内部で呼ばれ、`%LOCALAPPDATA%\WidevineProxy2\NativeMessaging` に manifest を配置する。

## 3. 動作確認
- `chrome://extensions/` → 対象拡張 → Service Worker コンソールで `Native host: connected` が出るか確認。
- `native-host/bin/windows/widevineproxy2-host.exe --self-test` で `pong` が返るかチェック。

## 4. アップデート / 再登録
- 拡張 ID が変わった場合は `install-windows-native-host.ps1 -ManifestOnly` を実行。
- 旧版が `C:\Program Files\WidevineProxy2` に残っている場合は削除後に再インストール。

## 5. トラブルシュート
| 症状 | 対処 |
| --- | --- |
| 署名未確認警告 | ZIP の SHA-256 を照合後に続行。|
| `Native host disconnected` | PowerShell で `native-host/bin/... --self-test` を実行して接続可否を切り分け。|
| yt-dlp が見つからない | `WIDEVINEPROXY2_BIN_yt_dlp` で絶対パスを渡す。|
