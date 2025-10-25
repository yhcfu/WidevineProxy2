# Getting Started Overview

WidevineProxy2 の基本セットアップ手順と共通設定値をまとめました。OS ごとの詳細は `install-windows.md` / `install-macos.md` を参照してください。

## 必要なアーカイブ
- 拡張本体（`dist/WidevineProxy2.zip`）
- ネイティブホストバイナリ（Windows/macOS 用プリビルド）
- `install-*.sh` / `install-*.ps1` スクリプト
- `SHA256SUMS`

配布物を入手したら、必ず SHA-256 を照合してからスクリプトを実行します。例:
```bash
shasum -a 256 dist/WidevineProxy2.zip
certutil -hashfile dist\WidevineProxy2.zip SHA256
```

## 環境変数一覧
| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `EXTENSION_ID` | *必須* | `allowed_origins` に設定する拡張 ID。`chrome://extensions` で確認。|
| `WIDEVINEPROXY2_OUTPUT_DIR` | `~/Movies` | 最終的な MP4 を配置するルート。|
| `WIDEVINEPROXY2_COOKIES` | `chrome:Default` | `yt-dlp --cookies-from-browser` に渡すプロファイル指定。|
| `WIDEVINEPROXY2_BIN_yt_dlp` 等 | `PATH` から検索 | 依存 CLI の絶対パスを明示したい場合に利用。|
| `WIDEVINEPROXY2_KEEP_DEBUG_ARTIFACTS` | `false` | `1` 指定で中間ディレクトリを削除しない。|

## インストール全体像
1. 拡張を unpacked で読み込み、拡張 ID を控える。
2. OS に応じたインストーラを実行し、`EXTENSION_ID` を渡してネイティブホストを登録。
3. `--self-test` や Service Worker コンソールで接続確認。
4. `install-*.sh/ps1 --manifest-only` で ID 更新にも対応。

## 署名・整合性チェック
- 公式ハッシュは `docs/changelog/changelog.md` に掲載。
- 署名ファイルを検証できない場合は再ダウンロードし、`zip -T` で破損チェック。

## よくある事前チェック
- `yt-dlp`, `mp4decrypt`, `ffmpeg` が PATH から解決できるか。
- Chrome/Edge のバージョンが MV3 サービスワーカーをサポートしているか。
- 旧 `/Library/WidevineProxy2` や HKLM 側の manifest が残っていないか。
