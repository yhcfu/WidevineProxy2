# プロジェクト名（フォーク版）

このプロジェクトは [WidevineProxy2](https://github.com/DevLARLEY/WidevineProxy2) をフォークしたものであり、  
[GNU General Public License v3.0](./LICENSE) のもとでライセンスされています。

## 📄 概要

本フォークでは以下の変更を加えています：

- Widevine キー取得と連動した yt-dlp → mp4decrypt → ffmpeg の自動ダウンロード機能を実装
- 「この動画をDL」オーバーレイやパネル UI を拡張し、ネイティブホストの進捗・再送・ログ確認を行えるように改善
- Windows/macOS どちらも ZIP + ルートスクリプトでネイティブホストを導入できるよう配布手順とドキュメントを整理

## 🛠 インストール

### Windows でネイティブホストを導入
1. リポジトリをダウンロード（`Code → Download ZIP`）して任意のフォルダへ展開します。
2. Chrome で `chrome://extensions/` を開き、`Developer mode` をオンにしてから `Load unpacked` で展開したフォルダを読み込みます。
3. 表示された拡張カードの `ID` を控えたあと、PowerShell でリポジトリルートに移動します。
4. 一時的にスクリプトを許可し、セットアップを実行します。
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\install-windows-native-host.ps1           # プロンプトに従って拡張IDを入力
   ```
5. `chrome://extensions/` → 対象拡張の Service Worker コンソールで `Native host: connected` が表示されれば完了です。

### macOS でネイティブホストを導入
1. 上記と同様に拡張機能を `Load unpacked` し、表示された Extension ID を控えます。
2. ターミナルでリポジトリルートに移動し、ルートスクリプトを実行します。
   ```bash
   chmod +x install-macos-native-host.sh
   ./install-macos-native-host.sh               # プロンプトに従って拡張IDを入力
   ```
3. スクリプト完了後、`~/.local/share/WidevineProxy2/widevineproxy2-host --self-test` を実行して `pong` 応答が返るか確認してください。

## 📚 ドキュメントへの導線
- Getting Started: `docs/getting-started/overview.md`
- Build & Release: `docs/development/build-and-release.md`
- Architecture: `docs/architecture/`
- Changelog: `docs/changelog/changelog.md`

## 🔗 元リポジトリ

- **ソース:** https://github.com/DevLARLEY/WidevineProxy2  
- **ライセンス:** GPL-3.0  
- **著作権表記:** © WidevineProxy2 Contributors

## ⚖️ ライセンス

このフォークは、[GNU General Public License v3.0](./LICENSE) の条件に従い再配布されています。  
詳細は同梱の `LICENSE` ファイルを参照してください。
