# Changelog

## 0.1.0 – 2025-10-25
### 背景
- Phase 0〜3 までのネイティブホスト自動化を安定化。
- Windows 向け配布を「unpacked extension + ルート PowerShell スクリプト + 事前ビルド済みバイナリ」構成へ一本化。
- SHA-256 公開値を標準化。

### 配布アセット
このバージョンの ZIP / バイナリは現在準備中です。macOS で `scripts/build-native-host.sh macos`、Windows で `scripts\build-native-host.ps1` を実行してプリビルドを揃え、`scripts/package-release.sh` で `dist/` に ZIP を出力したタイミングで SHA-256 を追記してください。

### アップデート概要
- `install-windows-native-host.ps1` とプリビルド exe を ZIP に同梱。Cargo 環境無しで導入可能。
- `install.ps1 -ManifestOnly` を追加し、ID 変更時の manifest 再生成に対応。
- `docs/getting-started` 系ドキュメントへ install 手順を移管し、README は概要リンクのみ保持。

### ハッシュ計算コマンド例
```bash
shasum -a 256 dist/WidevineProxy2.zip
shasum -a 256 native-host/target/release/widevineproxy2-host
# Windows
certutil -hashfile dist\WidevineProxy2.zip SHA256
```
