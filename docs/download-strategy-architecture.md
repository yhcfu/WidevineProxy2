# ダウンロード方式別ストラテジー整理

## 目的
- 既存の `.pmd` (= DASH/MPD) 依存設計を脱却し、HLS や DRM 無しの動画も同一フレームで扱えるようにする。
- `DownloadStrategyRegistry` によるストラテジーパターンで、マニフェスト種別・DRM・暗号方式の組み合わせごとに最適なジョブ生成を選択出来るようにする。
- ネイティブホストとのプロトコル互換性 (`schemaVersion=2`) を維持しながら漸進的に機能拡張する。

## 現状と課題
| 項目 | 状態 |
| --- | --- |
| マニフェスト種類 | `content_script` では `.mpd/.m3u8/.ism` を検出しているが、Service Worker 側のキュー生成は `manifest.url` が MPD であることを前提に固定されている。 |
| DRM 情報 | `log.keys` (Widevine) を保持しているが、DRM 無し or FairPlay/AES-128 のようなケースでは構造が異なる。 |
| DL パイプライン | `yt-dlp → mp4decrypt → ffmpeg` に固定。HLS では `mp4decrypt` を挟まず `ffmpeg` 直結や `shaka-packager` 等が必要になる場合がある。 |
| 実装構造 | `buildNativeJobPayload` が巨大化し、新方式追加時に分岐が増殖するリスクが大きい。 |

## 想定する組み合わせマトリクス
| # | マニフェスト/入力 | DRM | 暗号/鍵配送 | セグメント | 主な使用ツール/前提 | 推奨ストラテジー |
| - | - | - | - | - | - | - |
| 1 | DASH `.mpd` (`.pmd` 拡張含む) | Widevine (CENC) | KID/KEY を license リクエストから抽出 | CMAF fMP4 | `yt-dlp` + `mp4decrypt` + `ffmpeg` | ✅ `DashWidevineStrategy` (実装済) |
| 2 | DASH `.mpd` | なし | 平文 or AES-128 | fMP4/WebM | `yt-dlp` 単体で完結 | `DashClearKeyStrategy` (新規) |
| 3 | HLS `.m3u8` (VOD) | なし | AES-128 or none | MPEG-TS | `yt-dlp`/`ffmpeg` (HLS input) citeturn0reddit12 | `HlsClearStrategy` (新規) |
| 4 | HLS `.m3u8` | SAMPLE-AES / FairPlay | キー取得に `EXT-X-KEY` + license server | MPEG-TS/fMP4 | FairPlay なので Safari/AVFoundation 依存。要遠隔 CDM | `HlsFairPlayStrategy` (調査段階) |
| 5 | HLS `.m3u8` | Widevine (HLS WV) | WVD keys, often via custom CDM | CMAF | ブラウザ上でキー抽出 → `yt-dlp` + `mp4decrypt` 応用 citeturn0reddit14 | `HlsWidevineStrategy` (新規) |
| 6 | Progressive MP4 / fragmented MP4 URL | なし | - | 単一 MP4 | `curl`/`aria2c` → そのまま保存 | `ProgressiveStrategy` (新規) |
| 7 | Smooth Streaming `.ism/manifest` | PlayReady/Widevine | CENC | PIFF/fMP4 | `yt-dlp` + `mp4decrypt` or `shaka-packager` | `SmoothStreamingStrategy` (新規) |
| 8 | Live HLS (低遅延) | なし/DRM | AES-128 or SAMPLE-AES | TS/CMAF chunk | 再連結/再接続パラメータが必須 citeturn0reddit16 | `LiveHlsStrategy` (新規) |

> 備考: `.pmd` は特定配信事業者が `MPD` を zip 風にパッケージした表記であり、内部構造は DASH+CENC。従来通り `DashWidevineStrategy` が対応する。

## Strategy アーキテクチャ
1. **DownloadStrategyRegistry**
   - `register(strategy)` で優先度順に保持。
   - `resolve(context)` が `canHandle(context)`=true の最上位ストラテジーを返す。
   - `getById(id)` で後段 (`commandPreview`) も同一ストラテジーを再利用。

2. **DownloadStrategy (base)**
   - `canHandle(context)`：URL/ヘッダー/鍵の存在で対応可否を判定。
   - `buildPayload(context)`：ネイティブホストへ送るジョブ（schemaVersion、mpdUrl/m3u8Url、keys、cookiesなど）を整形。
   - `buildCommandPreview(payload, context)`：CLI fallback を生成（例: `yt-dlp --add-header ...`）。  
   - すべて日本語 TSDoc を付加し、MV3 サービスワーカー上でも tree-shake 可能なフラット ES module にまとめる。

3. **Service Worker 側フロー**
   1. `resolveManifestCandidate(log)` → Manifest 情報を得る。
   2. `strategyContext` に `clientJobId / manifest / log / headers / cookieStrategy / outputDir` を格納。
   3. `buildNativeJobPayload(context)` が `registry.resolve` → ストラテジーごとの `buildPayload` を呼ぶ。
   4. `validateNativeJobPayload` が共通項目 (`clientJobId`, `metadata.strategyId`, `keys` 等) を検証。
   5. `buildCommandPreviewForPayload` は `metadata.strategyId` から該当ストラテジーを再取得して CLI を描画。

4. **将来拡張の勘所**
   - `StrategyContext` を拡張し、HLS セグメント解析結果（`EXT-X-MAP`, `EXT-X-KEY`）や音声言語情報を渡せるよう `content_script` → SW のメッセージスキーマを更新する。
   - DRM 無しケースは `keys` が空になるため、ネイティブホスト schema を v3 で拡張し `encryption: "clear"` を明示する。
   - HLS DRM ではライセンス交換が Widevine とは別系統 (FairPlay SPC/CKC) のため、`RemoteCDMManager` の差し替え or 新たな `cdmAdapter` インターフェースが必要。

## 今回の実装サマリ
- `strategies/` ディレクトリを新設し、`DownloadStrategy` 基底クラス、`DownloadStrategyRegistry`, `DashWidevineStrategy` を定義。
- `background.js` の `buildNativeJobPayload` をストラテジーベースに差し替え、`commandPreview` 生成もストラテジー単位に集約。
- `metadata.strategyId` と `transport` メタデータを追加し、将来の複数方式を識別可能にした。

## 次のステップ案
1. **HLS クリア実装**  
   - `content_script` で `EXTM3U` 解析を強化し、`#EXT-X-KEY` の有無・暗号方式を抽出 → 新ストラテジーの `canHandle` 判定材料とする。  
   - ネイティブホスト側に `m3u8Url` を受け取る新フィールドを追加。
2. **DRM 情報の抽象化**  
   - `log` 保存時に DRM systemId (Widevine, PlayReady, FairPlay) を保存し、キー無しケースでも種別を推定可能にする。  
3. **Live 配信耐性**  
   - ストラテジー単位で `jobOptions` (再接続ポリシー、セグメント保持数など) を返し、ネイティブホストが HLS Live/低遅延パラメータを自動調整できるようにする。
