const KEEPALIVE_INTERVAL_MS = 15000;
let keepAliveTimer = null;

/**
 * @description Service Worker を定期的に起こすための心拍メッセージを送信します。
 */
function dispatchKeepAlive() {
    const payload = {
        type: "OFFSCREEN_KEEPALIVE_TICK",
        timestamp: Date.now()
    };
    try {
        const maybePromise = chrome.runtime.sendMessage(payload);
        if (maybePromise && typeof maybePromise.catch === "function") {
            maybePromise.catch(() => {
                // SW が落ちている間はエラーになるので握りつぶす。
            });
        }
    } catch (_) {
        // Service Worker が存在しない瞬間の例外は無視して追撃で再送する。
    }
    scheduleNextTick();
}

function scheduleNextTick() {
    clearTimeout(keepAliveTimer);
    keepAliveTimer = setTimeout(dispatchKeepAlive, KEEPALIVE_INTERVAL_MS);
}

function stopKeepAlive() {
    clearTimeout(keepAliveTimer);
    keepAliveTimer = null;
}

chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "OFFSCREEN_SHUTDOWN") {
        stopKeepAlive();
    }
});

dispatchKeepAlive();
