# プロジェクト名（フォーク版）

このプロジェクトは [WidevineProxy2](https://github.com/DevLARLEY/WidevineProxy2) をフォークしたものであり、  
[GNU General Public License v3.0](./LICENSE) のもとでライセンスされています。

## 📄 概要

本フォークでは以下の変更を加えています：

- Widevine キー取得と連動した yt-dlp → mp4decrypt → ffmpeg の自動ダウンロード機能を実装
- 「この動画をDL」オーバーレイやパネル UI を拡張し、ネイティブホストの進捗・再送・ログ確認を行えるように改善
- Windows/macOS どちらも ZIP + ルートスクリプトでネイティブホストを導入できるよう配布手順とドキュメントを整理

## 🛠 インストール

### Windows でのセットアップ手順

**事前チェック**
- Microsoft Edge / Google Chrome いずれかをインストール済みであること。
- `yt-dlp` / `ffmpeg` / `mp4decrypt` をまだ入れていなければ、あとで PowerShell がガイドを出すので指示に従って準備してください。

**拡張の読み込み**
1. GitHub から ZIP を取得し、任意のフォルダへ展開します。
2. Chrome/Edge で `chrome://extensions/` を開き、右上の「デベロッパーモード」をオンにします。
3. 「パッケージ化されていない拡張機能を読み込む」から展開フォルダを選択し、表示された拡張カードの `ID` を控えます（例: `abcdefghijklmnopabcdefghijklmnop`）。

**ネイティブホストの登録**
1. PowerShell 7 (`pwsh`) を開き、展開したフォルダ（`install-windows-native-host.ps1` がある場所）に移動します。PowerShell 7 のインストール手順は [Microsoft Docs](https://learn.microsoft.com/powershell/scripting/install/installing-powershell) にまとまっています。
2. 一時的にスクリプト実行を許可し、インストールスクリプトを走らせます。
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\install-windows-native-host.ps1
   ```
3. プロンプトに従って拡張 ID を入力します。`yt-dlp` などが PATH にない場合は、自動で導入ガイドが表示されます。

**動作確認**
- PowerShell で `native-host\bin\windows\widevineproxy2-host.exe --self-test` を実行し、`pong` が返るか確認します。
- `chrome://extensions/` → 対象拡張 → 「Service Worker」コンソールに `Native host: connected` と出れば接続成功です。
- 必要に応じて Windows を再起動し、レジストリの反映や PATH の更新を確実にします。

### macOS でのセットアップ手順

**事前チェック**
- 最新の Xcode Command Line Tools と Homebrew を導入済みだと便利です。
- `yt-dlp` / `ffmpeg` / `mp4decrypt` は Homebrew で `brew install yt-dlp ffmpeg bento4` のようにまとめて入れると後が楽になります。

**拡張の読み込み**
1. Windows と同様に ZIP を展開し、Chrome/Edge で `Load unpacked` を使って読み込みます。
2. 拡張カードの `ID` を控えておきます。

**ネイティブホストの登録**
1. ターミナル（PowerShell 7 もしくは bash/zsh）でリポジトリルートに移動し、スクリプトを実行可能にします。
   ```bash
   chmod +x install-macos-native-host.sh
   ./install-macos-native-host.sh
   ```
2. プロンプトに従って拡張 ID を入力します。入力内容は `native-host/install.ps1` に引き渡され、Chrome 側のマニフェストが自動で書き換わります。

**動作確認**
- `~/.local/share/WidevineProxy2/widevineproxy2-host --self-test` を実行し、`pong` と応答するかをチェックします。
- `chrome://extensions/` の Service Worker ログで `Native host: connected` を確認し、問題があれば再度スクリプトを実行してください。

**補足**
- macOS ではセキュリティポリシーの関係で初回実行時に Gatekeeper の許可が求められる場合があります。その際はシステム環境設定 →「セキュリティとプライバシー」から実行を許可してください。

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
