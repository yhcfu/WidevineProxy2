# Work Notes (Native Messaging / yt-dlp Integration)

## Context
- Goal: When Widevine keys are captured, automatically enqueue a download job that triggers `yt-dlp + mp4decrypt + ffmpeg`. Results/Progress should flow back to the UI.
- Native host connections are now bootstrapped via `bootstrapNativeHostPort`, so the Service Worker eagerly opens (and reopens) a single `connectNative` port just like the d_anime reference implementation.
- Before this change Chrome terminated the port right after the initial ping, but the new bootstrap + `connectingPromise` guard keep the bridge alive while jobs are queued.
- Chrome/Edge が付与する `chrome-extension://.../` / `--parent-window` 引数も Rust 側で受け取り無視するようにしたので、発火直後に `host started` だけ出して落ちる現象を防げた。
- Offscreen ドキュメントが 15 秒ごとの keepalive を送り続けるので、ネイティブジョブ待機中でも MV3 Service Worker がスリープしない。
- `message_proxy.js` はタブごとに常駐ポートを握り、ポート未接続時はキューに積んでから再送するため、BFCache 復帰時でも `Receiving end does not exist` が発生しなくなった。
- ジョブ投入時のペイロード（keys + headers）を `chrome.storage.local.native_job_payloads` に暗号化せず保持し、ネイティブホスト再接続時に未完了ジョブを自動再送するようになった。完了/失敗したジョブではペイロードを即破棄する。
- Content script 側では EventTarget / Fetch / XHR のパッチ適用を一度きりにし、GA 等のテレメトリ URL を manifest 解析から除外したので、他拡張や BFCache による多重初期化でも安定して動く。
- Panel から失敗ジョブを再送/除去できるようになり、再送はペイロードキャッシュを使って Service Worker 上で再キューする。

## Work in progress
1. **Background → Native host queueing**
   - Fallback解決を追加 (`manifestHistoryByOrigin/pssh`) し、ライセンス取得ごとに `enqueueNativeJob` が確実に mpdUrl を解決できる状態。重複検知＆ジョブ履歴トリミングも入れた。
2. **Content scripts**
   - `fetch`/`XHR` でマニフェスト以外を避けるヒューリスティックに加え、同一URLを5分間キャッシュして再解析しないようにした。これで放置時のCPUスパイクを抑え、Chromeがハングしなくなった。
3. **Native host**
   - `yt-dlp → mp4decrypt → ffmpeg` まで本実装済み。PATHが制限された環境に対応するため、依存バイナリ探索を `~/.local/bin`, `/opt/homebrew/bin` などに広げ、失敗時は `host error` をログ出力。
4. **Keepalive & reconnect**
   - `bootstrapNativeHostPort` で Service Worker 起動直後に `connectNative` を握り、`connectingPromise` で多重接続を防いだ。落ちた場合は指数バックオフ再接続し、Offscreen keepalive で worker の寿命を延命、`HOST_STATUS_UPDATE` と panel 表示も同期される。さらに `native_job_payloads` に残っているジョブは再接続直後に自動で再送される。
5. **Manifest キャッシュ最適化**
   - タブURL単位の `manifests` キャッシュを LRU + 10分TTL 付きに変更。上限（50タブ）を超えると古いものから削除し、期限切れは参照時に自動破棄するようになったので、長時間放置しても Map が肥大化しづらくなった。
6. **Panel の描画最適化**
   - ネイティブジョブのカード再描画を 200 ms デバウンスに置き換え。高頻度の `HOST_NATIVE_EVENT` が来ても DOM 全差し替えが暴発しないため、Chrome DevTools を開いたままでもスクロールが滑らかになった。
7. **Overlay プレビュー**
   - `overlay/overlay.js` + shadow DOM UI を `chrome.scripting.executeScript` で注入し、キー取得時に「この動画をDL」ボタンを提示。`SettingsManager.saveOverlayPreviewEnabled` で feature flag を保持し、panel からON/OFFできる。`OVERLAY_QUEUE_DOWNLOAD` / `OVERLAY_DISMISSED` メッセージで Service Worker 側と疎通しつつ、ストレージ変更やタブクローズ時には `destroyOverlayForTab` がクリーンアップするようになった。
8. **ジョブペイロードスキーマ**
   - `JOB_PAYLOAD_SCHEMA_VERSION=1` を導入し、`buildNativeJobPayload` / `validateNativeJobPayload` で `mpdUrl` / headers / keys の必須チェックを実行。キーは32桁の16進小文字へサニタイズし、metadataには manifest URL・source URL・capturedAt を揃えてから `stashJobPayload` → ネイティブホスト送信するフローに統一した。
9. **Cookie 戦略 UI**
   - Panel の command options に「Cookie strategy」セレクタ（browser / netscape）と profile 入力欄を追加。`SettingsManager.getCookieStrategy/getCookieProfile` で永続化した値を payload metadata.cookies に含め、ネイティブホストが `--cookies-from-browser chrome:Profile` などを判断できるようにした。
10. **yt-dlp Command Preview / Slug**
    - `buildYtDlpCommandPreview` で `yt-dlp <mpd>` + header/cookie 引数に加え `-o <slug>.%(ext)s` を発行。slug はページタイトル/URL から生成して 60 文字に丸めるので、SPOOX のように manifest クエリがファイル名へ混入して `File name too long` になる問題を防げる。コピー用ボタン付きのプレビューをパネルに追加したので、ネイティブホストが落ちていても手動ダウンロードへ即退避できる。
11. **ffmpeg マージ安定化**
    - ネイティブホストの ffmpeg は `-nostdin` + `stdin=null` で実行し、stdout/stderr をパイプ経由で読み捨て＆64 KBリングバッファに残すようにした。Chrome 側の Native Messaging パイプに直接書かないので大量ログでもハングしない。さらに 10 分 watchdog を設け、タイムアウト時は tail ログ付きで `HOST_NATIVE_EVENT` に流せる準備が整った。
12. **配布アーティファクト整備 (Phase 4)**
    - Windows 向けに事前ビルド済み `native-host/bin/windows/widevineproxy2-host.exe` とルートスクリプト `install-windows-native-host.ps1` を同梱し、ZIP 解凍 → Chrome で unpacked 読み込み → ルートスクリプト実行の 3 ステップで完了するよう統一。
    - 開発者は macOS で `scripts/build-native-host.sh macos`、Windows で `scripts/build-native-host.ps1` を実行してプリビルドを揃え、最後に `scripts/package-release.sh` で ZIP 化する運用に統一。
    - `install.ps1 -ManifestOnly` を追加して Extension ID 変更時の manifest 再生成を高速化。
    - `docs/release-notes.md` / `docs/native-host-install.md` / `README.md` をこのフローに沿って更新し、今後の Windows 配布は ZIP + スクリプトのみを公式サポートとする。

## Extension Performance Review Checklist (2025-10-25)
- **ポート & BFCache**: `message_proxy.js` の `pendingEnvelopes` / `flushPendingResponses` が BFCache 遷移時に必ず動き、`runtimePort.postMessage` が切断済みポートへ送られていないか。`chrome.runtime.lastError` に `back/forward cache` が出た回数もコンソールに集計する。
- **Service Worker 稼働率**: `chrome://serviceworker-internals` で起動 / 停止回数と稼働時間を監視し、DL待機時でも 1% 未満 CPU / 50 MB 未満メモリで収まっているかを tracing で確認する。
- **ジョブ並列度 & キュー**: `RUNNING_JOB_STATUSES` 内の状態遷移が意図通りか、5 並列を超えるジョブが無いか、`waitingSince` が 30 s 毎に更新されて UI で「待機中」が点滅しないか。
- **payload budget**: content → SW 256 KB、SW → native 512 KB の WARN を Grafana 代わりの console summary で計測し、MediaKey data / manifest dump が閾値を超えたら diff/要約に置き換えているか。
- **panel レンダリング**: Virtual list が 40 ノード未満を維持できているか、200 ms デバウンスで `HOST_NATIVE_EVENT` burst を吸収できているか、Chrome Profiler で Layout/Style の longest が 16 ms 未満か。
- **overlay ブリッジ**: `chrome.tabs.sendMessage` の失敗が `isMissingOverlayReceiverError` で握り潰されているか、overlay script 再注入の失敗が BFCache と見分けられるか。
- **ネイティブ往復 & keepalive**: `chrome.alarms` ベースの keepalive ping が 15 秒周期を守っているか、`connectNative` の指数バックオフが 5 分上限を守るか、`HOST_NATIVE_EVENT` の broadcast が `safeRuntimeSendMessage` で backpressure を吸収できているか。
- **diagnostics**: DevTools > Application > Back/Forward Cache > Test BFCache を日次で走らせ、`performance.getEntriesByType('navigation')[0].notRestoredReasons` をログする。`notRestoredReasons` が空でない場合は CI ノートに残す。

## 2025-10-25 status snapshot
- Manifest capture is keyed by `tab_url`, but several partner sites rotate watch-page URLs which causes `log.url` and in-memory `manifests` to diverge. Need an additional fallback map indexed by origin+pssh so that `enqueueNativeJob` can always resolve at least one MPD URL.
- Host payload schema must expand to carry headers, cookie profile hints, output template, and job metadata required for automation. Background worker should persist jobs in `chrome.storage.local` so panel UIs can recover state after service worker restarts.
- Native host will evolve into a single-process queue manager that (1) downloads MPD via `yt-dlp --allow-unplayable-formats --cookies-from-browser`, (2) decrypts the resulting MP4/M4A via `mp4decrypt --key KID:KEY`, and (3) muxes streams with `ffmpeg -c copy`.
- Added env conventions to document: `WIDEVINEPROXY2_COOKIES` (defaults to `chrome:Default`) and `WIDEVINEPROXY2_OUTPUT_DIR` (`~/Movies`). Install scripts remain user-scope (no `/Library/...` manifest) to mirror the working d_anime setup.
- Panel work: introduce a lightweight "Native Jobs" section that consumes `HOST_NATIVE_EVENT` broadcast and renders per-job lifecycle (pending/downloading/decrypting/muxing/completed/failed) with timestamp + output hints.

## Next steps (immediate)
1. Manifest オーバーレイ UI を feature flag 付きで実装し、ユーザー起点でジョブ投入できるようにする。
2. Native host 再起動時のジョブ再送設計（state file からの復元 + SW 再enqueue）を詰める。
3. Panel 側でジョブ重複をまとめる / 完了後に自動で `mpdUrl` をクリップボードへ出せるような UX 改善を検討。
4. Manifest LRU / パネル描画デバウンスの効果を測るため、Chrome DevTools の Performance 計測テンプレを追加し、しきい値をドキュメント化する。

## Memento 2025-10-25
この時点での重要ポイントを将来の自分用メモとしてまとめておく。リセット後はこの節を読めば全貌を即復元できるはず。

- **ネイティブブリッジ**: `bootstrapNativeHostPort` で MV3 Service Worker 起動直後に `connectNative` し、Offscreen keepalive + alarms で持続。ジョブpayloadは `chrome.storage.local.native_job_payloads` に保存し、再接続時 `replayPendingNativeJobs` が送信。
- **オーバーレイ**: `overlay/overlay.js` を `chrome.scripting.executeScript` で注入。flag (`overlay_preview_enabled`) が panel から操作でき、キー取得時にページ右上へ DL オーバーレイを表示。`overlayStateByTab` でタブごとの注入状況と最新ログキーを管理し、CTA 押下で即 `enqueueNativeJob` が走る。
- **Manifest/fetch制御**: content_script 側で GA/telemetry を除外し、パーサーは 5 分キャッシュ + origin+pssh fallback。Service Worker 側では tab URL + origin で LRU (50件) を維持。
- **ジョブpayload**: `buildNativeJobPayload` が sourceUrl/manifestUrl/headers/cookies/keys をすべて検証し、`schemaVersion=1`。キーは 32 桁 hex へ統一。cookies は browser/netscape の2択で panel から設定。`outputSlug` はページタイトル（fallback: URL パスや jobId）から生成し、60 文字にクリップすることで長い manifest クエリによるファイル名エラーを防ぐ。
- **yt-dlp プレビュー**: payload に `commandPreview` を格納し、panel の Native Jobs カードに表示+コピー。CLI には `yt-dlp <mpd> --cookies-from-browser <profile> --add-header ... -o <slug>.%(ext)s` が入る。ネイティブホストが落ちても手動で DL できる。
- **インストーラ**: Windows は unpacked extension を読み込んで ID を取得 → リポジトリルートの `install-windows-native-host.ps1` から事前ビルド済み `native-host/bin/windows/widevineproxy2-host.exe` を渡して `install.ps1` を呼ぶ二段フローに統一。macOS も `native-host/bin/macos/widevineproxy2-host` を同梱すれば解凍直後に `install.sh` が実行できる。`-ManifestOnly` で manifest だけ再生成でき、README / docs/native-host-install.md もこの手順に合わせて更新済み。
- **Panel**: Native Jobs リストは 200ms デバウンスで描画。カードにはステージ/詳細/再送/除去ボタンに加え、コマンドプレビュー欄・進捗バー・最新タイムスタンプを表示。Command options には overlay トグル + cookie戦略 UI がある。
- **Phase3 wrap-up**: ネイティブホストは常時 yt-dlp → mp4decrypt → ffmpeg を実行し、成功時は `encrypted/` / `decrypted/` を自動削除 (`WIDEVINEPROXY2_KEEP_DEBUG_ARTIFACTS` で保持可能)。失敗ジョブは調査用に残しつつ、panel 側では20件の履歴をストレージへ永続化して再起動後も進捗を振り返れる。
- **Todo残り**: ネイティブ queue manager の並列キャンセル制御、`--self-test` 以外の診断モード追加、CI での配布 ZIP ハッシュ検証の自動化。

## Reference files
- `docs/native-messaging-design.md` – design outline.
- `native-host/src/d_anime_notes/README.md` – notes from d_anime reference implementation.
