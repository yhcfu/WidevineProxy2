# Native Messaging Pipeline

## 1. ダウンロードの流れ
1. Overlay / panel から `QUEUE_DOWNLOAD` が発火。
2. Service Worker が `buildNativeJobPayload` / `validateNativeJobPayload` で KID/KEY, headers, metadata を整形。
3. `chrome.runtime.connectNative` ポートを通じてネイティブホストへ送信。
4. ホストは `yt-dlp → mp4decrypt → ffmpeg` を連続実行し、`HOST_NATIVE_EVENT` で進捗を返信。
5. 完了時に artifacts とログを保存し、SW は `chrome.storage.local` を更新。

## 2. ガードレール
- すべての payload に `schemaVersion` と 32桁 hex sanitiser を適用。
- `metadata.cookies` に `{ strategy, profile }` をセットし、`--cookies-from-browser` か Netscape エクスポートを切替。
- Payload サイズ制限: content→SW 256 KB、SW→native 512 KB。超えた場合は `console.warn` を残して再設計を検討。

## 3. keepalive と再接続
- ポート断検知で 20 秒以内に指数バックオフ再接続。
- Offscreen ドキュメントと `chrome.alarms` を併用し、SW 停止時にもジョブが再開できるようにする。
- `native_job_payloads` の未完了ジョブは再接続後ただちに再送。

## 4. Post-processing
1. `yt-dlp` で暗号化 MP4/M4A を `jobs/<id>/encrypted` に取得。
2. `mp4decrypt` がトラックごとにキーを適用し、`decrypted/` へ出力。
3. `ffmpeg` がストリームコピーで mux、`artifacts/<slug>.mp4` を生成。
4. 成功時は encrypted/decrypted を削除（`KEEP_DEBUG_ARTIFACTS` 有効時を除く）。

## 5. エラーハンドリング
- `decrypt_error` と `mux_error` を区別し、panel へ即時表示。
- Cookie ロックなど OS 依存の失敗は警告表示に留めてユーザーの手動対応を促す。
- ネイティブホストのログ (`native-host.log`) は `jobId / stage / PID` を JSON 1 行で記録し、個人情報は含めない。
