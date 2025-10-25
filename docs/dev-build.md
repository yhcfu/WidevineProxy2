# Developer Build Notes

## 前提ツール
- macOS: `cargo`, `zip`
- Windows: PowerShell + `cargo`（MSVC toolchain）

## プリビルド生成
1. **macOS**: リポジトリルートで次を実行し、`native-host/bin/macos/widevineproxy2-host` を生成します。
   ```bash
   scripts/build-native-host.sh macos
   ```
2. **Windows**: PowerShell を開き、次を実行して `native-host/bin/windows/widevineproxy2-host.exe` を作成します。
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   scripts\build-native-host.ps1 -Target x86_64-pc-windows-msvc
   ```

## パッケージ化
1. 両プラットフォームのプリビルドが揃った状態で以下を実行します。
   ```bash
   scripts/package-release.sh WidevineProxy2
   ```
   `PACKAGE_NAME=ForkName scripts/package-release.sh` のように環境変数でも名称変更できます。
2. `dist/WidevineProxy2.zip` が生成されます。念のため内容とハッシュを確認してください。
   ```bash
   unzip -l dist/WidevineProxy2.zip
   shasum -a 256 dist/WidevineProxy2.zip
   ```
   ハッシュ値は `docs/release-notes.md` に追記してください。
