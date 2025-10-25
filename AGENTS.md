# Repository Guidelines

## Project Structure & Module Organization
WidevineProxy2 ships as a browser-extension workspace with minimal tooling, so keep changes localized. Core background orchestration lives in `background.js` and `license.js`, which transform and relay Widevine license traffic. Page integration sits in `content_script.js`. The visual panel is split between `panel/panel.html`, `panel/panel.js`, and `panel/panel.css`, while file chooser flows live under `picker/wvd/` and `picker/remote/`. Shared helpers, including `SettingsManager`, `DeviceManager`, and base64 conversions, reside in `util.js`. Static icons are located in `images/`.

## Build, Test, and Development Commands
No bundler runs in this repository; ship native ES modules. During development, load the folder directly through `chrome://extensions` or `about:debugging#/runtime/this-firefox`. When you need a distributable, run `zip -r dist/WidevineProxy2.zip . -x "dist/*" ".git/*"` from the project root and upload the archive. We currently lack automated testing, so manual end-to-end checks in the browser remain mandatory after each change.

## Coding Style & Naming Conventions
Match the existing ES2020 syntax with four-space indentation and trailing semicolons. Favor `const` for values that never change and organize shared transforms in `util.js` for reuse. Keep filenames lowerCamelCase or snake_case, reserve PascalCase for classes, and export primitives directly without wrapper namespaces. When introducing formatting tools (e.g., Biome), document the configuration inside the repository before enforcing.

## Testing Guidelines
Manual verification covers three pillars: key rendering in the panel UI, file selection in both picker modes, and successful license interception through `background.js`. Use sanitized dummy `.wvd` or `remote.json` files during tests to avoid leaking real device credentials. Capture reproduction steps, observed results, and the test profile used, then attach that summary to each pull request.

## Commit & Pull Request Guidelines
Recent history uses concise, imperative English commit titles, occasionally prefixed with `+` to flag notable work—follow the same convention and reference related issues as `#123`. Pull requests should enumerate goals, code hotspots, manual verification notes, and screenshots of UI changes (with secret keys redacted). Never commit bundled device blobs or real license endpoints; link to documentation instead.

## Security & Configuration Tips
Widevine device material, API tokens, and session keys are persisted via `chrome.storage`. Test with isolated browser profiles so the extension cannot leak production data. When touching configuration code in `SettingsManager` or `DeviceManager`, confirm that obsolete entries are cleared to avoid stale access. Before distributing artifacts, revisit the README disclaimer and ensure changes align with the repository’s educational-only intent.

## Rust / Native Messaging / MV3 Optimization Notes
- **MV3 keepalive設計**: Chrome 110+ の延命仕様と offscreen document を軸に、`chrome.alarms` はバックアップ用途に限定する。長寿命処理はイベント連鎖＋ offscreen document で維持し、無駄な setInterval は禁止。
- **ポート監視**: `chrome.runtime.connectNative` の断検知後は 20 秒以内に指数バックオフで再接続する。SW 停止時に備え `chrome.alarms` の遅延実行を双方向に設定すること。
- **Native Messaging hardening**: インストーラで `NativeMessagingAllowlist` を設定し、blocklist=\* から自ホストのみ許可する。Windows では HKCU/HKLM 両方に manifest を登録して `chrome://policy` で検証ログを取得する。
- **Rustジョブ制御**: ネイティブホストは 5 並列を上限にし、協調キャンセル用の `JobControl`（atomic flag + child kill）を全ステージでチェック。今後は Rust 1.85 の async closures 安定化や `cancel-safe-futures`/`stop-token` 系 crate を優先採用する。
- **ステージングとクリーンアップ**: すべての一時ファイルは OS テンポラリ以下で `jobId` フォルダに束ね、成功・失敗時とも必ず削除。`WIDEVINEPROXY2_KEEP_DEBUG_ARTIFACTS=1` 以外での残置は禁止。
- **セッション型プロトコル**: ネイティブホスト↔拡張の IPC は `queue → waiting → running → {completed|failed|cancelled}` の状態遷移をドキュメント化し、可能なら multiparty session types 等で型的に表現。イベント追加時は schemaVersion をインクリメント。
- **Telemetry & logging**: `native-host.log` には jobId / clientJobId / stage / slot / PID を1行JSONで残し、個人情報やURL全体を出力しない。Chrome側は `HOST_NATIVE_EVENT` の負荷を抑えるため 200ms デバウンスを厳守し、UI では最大40カードまでレンダリング。
- **Payload budget**: manifest/MediaKey 本文をそのまま送らず、URL・種別・サイズといった要約のみをメッセージ化する。content→SW で 256 KB、SW→ネイティブで 512 KB を超える payload は `console.warn` に残し、サイズ上限の再設計を即検討する。
- **BFCache aware messaging**: content script の `runtime.Port` は `pagehide (persisted)`, `freeze`, `resume`, `pageshow` イベントで明示的に閉じて再接続する。Service Worker 側では `chrome.runtime.onConnect` のポート切断時に `chrome.runtime.lastError` を読み、`back/forward cache` メッセージは情報ログとして扱って再送を抑制、`safeRuntimeSendMessage` でも同エラーを握り潰す。
