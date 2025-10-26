(() => {
    const OVERLAY_HOST_ID = "wvp-overlay-host";
    const OVERLAY_STATE_KEY = "__WVP_OVERLAY_STATE__";
    const CSS_PATH = chrome.runtime.getURL("overlay/overlay.css");
    const CTA_LABEL_DEFAULT = "DL";
    const CTA_LABEL_SENDING = "送信中";
    const CTA_LABEL_DONE = "送信済";

    const globalState = window[OVERLAY_STATE_KEY] = window[OVERLAY_STATE_KEY] || {
        mounted: false,
        host: null,
        shadowRoot: null,
        statusNode: null,
        hintNode: null,
        buttonNode: null,
        lastPayload: null,
        listenerBound: false,
        toastHost: null,
        toastShadow: null,
        toastNode: null,
        toastMessageNode: null,
        toastTimer: null,
        locationObserverBound: false,
        locationCheckTimer: null,
        lastKnownPageUrl: typeof window !== "undefined" ? window.location.href : null,
        displayContextUrl: null
    };

    globalState.historyPatched = globalState.historyPatched || {};
    if (!globalState.lastKnownPageUrl && typeof window !== "undefined" && window.location) {
        globalState.lastKnownPageUrl = window.location.href;
    }

    function sendExtensionMessage(payload) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(payload, (response) => {
                    const err = chrome.runtime.lastError;
                    if (err) {
                        reject(new Error(err.message));
                        return;
                    }
                    resolve(response);
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * @description オーバーレイを生成し、必要なDOM参照を保持します。
     */
    function mountOverlay() {
        if (globalState.mounted) {
            return;
        }
        const host = document.getElementById(OVERLAY_HOST_ID) || document.createElement("div");
        host.id = OVERLAY_HOST_ID;
        const parentTarget = document.body || document.documentElement;
        if (!host.isConnected) {
            parentTarget.appendChild(host);
        }
        const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
        shadow.innerHTML = "";

        const styleLink = document.createElement("link");
        styleLink.rel = "stylesheet";
        styleLink.href = CSS_PATH;

        const shell = document.createElement("div");
        shell.className = "wvp-overlay-shell";
        shell.setAttribute("role", "status");
        shell.setAttribute("aria-live", "polite");

        const pill = document.createElement("div");
        pill.className = "wvp-overlay-pill";

        const cta = document.createElement("button");
        cta.className = "wvp-overlay-pill-button";
        cta.type = "button";
        cta.setAttribute("aria-label", "この動画をダウンロード");
        cta.addEventListener("click", () => {
            handleQueueRequest();
        });

        const icon = document.createElement("span");
        icon.className = "wvp-overlay-pill-icon";
        icon.textContent = "⬇";

        const textWrap = document.createElement("span");
        textWrap.className = "wvp-overlay-pill-text";

        const status = document.createElement("span");
        status.className = "wvp-overlay-status";
        status.textContent = "DL ready";

        const hint = document.createElement("span");
        hint.className = "wvp-overlay-hint";
        hint.textContent = "クリックで保存";

        textWrap.append(status, hint);
        cta.append(icon, textWrap);

        const closeButton = document.createElement("button");
        closeButton.className = "wvp-overlay-close";
        closeButton.type = "button";
        closeButton.setAttribute("aria-label", "オーバーレイを閉じる");
        closeButton.textContent = "×";
        closeButton.addEventListener("click", () => {
            dismissOverlay("user");
        });

        pill.append(cta, closeButton);
        shell.appendChild(pill);
        shadow.append(styleLink, shell);

        globalState.mounted = true;
        globalState.host = host;
        globalState.shadowRoot = shadow;
        globalState.statusNode = status;
        globalState.hintNode = hint;
        globalState.buttonNode = cta;
        globalState.closeButton = closeButton;
        globalState.iconNode = icon;
    }

    /**
     * @description DLキュー要求を送信し、UIを更新します。
     */
    function handleQueueRequest() {
        if (!globalState.buttonNode) {
            return;
        }
        const logKey = globalState.lastPayload?.logKey;
        if (!logKey) {
            announceStatus("ログ情報が見つかりません", "動画を再生し直してからもう一度お試しください。");
            return;
        }
        globalState.buttonNode.disabled = true;
        globalState.buttonNode.textContent = CTA_LABEL_SENDING;
        const payload = {
            type: "OVERLAY_QUEUE_DOWNLOAD",
            logKey
        };
        sendExtensionMessage(payload)
            .then((response) => {
                const message = response?.message || "ジョブをキューに追加しました";
                announceStatus("ダウンロードを開始", message);
                setTimeout(() => {
                    dismissOverlay("queued");
                }, 600);
            })
            .catch((error) => {
                announceStatus("送信に失敗しました", error?.message || "通信に失敗しました");
                globalState.buttonNode.textContent = "再試行";
                globalState.buttonNode.disabled = false;
            });
    }

    /**
     * @description ステータスラベルを更新し、最新の文脈を保持します。
     * @param {{sourceUrl?: string|null, manifestUrl?: string|null}} payload 表示内容です。
     */
    function updateOverlay(payload = {}) {
        mountOverlay();
        globalState.lastPayload = payload;
        if (!globalState.lastKnownPageUrl && typeof window !== "undefined" && window.location) {
            globalState.lastKnownPageUrl = window.location.href;
        }
        const contextUrl = resolveOverlayContextUrl(payload);
        globalState.displayContextUrl = contextUrl || globalState.lastKnownPageUrl;
        const host = safeExtractHost(globalState.displayContextUrl || "動画を検出");
        announceStatus("DL ready", host);
        if (globalState.buttonNode) {
            globalState.buttonNode.disabled = false;
            globalState.buttonNode.textContent = CTA_LABEL_DEFAULT;
        }
    }

    /**
     * @description オーバーレイ表示に使うURLを決定します。
     * @param {{sourceUrl?: string|null, manifestUrl?: string|null}} payload 最新ペイロードです。
     * @returns {string|null} 表示候補のURLです。
     */
    function resolveOverlayContextUrl(payload = {}) {
        if (payload.sourceUrl) {
            return payload.sourceUrl;
        }
        if (payload.manifestUrl) {
            return payload.manifestUrl;
        }
        if (globalState.lastKnownPageUrl) {
            return globalState.lastKnownPageUrl;
        }
        if (typeof window !== "undefined" && window.location) {
            return window.location.href;
        }
        return null;
    }

    /**
     * @description 現在保持しているURLに基づきヒントテキストのみ更新します。
     */
    function refreshOverlayContext() {
        if (!globalState.hintNode) {
            return;
        }
        const detailSource = globalState.displayContextUrl || globalState.lastKnownPageUrl;
        const detail = safeExtractHost(detailSource || "クリックで保存");
        globalState.hintNode.textContent = detail;
    }

    /**
     * @description 背景から届いたロケーションヒントを反映します。
     * @param {{pageUrl?: string|null, reason?: string}} payload ヒント情報です。
     */
    function applyOverlayLocationHint(payload = {}) {
        if (!payload.pageUrl) {
            return;
        }
        globalState.lastKnownPageUrl = payload.pageUrl;
        handleOverlayLocationChange(payload.pageUrl, payload.reason || "hint");
    }

    /**
     * @description URL変化に合わせて表示文脈を差し替えます。
     * @param {string} nextUrl 新しいURLです。
     * @param {string} trigger 発火理由です。
     */
    function handleOverlayLocationChange(nextUrl, trigger = "navigation") {
        if (!nextUrl) {
            return;
        }
        globalState.displayContextUrl = nextUrl;
        refreshOverlayContext();
    }

    /**
     * @description history操作後のURL反映をデバウンス検知します。
     * @param {string} trigger 呼び出し元識別子です。
     */
    function scheduleLocationCheck(trigger) {
        if (globalState.locationCheckTimer) {
            clearTimeout(globalState.locationCheckTimer);
        }
        globalState.locationCheckTimer = setTimeout(() => {
            globalState.locationCheckTimer = null;
            if (typeof window === "undefined" || !window.location) {
                return;
            }
            const current = window.location.href;
            if (current === globalState.lastKnownPageUrl) {
                return;
            }
            globalState.lastKnownPageUrl = current;
            handleOverlayLocationChange(current, trigger);
        }, 75);
    }

    /**
     * @description history APIをラップし、URL更新を取りこぼさないようにします。
     * @param {"pushState"|"replaceState"} methodName 対象メソッドです。
     */
    function bindHistoryMethod(methodName) {
        if (typeof history === "undefined" || typeof history[methodName] !== "function") {
            return;
        }
        if (globalState.historyPatched?.[methodName]) {
            return;
        }
        const original = history[methodName];
        history[methodName] = function patchedHistoryMethod(...args) {
            const result = original.apply(this, args);
            // URL書き換えはイベントループ越しになるため、少し待ってから反映を確認する
            scheduleLocationCheck(methodName);
            return result;
        };
        globalState.historyPatched = globalState.historyPatched || {};
        globalState.historyPatched[methodName] = true;
    }

    /**
     * @description SPA遷移にも追従するロケーション監視を開始します。
     */
    function startLocationObserver() {
        if (globalState.locationObserverBound) {
            return;
        }
        if (typeof window !== "undefined" && window.location) {
            globalState.lastKnownPageUrl = window.location.href;
        }
        const eventNames = ["popstate", "hashchange"];
        eventNames.forEach((eventName) => {
            window.addEventListener(eventName, () => scheduleLocationCheck(eventName), true);
        });
        window.addEventListener("pageshow", () => scheduleLocationCheck("pageshow"), true);
        bindHistoryMethod("pushState");
        bindHistoryMethod("replaceState");
        globalState.locationObserverBound = true;
    }

    /**
     * @description ライブリージョンにテキストを反映します。
     * @param {string} title 見出しテキストです。
     * @param {string} detail 詳細テキストです。
     */
    function announceStatus(title, detail) {
        if (globalState.statusNode) {
            globalState.statusNode.textContent = title;
        }
        if (globalState.hintNode) {
            globalState.hintNode.textContent = detail;
        }
    }

    function safeExtractHost(url) {
        if (!url) {
            return "クリックで保存";
        }
        try {
            const host = new URL(url).host;
            return host || url;
        } catch {
            return url;
        }
    }

    function handleNativeEventToast(payload) {
        if (!payload) {
            return;
        }
        if (payload.type === "job-start") {
            const label = formatToastLabel(payload);
            showOverlayToast(`${label} のダウンロードを開始しました`);
            return;
        }
        const stage = (payload.stage || payload.status || "").toString().toLowerCase();
        if (stage === "completed") {
            const label = formatToastLabel(payload);
            showOverlayToast(`${label} のダウンロードが完了しました`);
        }
    }

    function formatToastLabel(payload) {
        if (payload.outputPath) {
            const parts = payload.outputPath.split("/");
            return parts[parts.length - 1] || payload.outputPath;
        }
        if (payload.sourceUrl) {
            return payload.sourceUrl;
        }
        if (payload.mpdUrl) {
            return payload.mpdUrl;
        }
        if (payload.clientJobId) {
            return payload.clientJobId;
        }
        return "ダウンロード";
    }

    function ensureGlobalToastNode() {
        if (globalState.toastNode && globalState.toastShadow?.isConnected) {
            return globalState.toastNode;
        }
        const hostId = "wvp-global-toast-host";
        let host = document.getElementById(hostId);
        if (!host) {
            host = document.createElement("div");
            host.id = hostId;
            const target = document.body || document.documentElement || document;
            target.appendChild(host);
        }
        const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
        shadow.innerHTML = `
            <style>
                :host, .wvp-toast-shell {
                    all: initial;
                }
                .wvp-toast-shell {
                    position: fixed;
                    top: 24px;
                    right: 24px;
                    z-index: 2147483647;
                    pointer-events: none;
                    font-family: "Segoe UI", "Hiragino Sans", sans-serif;
                }
                .wvp-toast {
                    min-width: 200px;
                    max-width: 320px;
                    padding: 10px 16px;
                    border-radius: 10px;
                    background: rgba(10, 12, 30, 0.92);
                    color: #f5f7fb;
                    font-size: 12px;
                    box-shadow: 0 14px 32px rgba(0, 0, 0, 0.45);
                    opacity: 0;
                    transform: translateY(-16px);
                    transition: opacity 0.25s ease, transform 0.25s ease;
                    display: flex;
                    gap: 8px;
                    align-items: flex-start;
                    pointer-events: auto;
                }
                .wvp-toast:not(.visible) {
                    pointer-events: none;
                }
                .wvp-toast.visible {
                    opacity: 1;
                    transform: translateY(0);
                }
                .wvp-toast__message {
                    flex: 1;
                    line-height: 1.4;
                }
                .wvp-toast__close {
                    border: none;
                    background: transparent;
                    color: inherit;
                    font-size: 14px;
                    cursor: pointer;
                    padding: 0;
                }
            </style>
            <div class="wvp-toast-shell">
                <div class="wvp-toast">
                    <span class="wvp-toast__message"></span>
                    <button class="wvp-toast__close" type="button" aria-label="閉じる">×</button>
                </div>
            </div>
        `;
        const toastNode = shadow.querySelector(".wvp-toast");
        const messageNode = shadow.querySelector(".wvp-toast__message");
        const closeButton = shadow.querySelector(".wvp-toast__close");
        closeButton?.addEventListener("click", () => {
            hideOverlayToast();
        });
        globalState.toastHost = host;
        globalState.toastShadow = shadow;
        globalState.toastNode = toastNode;
        globalState.toastMessageNode = messageNode;
        return toastNode;
    }

    function showOverlayToast(message) {
        hideOverlayToast();
        const toastNode = ensureGlobalToastNode();
        if (!toastNode || !globalState.toastMessageNode) {
            return;
        }
        globalState.toastMessageNode.textContent = message;
        toastNode.classList.add("visible");
        if (globalState.toastTimer) {
            clearTimeout(globalState.toastTimer);
        }
        globalState.toastTimer = setTimeout(() => {
            hideOverlayToast();
        }, 3000);
    }

    function hideOverlayToast() {
        if (globalState.toastTimer) {
            clearTimeout(globalState.toastTimer);
            globalState.toastTimer = null;
        }
        if (globalState.toastNode) {
            globalState.toastNode.classList.remove("visible");
        }
    }

    /**
     * @description オーバーレイを破棄し、背景へ通知します。
     * @param {string} reason 除去理由です。
     */
    function dismissOverlay(reason) {
        if (globalState.host?.isConnected) {
            globalState.host.remove();
        }
        globalState.mounted = false;
        globalState.host = null;
        globalState.shadowRoot = null;
        globalState.statusNode = null;
        globalState.hintNode = null;
        globalState.buttonNode = null;
        sendExtensionMessage({ type: "OVERLAY_DISMISSED", reason }).catch(() => {});
    }

    window.__WVP_DISMISS_OVERLAY__ = dismissOverlay;

    if (!globalState.listenerBound) {
        chrome.runtime.onMessage.addListener((message) => {
            if (!message) {
                return;
            }
            if (message.type === "WVP_OVERLAY_UPDATE") {
                updateOverlay(message.payload || {});
            }
            if (message.type === "WVP_OVERLAY_LOCATION_HINT") {
                applyOverlayLocationHint(message.payload || {});
            }
            if (message.type === "WVP_OVERLAY_DESTROY") {
                dismissOverlay(message.reason || "remote");
            }
            if (message.type === "HOST_NATIVE_EVENT") {
                handleNativeEventToast(message.payload || {});
            }
        });
        globalState.listenerBound = true;
    }

    startLocationObserver();
    mountOverlay();
})();
