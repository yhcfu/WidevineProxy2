# Build & Release Guide

## 1. 前提ツール
- Rust (cargo) 1.80 以降
- macOS: `zip` / `unzip`
- Windows: PowerShell + MSVC toolchain (`rustup target add x86_64-pc-windows-msvc`)

> Windows だけでネイティブホストを更新したい場合は `scripts/build-native-host.ps1` も利用できます。

## 2. ネイティブホストと ZIP の一括生成
1. **macOS** で以下を実行し、`native-host/bin/macos/` にバイナリを配置します。
   ```bash
   scripts/build-native-host.sh macos
   ```
2. **Windows** で PowerShell を開き、以下を実行して `native-host/bin/windows/` にバイナリを配置します。
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   scripts\build-native-host.ps1 -Target x86_64-pc-windows-msvc
   ```
3. 両方のバイナリが揃ったら macOS 側で次を実行し、ZIP を生成します。
   ```bash
   PACKAGE_NAME=WidevineProxy2 scripts/package-release.sh
   ```

### Windows 単体でのネイティブホスト更新
上記 PowerShell コマンドだけを実行すれば Windows 版バイナリのみを更新できます（ZIP 化は不要）。

## 3. ハッシュ公開手順
ZIP が生成されたら SHA-256 を計算し、`docs/changelog/changelog.md` の該当バージョンに追記します。
```bash
shasum -a 256 dist/WidevineProxy2.zip
```
Windows では `certutil -hashfile dist\\WidevineProxy2.zip SHA256` を使用してください。

## 4. 配布ポリシー
- Windows 版 ZIP には `install-windows-native-host.ps1` と `native-host/bin/windows/*.exe` を同梱。
- macOS 版 ZIP は `install-macos-native-host.sh` と `native-host/bin/macos/*` を同梱。
- 各 OS の README には `Getting Started` へのリンクのみ残し、詳細は docs 側で管理します。

## 5. 手動テストチェックリスト
1. Chrome で unpacked 版を読み込み、キー取得 → オーバーレイ表示を確認。
2. パネル UI でジョブキューの追加/再送が動作するか。
3. ネイティブホストが `yt-dlp → mp4decrypt → ffmpeg` を実行し、`WIDEVINEPROXY2_OUTPUT_DIR` に成果物が配置されるか。
4. `install-* --self-test` と Service Worker ログの双方で接続が確認できるか。

## 6. リリース後タスク
- `docs/changelog/` の該当セクションを更新。
- `dist/` を最新 ZIP で差し替え、必要なら GitHub Release へアップロード。
- 旧バージョンとの差分を README / panel UI のスクリーンショットとともに共有。
