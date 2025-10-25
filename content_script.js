const SHARED_TEXT_DECODER = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
const SHARED_TEXT_ENCODER = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
const MEDIA_MESSAGE_WARN_THRESHOLD = 128 * 1024;

function uint8ArrayToBase64(uint8array) {
    if (typeof btoa === "function") {
        let binary = "";
        const sliceSize = 0x8000;
        for (let offset = 0; offset < uint8array.length; offset += sliceSize) {
            const slice = uint8array.subarray(offset, offset + sliceSize);
            binary += String.fromCharCode.apply(null, slice);
        }
        return btoa(binary);
    }
    return Buffer.from(uint8array).toString("base64");
}

function uint8ArrayToString(uint8array) {
    if (SHARED_TEXT_DECODER) {
        return SHARED_TEXT_DECODER.decode(uint8array);
    }
    return String.fromCharCode.apply(null, uint8array)
}

function base64toUint8Array(base64_string){
    if (typeof atob === "function") {
        const decoded = atob(base64_string);
        const array = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i += 1) {
            array[i] = decoded.charCodeAt(i);
        }
        return array;
    }
    return Uint8Array.from(Buffer.from(base64_string, "base64"));
}

function compareUint8Arrays(arr1, arr2) {
    if (arr1.length !== arr2.length)
        return false;
    return Array.from(arr1).every((value, index) => value === arr2[index]);
}

const GLOBAL_WVP_SCOPE = typeof window !== "undefined" ? window : self;
const WVP_PATCH_FLAGS = GLOBAL_WVP_SCOPE.__WVP_PATCH_FLAGS__ = GLOBAL_WVP_SCOPE.__WVP_PATCH_FLAGS__ || {};

/**
 * @description マニフェスト抽出対象かどうかをレスポンス情報からゆるく判定します。
 * @param {string} url フェッチしたリソースのURLです。
 * @param {string} contentType レスポンスヘッダーのContent-Typeです。
 * @returns {boolean} 抽出対象であれば true。
 */
function shouldInspectManifestResponse(url, contentType) {
    const normalizedUrl = (url || "").toLowerCase();
    const normalizedType = (contentType || "").toLowerCase();
    if (isTelemetryUrl(normalizedUrl)) {
        return false;
    }
    if (normalizedUrl.includes(".mpd") || normalizedUrl.includes(".m3u8") || normalizedUrl.includes(".ism/manifest") || normalizedUrl.endsWith("manifest") || normalizedUrl.includes("manifest?")) {
        return true;
    }
    if (!normalizedType) {
        return false;
    }
    if (normalizedType.includes("text/html")) {
        return false;
    }
    const tokens = ["dash", "mpegurl", "m3u8", "application/xml", "text/xml", "ms-sstr"];
    return tokens.some(token => normalizedType.includes(token));
}

function emitAndWaitForResponse(type, data) {
    return new Promise((resolve) => {
        const requestId = Math.random().toString(16).substring(2, 9);
        const responseHandler = (event) => {
            const { detail } = event;
            if (detail.substring(0, 7) === requestId) {
                document.removeEventListener('responseReceived', responseHandler);
                resolve(detail.substring(7));
            }
        };
        document.addEventListener('responseReceived', responseHandler);
        const requestEvent = new CustomEvent('response', {
            detail: {
                type: type,
                body: data,
                requestId: requestId,
            }
        });
        document.dispatchEvent(requestEvent);
    });
}

function logMediaMessageSize(label, bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
        return;
    }
    if (bytes >= MEDIA_MESSAGE_WARN_THRESHOLD) {
        console.warn(`[WidevineProxy2] ${label} payload約${Math.round(bytes / 1024)}KB`);
    }
}

const fnproxy = (object, func) => new Proxy(object, { apply: func });
const proxy = (object, key, func) => Object.hasOwnProperty.call(object, key) && Object.defineProperty(object, key, {
    value: fnproxy(object[key], func)
});

function getEventListeners(type) {
    if (this == null) return [];
    const store = this[Symbol.for(getEventListeners)];
    if (store == null || store[type] == null) return [];
    return store[type];
}

class Evaluator {
    static isDASH(text) {
        return text.includes('<mpd') && text.includes('</mpd>');
    }

    static isHLS(text) {
        return text.includes('#extm3u');
    }

    static isHLSMaster(text) {
        return text.includes('#ext-x-stream-inf');
    }

    static isMSS(text) {
        return text.includes('<smoothstreamingmedia') && text.includes('</smoothstreamingmedia>');
    }

    static getManifestType(text) {
        const lower = text.toLowerCase();
        if (this.isDASH(lower)) {
            return "DASH";
        } else if (this.isHLS(lower)) {
            if (this.isHLSMaster(lower)) {
                return "HLS_MASTER";
            } else {
                return "HLS_PLAYLIST";
            }
        } else if (this.isMSS(lower)) {
            return "MSS";
        }
    }
}

(async () => {
    const mediaSessionListenerStore = new WeakMap();

    /**
     * @description MediaKeySession の message イベントかどうかを判定します。
     * @param {EventTarget} target 判定対象の EventTarget です。
     * @param {string} type addEventListener に渡されたイベント種別です。
     * @param {Function|EventListenerObject} listener 登録対象のリスナーです。
     * @returns {boolean} 盗聴対象なら true。
     */
    function shouldInterceptMediaSession(target, type, listener) {
        return (
            typeof MediaKeySession !== "undefined" &&
            target instanceof MediaKeySession &&
            type === "message" &&
            Boolean(listener)
        );
    }

    /**
     * @description MediaKeySession ごとのリスナーマッピングを返します。
     * @param {MediaKeySession} session 対象のセッションです。
     * @returns {Map<Function|EventListenerObject, Function>} オリジナル→ラッパー対応表です。
     */
    function getMediaSessionListenerMap(session) {
        if (!mediaSessionListenerStore.has(session)) {
            mediaSessionListenerStore.set(session, new Map());
        }
        return mediaSessionListenerStore.get(session);
    }

    /**
     * @description MediaKeyMessageEvent をラップしたリスナーを生成します。
     * @param {MediaKeySession} session 対象セッションです。
     * @param {Function|EventListenerObject} listener 元のリスナーです。
     * @returns {Function|EventListenerObject} 差し替え後のリスナーです。
     */
    function createMediaKeyMessageWrapper(session, listener) {
        if (!listener || typeof MediaKeyMessageEvent === "undefined") {
            return listener;
        }
        const wrapped = async function(event) {
            if (event instanceof MediaKeyMessageEvent) {
                if (event._isCustomEvent) {
                    if (listener.handleEvent) {
                        listener.handleEvent(event);
                    } else {
                        listener.call(this, event);
                    }
                    return;
                }

                let newBody = new Uint8Array(event.message);
                if (!compareUint8Arrays(new Uint8Array([0x08, 0x04]), new Uint8Array(event.message))) {
                    console.log("[WidevineProxy2]", "WIDEVINE_PROXY", "MESSAGE", listener);
                    if (listener.name !== "messageHandler") {
                        const oldChallenge = uint8ArrayToBase64(new Uint8Array(event.message));
                        const newChallenge = await emitAndWaitForResponse("REQUEST", oldChallenge);
                        if (oldChallenge !== newChallenge) {
                            newBody = base64toUint8Array(newChallenge);
                        }
                    } else {
                        await emitAndWaitForResponse("REQUEST", "");
                    }
                }

                const newEvent = new MediaKeyMessageEvent("message", {
                    isTrusted: event.isTrusted,
                    bubbles: event.bubbles,
                    cancelBubble: event.cancelBubble,
                    composed: event.composed,
                    currentTarget: event.currentTarget,
                    defaultPrevented: event.defaultPrevented,
                    eventPhase: event.eventPhase,
                    message: newBody.buffer,
                    messageType: event.messageType,
                    returnValue: event.returnValue,
                    srcElement: event.srcElement,
                    target: event.target,
                    timeStamp: event.timeStamp,
                });
                newEvent._isCustomEvent = true;

                logMediaMessageSize("MediaKeySession:REQUEST", event.message?.byteLength ?? 0);

                session.dispatchEvent(newEvent);
                event.stopImmediatePropagation();
                return;
            }

            if (listener.handleEvent) {
                listener.handleEvent(event);
            } else {
                listener.call(this, event);
            }
        };
        return wrapped;
    }

    /**
     * @description MediaKeySession.prototype のイベント登録 API を差し替えます。
     */
    function patchMediaSessionEventHooks() {
        if (typeof MediaKeySession === "undefined" || WVP_PATCH_FLAGS.mediaKeySessionEventPatched) {
            return;
        }
        const originalAddEventListener = MediaKeySession.prototype.addEventListener;
        const originalRemoveEventListener = MediaKeySession.prototype.removeEventListener;
        if (typeof originalAddEventListener !== "function" || typeof originalRemoveEventListener !== "function") {
            return;
        }
        WVP_PATCH_FLAGS.mediaKeySessionEventPatched = true;

        MediaKeySession.prototype.addEventListener = function patchedMediaSessionAdd(type, listener, options) {
            if (shouldInterceptMediaSession(this, type, listener)) {
                const store = getMediaSessionListenerMap(this);
                let wrapped = store.get(listener);
                if (!wrapped) {
                    wrapped = createMediaKeyMessageWrapper(this, listener);
                    store.set(listener, wrapped);
                }
                // wrap 済みリスナーを毎回再生成しないことで re-register を安定化させる
                return originalAddEventListener.call(this, type, wrapped, options);
            }
            return originalAddEventListener.call(this, type, listener, options);
        };

        MediaKeySession.prototype.removeEventListener = function patchedMediaSessionRemove(type, listener, options) {
            if (shouldInterceptMediaSession(this, type, listener)) {
                const store = mediaSessionListenerStore.get(this);
                const wrapped = store?.get(listener);
                if (wrapped) {
                    store.delete(listener);
                    return originalRemoveEventListener.call(this, type, wrapped, options);
                }
            }
            return originalRemoveEventListener.call(this, type, listener, options);
        };
    }

    patchMediaSessionEventHooks();

    if (typeof MediaKeySession !== 'undefined' && !WVP_PATCH_FLAGS.mediaKeyPatched) {
        WVP_PATCH_FLAGS.mediaKeyPatched = true;
        proxy(MediaKeySession.prototype, 'update', async (_target, _this, _args) => {
            const [response] = _args;
            const payload = new Uint8Array(response);
            logMediaMessageSize("MediaKeySession:RESPONSE", payload.byteLength);
            await emitAndWaitForResponse("RESPONSE", uint8ArrayToBase64(payload));
            return await _target.apply(_this, _args);
        });
    }
})();

const inspectedManifestCache = new Map();
const MANIFEST_CACHE_TTL = 5 * 60 * 1000;
const MANIFEST_CACHE_LIMIT = 200;

function markManifestInspected(url) {
    if (!url) {
        return;
    }
    pruneManifestCache();
    inspectedManifestCache.set(url, Date.now());
}

function hasManifestBeenInspected(url) {
    if (!url) {
        return false;
    }
    pruneManifestCache();
    return inspectedManifestCache.has(url);
}

function pruneManifestCache() {
    const now = Date.now();
    for (const [key, timestamp] of inspectedManifestCache.entries()) {
        if (now - timestamp > MANIFEST_CACHE_TTL || inspectedManifestCache.size > MANIFEST_CACHE_LIMIT) {
            inspectedManifestCache.delete(key);
        }
    }
}

if (!WVP_PATCH_FLAGS.fetchPatched && typeof window !== "undefined" && typeof window.fetch === "function") {
    WVP_PATCH_FLAGS.fetchPatched = true;
    const originalFetch = window.fetch;
    window.fetch = function() {
        return new Promise(async (resolve, reject) => {
            originalFetch.apply(this, arguments).then((response) => {
                if (response) {
                    const responseUrl = arguments.length === 1 ? arguments[0].url : arguments[0];
                    const contentType = response.headers ? response.headers.get("content-type") || "" : "";
                    if (!shouldInspectManifestResponse(responseUrl, contentType) || hasManifestBeenInspected(responseUrl)) {
                        resolve(response);
                        return;
                    }
                    response.clone().text().then((text) => {
                        const manifest_type = Evaluator.getManifestType(text);
                        if (manifest_type) {
                            const manifestPayload = {
                                url: arguments.length === 1 ? arguments[0].url : arguments[0],
                                type: manifest_type,
                                size: text.length
                            };
                            emitAndWaitForResponse("MANIFEST", JSON.stringify(manifestPayload));
                            markManifestInspected(responseUrl);
                        }
                        resolve(response);
                    }).catch(() => {
                        resolve(response);
                    })
                } else {
                    resolve(response);
                }
            }).catch(() => {
                resolve();
            })
        })
    }
}

if (!WVP_PATCH_FLAGS.xhrPatched && typeof XMLHttpRequest !== "undefined") {
    WVP_PATCH_FLAGS.xhrPatched = true;
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        this._method = method;
        return open.apply(this, arguments);
    };

    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(postData) {
        this.addEventListener('load', async function() {
            if (this._method === "GET") {
                const contentTypeHeader = this.getResponseHeader ? this.getResponseHeader("content-type") : "";
                if (!shouldInspectManifestResponse(this.responseURL, contentTypeHeader) || hasManifestBeenInspected(this.responseURL)) {
                    return;
                }
            let body = void 0;
            switch (this.responseType) {
                case "":
                case "text":
                    body = this.responseText ?? this.response;
                    break;
                case "json":
                    // TODO: untested
                    body = JSON.stringify(this.response);
                    break;
                case "arraybuffer":
                    // TODO: untested
                    if (this.response.byteLength) {
                        const response = new Uint8Array(this.response);
                        body = uint8ArrayToString(new Uint8Array([...response.slice(0, 2000), ...response.slice(-2000)]));
                    }
                    break;
                case "document":
                    // todo
                    break;
                case "blob":
                    body = await this.response.text();
                    break;
            }
            if (body) {
                const manifest_type = Evaluator.getManifestType(body);
                if (manifest_type) {
                    emitAndWaitForResponse("MANIFEST", JSON.stringify({
                        "url": this.responseURL,
                        "type": manifest_type,
                        "size": body.length
                    }));
                    markManifestInspected(this.responseURL);
                }
            }
        }
    });
        return send.apply(this, arguments);
    };
}

function isTelemetryUrl(url) {
    if (!url) {
        return false;
    }
    try {
        const parsed = new URL(url, window.location.href);
        const host = parsed.hostname.toLowerCase();
        if (host.includes("google-analytics.com") || host.includes("googletagmanager.com") || host.includes("doubleclick.net")) {
            return true;
        }
        if (host.includes("bees.streaks.jp") && parsed.pathname.includes("collect")) {
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}
