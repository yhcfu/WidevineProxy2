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
| 2 | DASH `.mpd` | なし | 平文 or AES-128 | fMP4/WebM | `yt-dlp` 単体で完結 | ✅ `DashClearKeyStrategy` (実装済) |
| 3 | HLS `.m3u8` (VOD) | なし | none (暗号化なし) | MPEG-TS | `yt-dlp`/`ffmpeg` (HLS input) | ✅ `HlsClearStrategy` (実装済) |
| 4 | HLS `.m3u8` | SAMPLE-AES / FairPlay | キー取得に `EXT-X-KEY` + license server | MPEG-TS/fMP4 | FairPlay なので Safari/AVFoundation 依存。要遠隔 CDM | ✅ `HlsFairPlayStrategy` (実装済) |
| 5 | HLS `.m3u8` | Widevine (HLS WV) | WVD keys, often via custom CDM | CMAF | ブラウザ上でキー抽出 → `yt-dlp` + `mp4decrypt` 応用 | ✅ `HlsWidevineStrategy` (実装済) |
| 6 | Progressive MP4 / fragmented MP4 URL | なし | - | 単一 MP4 | `curl`/`aria2c` → そのまま保存 | ✅ `ProgressiveStrategy` (実装済) |
| 7 | Smooth Streaming `.ism/manifest` | PlayReady/Widevine | CENC | PIFF/fMP4 | `yt-dlp` + `mp4decrypt` or `shaka-packager` | ✅ `SmoothStreamingStrategy` (実装済) |
| 8 | Live HLS (低遅延) | なし/DRM | AES-128 or SAMPLE-AES | TS/CMAF chunk | 再連結/再接続パラメータが必須 | ✅ `LiveHlsStrategy` (実装済) |
| 9 | マニフェスト不明（URLのみ） | なし/DRM不問 | yt-dlp 任せ | - | サイト対応は yt-dlp 依存 | ✅ `GenericYtDlpStrategy` (実装済) |

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
   - `content_script` からは manifest の解析メタ (`details.encryption`, `details.drmSystems`, `details.segmentFormat`) を付与し、ストラテジー側が DRM/暗号方式を即時判別できるようにした。
   - `StrategyContext.siteProfile` で yt-dlp 対応サイトなどのプリフライト結果を共有し、`GenericYtDlpStrategy` への強制切り替えを即断できるようにした。

3. **Service Worker 側フロー**
   0. `resolveYtDlpSiteProfile(log, manifest)` で URL 候補を即座に照合し、対応サイトなら `siteProfile.forcedStrategyId = generic-ytdlp` を付与。
   1. `resolveManifestCandidate(log)` → Manifest 情報を得る。
   2. `strategyContext` に `clientJobId / manifest / log / headers / cookieStrategy / outputDir / siteProfile` を格納。
   3. プリフライトで GENERIC が確定した場合は鍵を空にし、マニフェスト/ログを `type: GENERIC` へ正規化。
   4. `buildNativeJobPayload(context)` が `registry.resolve` → ストラテジーごとの `buildPayload` を呼ぶ。
   5. `validateNativeJobPayload` が共通項目 (`clientJobId`, `metadata.strategyId`, `keys` 等) を検証。
   6. `buildCommandPreviewForPayload` は `metadata.strategyId` から該当ストラテジーを再取得して CLI を描画。

4. **将来拡張の勘所**
   - `StrategyContext` を拡張し、HLS セグメント解析結果（`EXT-X-MAP`, `EXT-X-KEY`）や音声言語情報を渡せるよう `content_script` → SW のメッセージスキーマを更新する。
   - DRM 無しケースは `keys` が空になるため、ネイティブホスト schema を v3 で拡張し `encryption: "clear"` を明示する。
   - HLS DRM ではライセンス交換が Widevine とは別系統 (FairPlay SPC/CKC) のため、`RemoteCDMManager` の差し替え or 新たな `cdmAdapter` インターフェースが必要。

## 今回の実装サマリ
- `strategies/` ディレクトリを新設し、`DownloadStrategy` 基底クラス、`DownloadStrategyRegistry`, `DashWidevineStrategy`, `HlsClearStrategy` を定義。
- `content_script` が manifest 本文を軽量解析して DRM / 暗号方式を `details` に埋め込み、Service Worker→ストラテジーへ伝搬。
- `background.js` の `buildNativeJobPayload` をストラテジーベースに差し替え、`commandPreview` 生成もストラテジー単位に集約。
- `metadata.strategyId` / `metadata.transport` を導入し、ネイティブホストに暗号方式（`encryption=clear` 等）を通知。これにより Rust 側が鍵不要ジョブを受け付け、`mp4decrypt` ステージを自動スキップできるようになった。

## 続行時の設計ロードマップ
「途中参加のエンジニアでも再開できる」を目的に、残タスクと具体的な設計指針を以下へ固定化する。

### Step 1: StrategyContext の拡張
- **背景**: HLS や Smooth Streaming ではマニフェストに帯域幅・キー URI など追加パラメータが必要。`content_script` 解析で得た情報を Service Worker → ストラテジーへ渡し、native-host にまで運ぶ必要がある。
- **実装方針**:
  1. `content_script` で抽出した `details` に `bandwidth`, `resolution`, `renditionCount`, `keyUris`, `initSegment` を追加。`Evaluator.analyzeHlsManifest` を拡張して `#EXT-X-STREAM-INF` の属性を収集する。
  2. `StrategyContext` に `manifestDetails` を alias する getter（もしくは `context.manifest.details` へのアクセスを前提にし、型定義コメントを拡張）を用意。
  3. `background.js` の `rememberManifest` で `details` を Storage 保存する際、5件に圧縮しつつ最新情報を保持。

### Step 2: 暗号あり HLS のストラテジー設計
- **目標**: SAMPLE-AES/AES-128 など暗号付き HLS を `HlsSampleAesStrategy` に委譲し、キーが存在しない場合でも `EXT-X-KEY` から抽出した URL/IV を metadata に渡す。
- **要件**:
  - `manifest.details.encryption` が `sample-aes` もしくは `aes-128` の場合に発火。
  - `details.drmSystems` に `FAIRPLAY` が含まれる場合は `strategyId=hls-fairplay`（後述 Step3）を優先。含まれない場合は AES-128 (ベタキー) と判断。
  - `metadata.transport` に `keyUri`, `iv`, `method` を追加し、ネイティブホストが `ffmpeg -decryption_key` 等を組み立てられるようにする。
  - CLI プレビューは `yt-dlp --allow-unplayable-formats --hls-use-mpegts --downloader ffmpeg` をベースに、`--add-header`/`--extra-keys` 等を差し込む。

### Step 3: DRM 別ストラテジー分岐
- **DashClearStrategy**: `manifest.details.drmSystems=[]` かつ `.mpd` URL の場合に選択。`metadata.transport.encryption="clear"` を保証し、ネイティブホストで mp4decrypt スキップ。
- **HlsFairPlayStrategy**: `details.drmSystems` に `FAIRPLAY` が含まれる場合に適用。Remote CDM で SPC/CKC を扱うのか、もしくは Safari 専用ワークフローかを設計メモに追記すること（決まるまで stub で OK）。
- **SmoothStreamingStrategy**: `details.type === "MSS"` をトリガーにし、PlayReady/Widevine を `drmSystems` から判定。`manifest.details.protectionHeaders` を content_script で解析し metadata へ突っ込む。

### Step 4: Native Host schema v3 の設計
- **拡張点**:
  - `DownloadRequest` に `manifestType`, `encryption`, `drmType`, `segmentFormat`, `jobOptions` を追加。
  - `jobOptions` 内で `skipDecrypt`, `customDownloader`, `downloaderArgs`, `postProcessors` を配列管理。これによりストラテジー側が「HLS Live なら ffmpeg を downloader にする」等を記述できる。
  - Rust 側では `metadata.requires_key_material()` を `transport.encryption` のみならず `jobOptions.skipDecrypt` でも上書き可能にする。
- **移行手順**:
  1. schemaVersion を 3 に bump し、`background.js` で旧/新の両方を理解するフォールバック（`metadata.transport` が無い場合は `encryption=unknown` 扱い）。
  2. native-host で schemaVersion をチェックし、`transport` が無い旧ジョブは従来どおり key 必須に。

### Step 5: パネル/UI の連携
- **目的**: ストラテジー判定結果をユーザーへ可視化し、誤検知時のフィードバック経路を作る。
- **TODO**:
  - `panel/panel.js` で各ジョブカードに `strategyId`, `transport.encryption`, `transport.manifestType` をバッジ表示。
  - 「HLS (SAMPLE-AES) → FairPlay かも？」などメッセージを翻訳ファイルに追加。
  - CLI プレビューに `# comments` 形式で「このコマンドでは暗号キーを含みません。手動で `--hls-key` を設定してください」のような注意書きを付与。

### Step 6: テスト計画
- クリア HLS / 暗号 HLS / DASH CENC / Smooth Streaming の 4 代表ケースで手動検証テンプレを用意。
- それぞれの manifest/sample URL（ダミーで可）を `docs/test-manifests.md` に列挙し、検証ログ（成功/失敗・使用ブラウザ・ストラテジーID）を書き残す。

### Step 7: 汎用サイト（yt-dlp サポート範囲）の適用指針
- **背景**: yt-dlp は 1,900 以上の extractor を備え、動画共有サイト（YouTube/Vimeo/Bilibili）、ライブ配信（Twitch）、音楽サービス（Bandcamp/SoundCloud）など幅広いドメインを取り扱える。citeturn0search1 当拡張でもこの網羅性を活かし、「サイト固有ストラテジー」を乱立させず汎用プリセットで単純 DL を実現したい。
- **設計方針**:
  1. **サイト能力の動的取得**: ネイティブホストで `yt-dlp --list-extractors --compat-options no-append-plugins` を週次実行し、抽出器 ID / 説明 / DRM 有無を `extractor_map.json` へ保存。Service Worker は起動時に `AsyncLocalStorage` へ流し込み、`StrategyContext.siteTag` を `new URL(log.url).hostname` → extractor エイリアスの順に解決する。公式 `supportedsites.md` との差分は `scripts/update-extractor-map.js` で自動生成し、PR でレビュアーが確認できるよう `docs/extractors/latest.json` にも出力する。citeturn0search1turn0search4
  2. **サイトメタキャッシュ構造**: `siteCapabilityCache` のスキーマは `{ extractorId, hostPatterns, category, drm: boolean, live: boolean, notes }`。Service Worker では `resolveSiteProfile(url)` で (a) manifest details, (b) extractor metadata を突き合わせ、`context.siteCategory`（例: `video`, `livestream`, `music`, `news`, `education`, `adult` など）と `siteCapabilities`（オプション）を埋める。
  3. **汎用プリセット層 (`GenericSiteStrategy`)**: 既存 DASH/HLS/DRM ストラテジーが `canHandle=false` を返した際のフォールバック。`siteCategory` ごとに CLI スニペットを生成し、**常に最高画質/最高音質** を狙う。基本フォーマットは `--format "bestvideo*+bestaudio/best" --format-sort "res,vcodec:av1*/vp9*/h265*/h264,br" --merge-output-format mkv` をデフォルトとし、サイト固有制限（例: 音声しかない場合）は自動ダウングレード。ライブ配信や音楽サイト向けにはカテゴリ別オプションをさらに加える（下表参照）。
  4. **カテゴリ別最高画質プリセット**:

    | siteCategory | 代表サイト | yt-dlp 既定 CLI（抜粋） | 最高画質の工夫 | 備考 |
    | --- | --- | --- | --- | --- |
    | `video` | YouTube, Vimeo, Bilibili | `--format "bestvideo*+bestaudio/best"`<br>`--format-sort "res,vcodec:av1*/vp9*/hevc*/h264,br"`<br>`--merge-output-format mkv` | 解像度優先＋AV1/VP9/HEVC を優先。音声付きフォールバックを `/best` に設定。 | DRM 判定で Widevine を検出した場合は `DashWidevineStrategy` へ切替。 |
    | `livestream` | Twitch, AfreecaTV | `--format "best" --live-from-start --hls-use-mpegts --retry-streams 3` | ライブ追いかけ/切断再接続を強化。`mpegts` 指定で高速マージ。 | 終了後 VOD 化した場合は通常 video プリセットへ移行。 |
    | `music` | SoundCloud, Bandcamp | `--format bestaudio` `--extract-audio --audio-format flac --audio-quality 0` `--embed-metadata --embed-thumbnail` | 最高音質 (`--audio-quality 0`) とロスレス FLAC 変換、メタデータ埋め込み。 | ファイルサイズ抑制が必要なら UI で `aac` などに変更可能。 |
    | `news` | BBC, NHK Plus | `--format "bestvideo*+bestaudio/best" --merge-output-format mp4 --write-subs --sub-langs all --geo-bypass` | 自動字幕＆地域制限回避を有効化。 | 利用規約の注意を UI に表示。 |
    | `education` | Coursera, TED | `--format "bestvideo*+bestaudio/best" --write-subs --embed-subs` | 字幕付きアーカイブをデフォルト保存。 | 認証が必要なサイトは cookie プロファイルを案内。 |

  5. **設定/UI**: パネルへ「サイト自動判定」「最高画質プリセット」トグルを追加。ユーザーが各カテゴリの CLI を JSON で上書きできる `sitePresetOverrides` エディタを提供し、保存後は Service Worker が次ジョブから新設定を使用。DL 実行時にはカードに `siteCategory`, `appliedPreset`, `formatSummary`（yt-dlp の `--print filename` などから推定）を表示。
  6. **フェイルオーバー**: 汎用プリセットでも失敗した場合は CLI プレビューに `yt-dlp <url> --verbose` 付与済みコマンドを表示し、ユーザーが手動実行できるようにする。Service Worker のログには抽出器 ID とエラーコードを記録し、`extractor_map.json` をメンテする際のヒントにする。

- **アクションアイテム**:
  - `StrategyContext` へ `siteTag`, `siteCategory`, `siteCapabilities` を追加し、manifest ログおよび extractor マップから解決するヘルパーを実装。
  - `strategies/generic_site.js` を実装して `Dash/Hls` 系より低優先度で登録。CLI 生成はカテゴリ毎のプリセット + ユーザー上書きに対応し、`metadata.transport` へ `manifestType="GENERIC"`, `encryption="clear"` を設定。
  - ネイティブホストに `extractor_map.json` キャッシュと `site_presets.toml` を追加し、`yt-dlp` 実行時にカテゴリ別オプションを自動注入。プリセットには常に最高画質/音質を狙うオプション（`--format bestvideo*+bestaudio/best`, `--audio-quality 0` 等）を含める。
  - `scripts/update-extractor-map.js` で yt-dlp 公式 `supportedsites.md` から最新 extractor ID を取得し、差分をコミットする CI フローを検討。

これらの指針を順番に消化すれば、誰が途中参加しても迷わず次のストラテジー実装に入れる構成になっている。進捗管理は Step ごとに PR/issue を分け、doc 更新を伴うことを前提とする。

## 次のステップ案
1. **HLS クリア実装**  
   - `content_script` で `EXTM3U` 解析を強化し、`#EXT-X-KEY` の有無・暗号方式を抽出 → 新ストラテジーの `canHandle` 判定材料とする。  
   - ネイティブホスト側に `m3u8Url` を受け取る新フィールドを追加。
2. **DRM 情報の抽象化**  
   - `log` 保存時に DRM systemId (Widevine, PlayReady, FairPlay) を保存し、キー無しケースでも種別を推定可能にする。  
3. **Live 配信耐性**  
   - ストラテジー単位で `jobOptions` (再接続ポリシー、セグメント保持数など) を返し、ネイティブホストが HLS Live/低遅延パラメータを自動調整できるようにする。
