const PORT_NAME = "wvp-message-proxy";
const REQUEST_TIMEOUT_MS = 15000;
const PORT_RETRY_DELAY_MS = 500;
const MAX_QUEUE_LENGTH = 128;
const PAYLOAD_WARN_THRESHOLD_BYTES = 256 * 1024;
const BF_CACHE_ERROR_KEYWORD = "back/forward cache";
const pendingResponses = new Map();
let runtimePort = null;
let portReadyPromise = null;
const pendingEnvelopes = [];
let navigationDiagnosticsLogged = false;
let bfCacheDisconnectCount = 0;

/**
 * @description BFCache が原因の切断メッセージかどうかを判定します。
 * @param {string} message 判定したいメッセージです。
 * @returns {boolean} BFCache 切断であれば true。
 */
function isBfCacheDisconnectMessage(message) {
    if (!message) {
        return false;
    }
    return message.toLowerCase().includes(BF_CACHE_ERROR_KEYWORD);
}

/**
 * @description Navigation エントリから BFCache 診断ログを一度だけ出します。
 * @param {string} trigger 呼び出し理由です。
 * @param {boolean} force 再ログ出力したい場合は true。
 */
function logNavigationRestorationState(trigger, force = false) {
    if (navigationDiagnosticsLogged && !force) {
        return;
    }
    if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") {
        return;
    }
    const entries = performance.getEntriesByType("navigation") || [];
    if (entries.length === 0) {
        return;
    }
    const entry = entries[entries.length - 1];
    const diagnostics = {
        trigger,
        type: entry?.type || "unknown",
        bfCacheRestored: entry?.type === "back_forward",
        notRestoredReasons: entry?.notRestoredReasons || null
    };
    navigationDiagnosticsLogged = true;
    console.debug("[message_proxy] navigation diagnostics", diagnostics);
}

/**
 * @description Back/Forward Cache などでページが退避する際にポートを整理します。
 */
function teardownRuntimePort() {
    if (!runtimePort) {
        return;
    }
    try {
        runtimePort.disconnect();
    } catch (error) {
        console.debug("[message_proxy] runtimePort disconnect ignored", error);
    }
    runtimePort = null;
}

/**
 * @description タブ⇔Service Worker のランタイムポートを初期化します。
 * @param {string} trigger 呼び出し理由を示す文字列です。
 */
function initRuntimePort(trigger = "init") {
    if (!chrome.runtime?.connect) {
        runtimePort = null;
        return;
    }
    ensureRuntimePort(trigger).catch(() => {
        // 失敗時は後続の ensure が再試行する。
    });
}

/**
 * @description ポートを保証し、未送信キューを順次吐き出します。
 * @param {string} trigger 呼び出し理由です。
 * @returns {Promise<chrome.runtime.Port|null>} 接続済みポート。
 */
function ensureRuntimePort(trigger = "ensure") {
    if (runtimePort) {
        return Promise.resolve(runtimePort);
    }
    if (portReadyPromise) {
        return portReadyPromise;
    }
    portReadyPromise = new Promise((resolve, reject) => {
        try {
            const port = chrome.runtime.connect({ name: PORT_NAME });
            runtimePort = port;
            port.onMessage.addListener(handlePortMessage);
            port.onDisconnect.addListener(() => {
                const reason = chrome.runtime?.lastError?.message || "";
                if (isBfCacheDisconnectMessage(reason)) {
                    bfCacheDisconnectCount += 1;
                    console.debug("[message_proxy] runtimePort dropped (BFCache)", {
                        count: bfCacheDisconnectCount,
                        trigger,
                        url: window.location?.href || null
                    });
                } else if (reason) {
                    console.warn("[message_proxy] runtimePort disconnected", reason);
                }
                runtimePort = null;
                portReadyPromise = null;
                flushPendingResponses();
                schedulePortRetry();
            });
            drainEnvelopeQueue();
            resolve(port);
        } catch (error) {
            runtimePort = null;
            schedulePortRetry();
            reject(error);
        }
    }).finally(() => {
        portReadyPromise = null;
    });
    return portReadyPromise;
}

/**
 * @description ポートが落ちた際にすべての待機応答を解放します。
 */
function flushPendingResponses() {
    pendingResponses.forEach(({ resolve, timeoutId }) => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        resolve("");
    });
    pendingResponses.clear();
}

/**
 * @description キュー済みメッセージをポートへ送信します。
 */
function drainEnvelopeQueue() {
    if (!runtimePort) {
        return;
    }
    while (pendingEnvelopes.length > 0) {
        const envelope = pendingEnvelopes.shift();
        if (!envelope) {
            continue;
        }
        sendThroughPort(envelope);
    }
}

/**
 * @description ポート経由でメッセージを送信します。
 * @param {{detail: object, resolve: Function}} envelope キューに積まれたメッセージです。
 */
function sendThroughPort(envelope) {
    if (!runtimePort) {
        pendingEnvelopes.unshift(envelope);
        schedulePortRetry();
        return;
    }
    const { detail, resolve } = envelope;
    trackEnvelopeSize(detail);
    const timeoutId = setTimeout(() => {
        if (pendingResponses.has(detail.requestId)) {
            pendingResponses.delete(detail.requestId);
            resolve("");
        }
    }, REQUEST_TIMEOUT_MS);
    pendingResponses.set(detail.requestId, { resolve, timeoutId });
    try {
        runtimePort.postMessage({
            requestId: detail.requestId,
            type: detail.type,
            body: detail.body,
            tabUrl: window.location.href,
            tabTitle: document.title || null
        });
    } catch (error) {
        clearTimeout(timeoutId);
        pendingResponses.delete(detail.requestId);
        resolve("");
        runtimePort = null;
        schedulePortRetry();
    }
}

/**
 * @description ポート切断時の再接続をスケジューリングします。
 */
function schedulePortRetry() {
    setTimeout(() => {
        ensureRuntimePort("retry").catch(() => {});
    }, PORT_RETRY_DELAY_MS);
}

/**
 * @description ポートからのレスポンスを処理します。
 * @param {object} message Service Worker からの応答です。
 */
function handlePortMessage(message) {
    if (!message?.requestId) {
        return;
    }
    const entry = pendingResponses.get(message.requestId);
    if (!entry) {
        return;
    }
    pendingResponses.delete(message.requestId);
    clearTimeout(entry.timeoutId);
    entry.resolve(message.payload ?? "");
}

initRuntimePort("bootstrap");
logNavigationRestorationState("bootstrap");

document.addEventListener("freeze", () => {
    logNavigationRestorationState("freeze", true);
    teardownRuntimePort();
    flushPendingResponses();
});

window.addEventListener("pageshow", (event) => {
    if (event?.persisted) {
        logNavigationRestorationState("pageshow", true);
        initRuntimePort("pageshow");
    }
});

window.addEventListener("pagehide", (event) => {
    if (event?.persisted) {
        teardownRuntimePort();
        flushPendingResponses();
    }
});

document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        initRuntimePort("visibilitychange");
    }
});

document.addEventListener("resume", () => {
    logNavigationRestorationState("resume", true);
    initRuntimePort("resume");
});

/**
 * @description ページ→Service Worker へのメッセージを送信し結果を待機します。
 * @param {{requestId: string, type: string, body: string}} detail リクエスト詳細です。
 * @returns {Promise<string>} Service Worker からの応答文字列です。
 */
async function processMessage(detail) {
    return new Promise((resolve) => {
        enqueueEnvelope({ detail, resolve });
        ensureRuntimePort("queue").then(() => {
            drainEnvelopeQueue();
        }).catch(() => {
            // 再接続待ちの間は resolve を保留する。
        });
    });
}

    document.addEventListener('response', async (event) => {
        const { detail } = event;
        let responseData = "";
        try {
            responseData = await processMessage(detail);
    } catch (error) {
        responseData = "";
    }
    const responseEvent = new CustomEvent('responseReceived', {
        detail: detail.requestId.concat(responseData)
    });
    document.dispatchEvent(responseEvent);
});

/**
 * @description JSON化したメッセージサイズを概算し、しきい値を超えた場合は警告を出します。
 * @param {{type:string, body:string}} detail 計測対象のメッセージ詳細です。
 */
function enqueueEnvelope(envelope) {
    if (pendingEnvelopes.length >= MAX_QUEUE_LENGTH) {
        const dropped = pendingEnvelopes.shift();
        if (dropped) {
            dropped.resolve("");
        }
    }
    pendingEnvelopes.push(envelope);
    trackEnvelopeSize(envelope.detail);
}

function trackEnvelopeSize(detail) {
    const bytes = estimatePayloadBytes(detail);
    if (bytes >= PAYLOAD_WARN_THRESHOLD_BYTES) {
        console.warn(`[message_proxy] payload約${Math.round(bytes / 1024)}KB (type=${detail?.type || "unknown"})`);
    }
}

/**
 * @description 入力値を JSON 文字列化した際のおおよそのバイト数を返します。
 * @param {unknown} input 評価対象です。
 * @returns {number} バイト数です。
 */
function estimatePayloadBytes(input) {
    try {
        if (typeof input === "string") {
            return input.length;
        }
        return JSON.stringify(input || "").length;
    } catch {
        return 0;
    }
}
