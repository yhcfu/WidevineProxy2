# Implementation Checklist

## Phase 0 – Scaffolding
- [x] Finalise overlay UI design and queue injection API in `background.js`.
  - [x] Inject `overlay.js` via `chrome.scripting.executeScript` only when keys are captured for an active tab, and load `overlay/overlay.css` inside the shadow root via `chrome.runtime.getURL`.
  - [x] Ensure the overlay renders inside a shadow root, uses keyboard focus traps, and posts `{ type: "QUEUE_DOWNLOAD" }` payloads back to the Service Worker.
  - [x] Provide teardown hooks when playback stops or the user dismisses the overlay.
- [x] Gate overlay display behind feature flag stored in `chrome.storage.local`.
  - [x] Add `SettingsManager` getter/setter + panel toggle (default OFF) for "overlay preview".
  - [x] Short-circuit overlay injection in `background.js` when the flag is disabled, logging a debug message for traceability.
- [x] Document new permissions (`scripting`, `nativeMessaging`) inside `manifest.json` comments.
  - [x] Clarify why `scripting` is required (overlay injection) and why `nativeMessaging` remains optional until rollout.

## Phase 1 – Messaging Spine
- [x] Implement Rust native host skeleton that echoes payloads and exposes `--self-test`.
- [x] Establish `chrome.runtime.connectNative` keepalive with retry/backoff.
- [x] Record basic telemetry (connect/disconnect events) + `HOST_NATIVE_EVENT` consumption in the extension panel's "Native Jobs" section.
- [x] Bootstrap a single `connectNative` port on worker startup/onConnect events so the bridge matches the d_anime stability baseline.
- [x] Persist native job payloads and automatically replay unfinished jobs whenever the host reconnects.
- [x] Add an offscreen keepalive document that pings the service worker every 15 s to keep the native port alive.

## Phase 2 – Payload Plumbing
- [x] Serialise keys + `.mpd` metadata, derive origin fallbacks, and validate against schema before dispatch.
  - [x] Introduce `schemaVersion` + strict hex sanitiser for `{ kid, key }` pairs (always 32文字lowercase)。
  - [x] Share `buildNativeJobPayload` / `validateNativeJobPayload` helpers to block `mpdUrl`欠落やheader不正を早期検出。
  - [x] When tabId is missing, resolve overlay + job payload via URL fallbacks so manifest historyは無駄にならない。
- [x] Add cookie strategy selection (`--cookies-from-browser`, Netscape export) + profile display to the settings panel.
  - [x] Panel に strategy セレクタと profile 入力欄を追加し、SettingsManager へ同期保存。
  - [x] `metadata.cookies` に `{ strategy, profile }` を含めてネイティブホストへ共有。
- [x] Build PowerShell/Bash installers; verify manifest registration on Windows/macOS/Linux and warn when legacy `/Library/...` manifests are still present。
  - [x] install.ps1: ensure user-scope paths, warn about legacy HKLM & `C:\Program Files\WidevineProxy2`, and document post-install verification (`--self-test`, registry、chrome://extensions)。
  - [x] install.sh: print cleanup warnings for `/Library/...` と `/etc/opt/chrome/...`, plus next-step guidance (reload extension + self-test)。
  - [x] Docs updated with explicit verification steps per OS.

## Phase 3 – Download & Post-processing
- [x] Integrate `yt-dlp` invocation with command preview and manual copy fallback.
  - [x] Service worker attaches `commandPreview` (sanitised `yt-dlp` CLI) to each job payload/draft.
  - [x] Panel job cards render a collapsible preview with 1-click copy for manual fallback.
- [x] Implement mp4decrypt + ffmpeg pipeline with artifact cleanup toggles + env overrides.
- [x] Surface job progress/errors in panel (pending/running/decrypting/muxing/completed/failed) and persist last 20 jobs to storage.

## Phase 4 – Hardening & Distribution
- [x] Bundle a prebuilt Windows native host binary + root-level PowerShell installer so ZIP解凍→スクリプト実行で完了できるようにする。
- [x] Provide SHA-256 release notes and update `docs/native-host-install.md`.
- [x] Expand troubleshooting doc with common error codes and remediation.
