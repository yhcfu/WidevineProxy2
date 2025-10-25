# Extension Architecture Overview

## 1. 目的
- Widevine キーと DASH manifests の取得を既存フローに統合しつつ、UI 体験を落とさない。
- クリックベースの「この動画をDL」操作のみでダウンロードを開始する。
- Manifest V3 サービスワーカーのライフサイクルに沿って、ネイティブメッセージングを安全に維持する。

## 2. コア構成
- `background.js` / `license.js` がキー取得とロギングを担当し、`chrome.storage.local` にジョブ情報を保持。
- `content_script.js` はタブごとに `message_proxy` ポートを握り、BFCache 復帰時もメッセージを再送。
- `overlay/overlay.js` は shadow DOM 内で CTA ボタンを描画し、`QUEUE_DOWNLOAD` イベントを送信。
- `panel/` 配下の UI はジョブ履歴、コマンドプレビュー、設定（overlay フラグ、Cookie 戦略、保存先など）を提供。

## 3. サービスワーカーとネイティブホスト
- `bootstrapNativeHostPort` が起動時・`runtime.onStartup`・content script 接続時に単一ポートを確立。
- Offscreen ドキュメント (`offscreen.html`) が 15 秒間隔で keepalive を送信し、SW の 30 秒制限を回避。
- `chrome.alarms` と panel からの ping を併用し、ポート切断時は指数バックオフで再接続。
- `native_job_payloads` に未完了ジョブを保存し、再接続直後に自動で再送。

## 4. ジョブおよびキャッシュ
- タブごとの manifest キャッシュは 50 エントリ / 10 分 TTL の LRU。期限切れはアクセス時にパージ。
- オーバーレイは feature flag (`SettingsManager`) で制御し、タブ破棄時に `destroyOverlayForTab` を必ず呼ぶ。
- ジョブカードは最大 40 DOM に抑えるため、200 ms デバウンス＋ウィンドウ化でレンダリング。

## 5. ユーザー体験
- Overlay ボタンは `Enter`/`Space` 対応のフォーカス可能要素、ARIA ライブリージョンでマウント通知。
- Panel では `HOST_STATUS_UPDATE` を pill badge で表示し、再送・削除・コピー操作を提供。
- Toast 通知で完了/失敗を即時提示し、コピー用コマンドプレビューでネイティブ不調時の逃げ道を確保。
