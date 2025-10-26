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
const WVP_PAGE_PROFILE = GLOBAL_WVP_SCOPE.__WVP_PAGE_PROFILE__ = GLOBAL_WVP_SCOPE.__WVP_PAGE_PROFILE__ || {
    forceGeneric: false
};

/**
 * @description ページ状態フラグを更新します。
 * @param {{forceGeneric?: boolean}|null} patch 反映したい変更です。
 * @returns {void}
 */
function applyPageProfilePatch(patch) {
    if (!patch || typeof patch !== "object") {
        return;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "forceGeneric")) {
        WVP_PAGE_PROFILE.forceGeneric = Boolean(patch.forceGeneric);
    }
}

/**
 * @description ページ状態フラグを初期化します。
 * @returns {void}
 */
function resetPageProfileFlags() {
    WVP_PAGE_PROFILE.forceGeneric = false;
}

/**
 * @description マニフェスト抽出対象かどうかをレスポンス情報からゆるく判定します。
 * @param {string} url フェッチしたリソースのURLです。
 * @param {string} contentType レスポンスヘッダーのContent-Typeです。
 * @returns {boolean} 抽出対象であれば true。
 */
function normalizeUrlInput(input) {
    if (!input) {
        return "";
    }
    if (typeof input === "string") {
        return input;
    }
    if (typeof input === "object") {
        if (typeof input.url === "string") {
            return input.url;
        }
        if (typeof input.href === "string") {
            return input.href;
        }
        if (typeof input.toString === "function") {
            return input.toString();
        }
    }
    try {
        return String(input);
    } catch {
        return "";
    }
}

function shouldInspectManifestResponse(url, contentType) {
    if (WVP_PAGE_PROFILE.forceGeneric) {
        return false;
    }
    const rawUrl = normalizeUrlInput(url);
    const normalizedUrl = rawUrl.toLowerCase();
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
        return null;
    }

    /**
     * @description マニフェスト本文を解析し、暗号方式や DRM などのメタ情報を返します。
     * @param {string} text 解析対象のマニフェスト文字列です。
     * @param {{url?: string}} [options] 追加の解析コンテキストです。
     * @returns {{type: string, drmSystems: Array<string>, encryption: string, streamCount: number, segmentFormat: string|null, notes: Array<string>, url: string|null, playlistType?: string|null, isLive?: boolean}|null} 抽出したメタ情報です。
     */
    static analyzeManifest(text, options = {}) {
        if (!text) {
            return null;
        }
        const type = this.getManifestType(text);
        if (!type) {
            return null;
        }
        const analysis = {
            type,
            drmSystems: [],
            encryption: "unknown",
            streamCount: 0,
            segmentFormat: null,
            notes: [],
            playlistType: null,
            isLive: false,
            url: options?.url || null
        };
        if (type === "DASH") {
            return this.analyzeDashManifest(text, analysis);
        }
        if (type === "HLS_MASTER" || type === "HLS_PLAYLIST") {
            return this.analyzeHlsManifest(text, analysis);
        }
        if (type === "MSS") {
            return this.analyzeMssManifest(text, analysis);
        }
        return analysis;
    }

    /**
     * @description DASH マニフェストに含まれる DRM/コンテナ情報を抽出します。
     * @param {string} text マニフェスト本文です。
     * @param {object} analysis 既存の解析オブジェクトです。
     * @returns {object} 更新後の解析結果です。
     */
    static analyzeDashManifest(text, analysis) {
        const drmMatches = text.match(/<ContentProtection[^>]+schemeIdUri="([^"]+)"/gi) || [];
        const drmSet = new Set();
        drmMatches.forEach((match) => {
            const uriMatch = /schemeIdUri="([^"]+)"/i.exec(match);
            if (!uriMatch) {
                return;
            }
            const drmLabel = this.mapDrmFromScheme(uriMatch[1]);
            if (drmLabel) {
                drmSet.add(drmLabel);
            }
        });
        analysis.drmSystems = Array.from(drmSet);
        analysis.encryption = drmSet.size > 0 ? "cenc" : "clear";
        const mimeMatch = text.match(/mimeType="([^"]+)"/i);
        if (mimeMatch) {
            analysis.segmentFormat = this.mapDashMimeToFormat(mimeMatch[1]);
        }
        return analysis;
    }

    /**
     * @description DASH の mimeType から主要なコンテナ形式を推定します。
     * @param {string} mime 抽出した mimeType 文字列です。
     * @returns {string|null} 推定されたフォーマットです。
     */
    static mapDashMimeToFormat(mime) {
        if (!mime) {
            return null;
        }
        const normalized = mime.toLowerCase();
        if (normalized.includes("mp4") || normalized.includes("cmaf")) {
            return "fmp4";
        }
        if (normalized.includes("webm")) {
            return "webm";
        }
        return null;
    }

    /**
     * @description schemeIdUri から DRM 名を推定します。
     * @param {string} schemeUri schemeIdUri の値です。
     * @returns {string|null} DRM 名称です。
     */
    static mapDrmFromScheme(schemeUri) {
        if (!schemeUri) {
            return null;
        }
        const normalized = schemeUri.toLowerCase();
        if (normalized.includes("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed")) {
            return "WIDEVINE";
        }
        if (normalized.includes("9a04f079-9840-4286-ab92-e65be0885f95")) {
            return "PLAYREADY";
        }
        if (normalized.includes("94ce86fb-07ff-4f43-adb8-93d2fa968ca2")) {
            return "FAIRPLAY";
        }
        return schemeUri;
    }

    /**
     * @description HLS マニフェストから暗号方式や DRM を推定します。
     * @param {string} text マニフェスト本文です。
     * @param {object} analysis 既存の解析オブジェクトです。
     * @returns {object} 更新後の解析結果です。
     */
    static analyzeHlsManifest(text, analysis) {
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        let encryption = "clear";
        const drmSet = new Set();
        let streamCount = 0;
        let playlistType = null;
        let hasEndlist = false;
        lines.forEach((line) => {
            if (line.startsWith("#EXT-X-STREAM-INF")) {
                streamCount += 1;
            }
            if (line.startsWith("#EXTINF")) {
                analysis.segmentFormat = analysis.segmentFormat || "ts";
            }
            if (line.startsWith("#EXT-X-MAP")) {
                analysis.segmentFormat = analysis.segmentFormat || "fmp4";
            }
            if (line.startsWith("#EXT-X-PLAYLIST-TYPE")) {
                const raw = line.split(":", 2)[1] || "";
                playlistType = raw.trim().toUpperCase() || null;
            }
            if (line === "#EXT-X-ENDLIST") {
                hasEndlist = true;
            }
            if (line.startsWith("#EXT-X-KEY")) {
                const attributes = Evaluator.parseAttributeList(line);
                const method = (attributes.METHOD || "NONE").toUpperCase();
                if (method !== "NONE") {
                    encryption = method;
                } else {
                    encryption = "clear";
                }
                const keyFormat = attributes.KEYFORMAT || attributes.KEYFORMATVERSIONS || null;
                const mapped = Evaluator.mapHlsKeyFormat(keyFormat);
                if (mapped) {
                    drmSet.add(mapped);
                }
            }
        });
        analysis.streamCount = streamCount;
        analysis.encryption = encryption;
        analysis.drmSystems = Array.from(drmSet);
        if (!analysis.segmentFormat) {
            analysis.segmentFormat = encryption === "SAMPLE-AES" ? "fmp4" : "ts";
        }
        analysis.playlistType = playlistType;
        analysis.isLive = playlistType === "EVENT" || (!hasEndlist && playlistType !== "VOD");
        if (analysis.isLive) {
            analysis.notes.push("live");
        }
        if (playlistType) {
            analysis.notes.push(`playlist=${playlistType}`);
        }
        return analysis;
    }

    /**
     * @description HLS の KEYFORMAT を DRM 名へマッピングします。
     * @param {string|null} keyFormat KEYFORMAT の値です。
     * @returns {string|null} DRM 名です。
     */
    static mapHlsKeyFormat(keyFormat) {
        if (!keyFormat) {
            return null;
        }
        const normalized = keyFormat.toLowerCase();
        if (normalized.includes("com.apple.streamingkeydelivery")) {
            return "FAIRPLAY";
        }
        if (normalized.includes("widevine")) {
            return "WIDEVINE";
        }
        if (normalized.includes("playready")) {
            return "PLAYREADY";
        }
        return keyFormat;
    }

    /**
     * @description Smooth Streaming マニフェストから DRM 情報を推定します。
     * @param {string} text マニフェスト本文です。
     * @param {object} analysis 既存の解析オブジェクトです。
     * @returns {object} 更新後の解析結果です。
     */
    static analyzeMssManifest(text, analysis) {
        const protectionMatches = text.match(/ProtectionHeader[^>]*SystemID=\"([^\"]+)\"/gi) || [];
        const drmSet = new Set();
        protectionMatches.forEach((match) => {
            const idMatch = /SystemID=\"([^\"]+)\"/i.exec(match);
            if (!idMatch) {
                return;
            }
            const drmLabel = this.mapDrmFromSystemId(idMatch[1]);
            if (drmLabel) {
                drmSet.add(drmLabel);
            }
        });
        analysis.drmSystems = Array.from(drmSet);
        analysis.encryption = drmSet.size > 0 ? "cenc" : "clear";
        analysis.segmentFormat = "fmp4";
        return analysis;
    }

    /**
     * @description Smooth Streaming の SystemID を DRM 名にマップします。
     * @param {string} systemId SystemID 値です。
     * @returns {string|null} DRM 名称です。
     */
    static mapDrmFromSystemId(systemId) {
        if (!systemId) {
            return null;
        }
        const normalized = systemId.toLowerCase();
        if (normalized.includes("9a04f079-9840-4286-ab92-e65be0885f95")) {
            return "PLAYREADY";
        }
        if (normalized.includes("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed")) {
            return "WIDEVINE";
        }
        return systemId;
    }

    /**
     * @description HLS の属性リストをオブジェクトに変換します。
     * @param {string} line 属性リストを含む行です。
     * @returns {Record<string, string>} 解析結果です。
     */
    static parseAttributeList(line) {
        const attributes = {};
        const attrStringMatch = line.split(":", 2)[1];
        if (!attrStringMatch) {
            return attributes;
        }
        const regex = /([A-Z0-9-]+)=(("[^"]*")|([^,]*))/gi;
        let match;
        while ((match = regex.exec(attrStringMatch)) !== null) {
            const key = match[1];
            const rawValue = match[3] || match[4] || "";
            attributes[key] = rawValue.replace(/^"|"$/g, "");
        }
        return attributes;
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

function safeShouldInspectManifestResponse(url, contentType) {
    try {
        return shouldInspectManifestResponse(url, contentType);
    } catch (error) {
        console.debug("[WidevineProxy2] shouldInspectManifestResponse failed", error);
        return false;
    }
}

if (!WVP_PATCH_FLAGS.fetchPatched && typeof window !== "undefined" && typeof window.fetch === "function") {
    WVP_PATCH_FLAGS.fetchPatched = true;
    const originalFetch = window.fetch;
    window.fetch = function() {
        const args = arguments;
        return new Promise(async (resolve, reject) => {
            originalFetch.apply(this, args).then((response) => {
                if (response) {
                    const responseUrl = args.length === 1 ? args[0]?.url ?? args[0] : args[0];
                    const contentType = response.headers ? response.headers.get("content-type") || "" : "";
                    const shouldInspect = safeShouldInspectManifestResponse(responseUrl, contentType);
                    if (!shouldInspect || hasManifestBeenInspected(responseUrl)) {
                        resolve(response);
                        return;
                    }
                    let cloned;
                    try {
                        cloned = response.clone();
                    } catch (error) {
                        console.debug("[WidevineProxy2] response clone failed", error);
                        resolve(response);
                        return;
                    }
                    cloned.text().then((text) => {
                        const manifest_type = Evaluator.getManifestType(text);
                        if (manifest_type) {
                            const manifestPayload = {
                                url: args.length === 1 ? args[0]?.url ?? args[0] : args[0],
                                type: manifest_type,
                                size: text.length,
                                details: Evaluator.analyzeManifest(text, { url: responseUrl })
                            };
                            emitAndWaitForResponse("MANIFEST", JSON.stringify(manifestPayload));
                            markManifestInspected(responseUrl);
                        }
                        resolve(response);
                    }).catch((error) => {
                        console.debug("[WidevineProxy2] manifest fetch parse skipped", error);
                        resolve(response);
                    })
                } else {
                    resolve(response);
                }
            }).catch((error) => {
                reject(error);
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
            try {
                if (this._method === "GET") {
                    const contentTypeHeader = this.getResponseHeader ? this.getResponseHeader("content-type") : "";
                    const shouldInspect = safeShouldInspectManifestResponse(this.responseURL, contentTypeHeader);
                    if (!shouldInspect || hasManifestBeenInspected(this.responseURL)) {
                        return;
                    }
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
                            "size": body.length,
                            "details": Evaluator.analyzeManifest(body, { url: this.responseURL })
                        }));
                        markManifestInspected(this.responseURL);
                    }
                }
            } catch (error) {
                console.debug("[WidevineProxy2] XHR manifest hook failed", error);
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

/**
 * @description ページ情報を Service Worker に渡し、yt-dlp フォールバック判定を促します。
 */
(() => {
    if (typeof window === "undefined") {
        return;
    }
    if (window.top && window.top !== window.self) {
        return;
    }
    if (WVP_PATCH_FLAGS.pageMetadataReported) {
        return;
    }
    WVP_PATCH_FLAGS.pageMetadataReported = true;
    const METADATA_DEBOUNCE_MS = 500;
    const VIDEO_PROBE_DELAYS_MS = [250, 750, 1800, 3500, 6000];
    const metadataState = {
        lastUrl: null,
        lastTitle: null,
        timerId: null
    };
    const boundVideoElements = new WeakSet();
    const videoProbeState = {
        hasVideo: false,
        timerId: null,
        probeCursor: 0,
        lastProbeRequestedAt: null,
        lastSuccessfulProbeAt: null,
        lastProbeReason: null,
        exhausted: false,
        mutationObserver: null,
        observerBound: false,
        lastReportDispatchedAt: null
    };

    /**
     * @description 動画検知フラグを初期化し、保留中のタイマーを停止します。
     * @returns {void}
     */
    function resetVideoProbeState() {
        if (videoProbeState.timerId) {
            clearTimeout(videoProbeState.timerId);
        }
        videoProbeState.timerId = null;
        videoProbeState.hasVideo = false;
        videoProbeState.probeCursor = 0;
        videoProbeState.exhausted = false;
        videoProbeState.lastProbeRequestedAt = null;
        videoProbeState.lastSuccessfulProbeAt = null;
        videoProbeState.lastProbeReason = null;
        videoProbeState.lastReportDispatchedAt = null;
    }

    /**
     * @description 動画検知ループを開始します。
     * @returns {void}
     */
    function startVideoProbeLoop() {
        if (videoProbeState.hasVideo || videoProbeState.timerId) {
            return;
        }
        ensureVideoDetectionObservers();
        if (runVideoProbeImmediate("start")) {
            return;
        }
        scheduleNextVideoProbe();
    }

    /**
     * @description SPA遷移などに合わせて動画検知をリスタートします。
     * @returns {void}
     */
    function restartVideoProbeLoop() {
        resetVideoProbeState();
        startVideoProbeLoop();
    }

    /**
     * @description 次回の動画検知タイマーを設定します。
     * @returns {void}
     */
    function scheduleNextVideoProbe() {
        if (videoProbeState.hasVideo || videoProbeState.probeCursor >= VIDEO_PROBE_DELAYS_MS.length) {
            videoProbeState.timerId = null;
            if (!videoProbeState.hasVideo) {
                videoProbeState.exhausted = true;
            }
            return;
        }
        const delay = VIDEO_PROBE_DELAYS_MS[videoProbeState.probeCursor];
        videoProbeState.probeCursor += 1;
        videoProbeState.timerId = setTimeout(runVideoProbe, delay);
    }

    /**
     * @description 実際の動画探索を行い、結果に応じてメタデータ再送を促します。
     * @returns {void}
     */
    function runVideoProbe() {
        videoProbeState.timerId = null;
        if (runVideoProbeImmediate("timer")) {
            return;
        }
        scheduleNextVideoProbe();
    }

    /**
     * @description 動画検出済みの状態を反映し、必要ならメタデータを再送します。
     * @param {string} reason 検知理由です。
     * @param {{immediate?: boolean}} [options] 追加オプションです。
     * @returns {void}
     */
    function handleVideoDetected(reason, options = {}) {
        const now = Date.now();
        videoProbeState.hasVideo = true;
        videoProbeState.lastProbeReason = reason || videoProbeState.lastProbeReason || null;
        videoProbeState.lastSuccessfulProbeAt = now;
        videoProbeState.exhausted = false;
        if (videoProbeState.timerId) {
            clearTimeout(videoProbeState.timerId);
            videoProbeState.timerId = null;
        }
        videoProbeState.probeCursor = VIDEO_PROBE_DELAYS_MS.length;
        if (options.immediate && videoProbeState.lastProbeRequestedAt == null) {
            videoProbeState.lastProbeRequestedAt = now;
        }
        if (videoProbeState.lastReportDispatchedAt && (now - videoProbeState.lastReportDispatchedAt) < 200) {
            return;
        }
        videoProbeState.lastReportDispatchedAt = now;
        reportPageMetadata(true);
    }

    /**
     * @description 即時の動画探索を行い、成功時はメタデータを即座に再送します。
     * @param {string} reason 判定理由です。
     * @returns {boolean} 動画が検出できた場合は true。
     */
    function runVideoProbeImmediate(reason) {
        videoProbeState.lastProbeRequestedAt = Date.now();
        videoProbeState.lastProbeReason = reason || null;
        const found = detectInlineVideoElements();
        if (!found) {
            return false;
        }
        handleVideoDetected(reason, { immediate: true });
        return true;
    }

    /**
     * @description 既存および新規の video 要素へイベント監視を紐付けます。
     * @param {string} reason 呼び出し理由です。
     * @returns {void}
     */
    function scanAndAttachVideoElements(reason) {
        const videos = document.querySelectorAll("video");
        videos.forEach((video) => attachVideoElementListeners(video, reason));
    }

    /**
     * @description 単一の video 要素にメディアイベント監視を設定します。
     * @param {HTMLVideoElement} video 対象要素です。
     * @param {string} reason 呼び出し理由です。
     * @returns {void}
     */
    function attachVideoElementListeners(video, reason) {
        if (!video || boundVideoElements.has(video)) {
            return;
        }
        const events = ["loadedmetadata", "loadeddata", "canplay", "playing", "play", "timeupdate"];
        const onMediaEvent = (event) => {
            handleVideoDetected(event?.type || "video-event");
        };
        events.forEach((eventName) => {
            try {
                video.addEventListener(eventName, onMediaEvent, { passive: true });
            } catch {
                // イベント登録に失敗した場合は無視
            }
        });
        boundVideoElements.add(video);
        if (video.readyState >= (HTMLMediaElement?.HAVE_CURRENT_DATA || 2) || video.currentSrc || video.src) {
            handleVideoDetected(reason || "video-ready");
        }
    }

    /**
     * @description MutationObserver を活用し、video 要素の挿入を監視します。
     * @returns {void}
     */
    function ensureVideoDetectionObservers() {
        if (videoProbeState.observerBound || typeof MutationObserver === "undefined") {
            return;
        }
        const observer = new MutationObserver((records) => {
            for (const record of records) {
                for (const node of Array.from(record.addedNodes || [])) {
                    if (!(node instanceof Element)) {
                        continue;
                    }
                    if (node.tagName === "VIDEO") {
                        attachVideoElementListeners(node, "mutation-video");
                        continue;
                    }
                    if (node.tagName === "SOURCE") {
                        const ownerVideo = node.closest("video");
                        if (ownerVideo) {
                            attachVideoElementListeners(ownerVideo, "mutation-source");
                        }
                        continue;
                    }
                    const nestedVideos = node.querySelectorAll?.("video");
                    if (nestedVideos && nestedVideos.length) {
                        nestedVideos.forEach((element) => attachVideoElementListeners(element, "mutation-descendant"));
                    }
                }
            }
        });
        observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true
        });
        videoProbeState.mutationObserver = observer;
        videoProbeState.observerBound = true;
        scanAndAttachVideoElements("observer-init");
    }

    /**
     * @description ドキュメント内の video 要素をゆるく検知します。
     * @returns {boolean} video が見つかれば true。
     */
    function detectInlineVideoElements() {
        const videos = document.querySelectorAll("video");
        if (!videos.length) {
            return false;
        }
        for (const video of videos) {
            attachVideoElementListeners(video, "poll");
            if (!video || !video.isConnected) {
                continue;
            }
            if (video.readyState >= (HTMLMediaElement?.HAVE_CURRENT_DATA || 2)) {
                return true;
            }
            if (video.currentSrc || video.src) {
                return true;
            }
            const hasSourceChild = Array.from(video.querySelectorAll("source[src]"))
                .some((source) => Boolean(source.src));
            if (hasSourceChild) {
                return true;
            }
        }
        return false;
    }

    /**
     * @description 動画検知ステータスをメタデータ送信ペイロードに付与します。
     * @returns {object} mediaHints を返します。
     */
    function buildMediaHintsPayload() {
        return {
            hasInlineVideo: videoProbeState.hasVideo,
            pendingProbe: Boolean(videoProbeState.timerId),
            probesExecuted: videoProbeState.probeCursor,
            probesRemaining: Math.max(VIDEO_PROBE_DELAYS_MS.length - videoProbeState.probeCursor, 0),
            probesExhausted: videoProbeState.exhausted,
            lastProbeRequestedAt: videoProbeState.lastProbeRequestedAt,
            lastSuccessfulProbeAt: videoProbeState.lastSuccessfulProbeAt,
            lastProbeReason: videoProbeState.lastProbeReason
        };
    }

    /**
     * @description ナビゲーション開始を Service Worker に通知します。
     * @param {string} eventName 発火元イベント名です。
     * @returns {void}
     */
    function notifyOverlayNavigation(eventName) {
        try {
            const payload = {
                url: window.location.href,
                reason: "navigation",
                event: eventName,
                firedAt: Date.now(),
                historyLength: typeof window.history !== "undefined" ? window.history.length : null
            };
            void emitAndWaitForResponse("PAGE_NAVIGATION", JSON.stringify(payload)).catch(() => {});
        } catch (error) {
            console.debug("[WidevineProxy2] PAGE_NAVIGATION dispatch failed", error);
        }
    }

    /**
     * @description Service Worker からのメタデータ応答を処理します。
     * @param {string} raw 応答文字列です。
     * @returns {void}
     */
    function applyMetadataResponse(raw) {
        if (!raw) {
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            if (Object.prototype.hasOwnProperty.call(parsed, "forceGeneric")) {
                applyPageProfilePatch({ forceGeneric: Boolean(parsed.forceGeneric) });
            }
        } catch (error) {
            console.debug("[WidevineProxy2] PAGE_METADATA response parse failed", error);
        }
    }

    function reportPageMetadata(force = false) {
        const currentUrl = window.location.href;
        const currentTitle = document.title || null;
        if (!force && metadataState.lastUrl === currentUrl && metadataState.lastTitle === currentTitle) {
            return;
        }
        const urlChanged = metadataState.lastUrl && metadataState.lastUrl !== currentUrl;
        metadataState.lastUrl = currentUrl;
        metadataState.lastTitle = currentTitle;
        if (urlChanged) {
            resetPageProfileFlags();
            restartVideoProbeLoop();
            notifyOverlayNavigation("metadata:url-change");
        } else {
            startVideoProbeLoop();
        }
        try {
            const payload = {
                url: currentUrl,
                title: currentTitle,
                mediaHints: buildMediaHintsPayload()
            };
            emitAndWaitForResponse("PAGE_METADATA", JSON.stringify(payload))
                .then(applyMetadataResponse)
                .catch(() => {});
        } catch (error) {
            console.debug("[WidevineProxy2] PAGE_METADATA dispatch failed", error);
        }
    }

    function scheduleMetadataReport(force = false) {
        if (metadataState.timerId) {
            clearTimeout(metadataState.timerId);
        }
        metadataState.timerId = setTimeout(() => {
            metadataState.timerId = null;
            reportPageMetadata(force);
        }, METADATA_DEBOUNCE_MS);
    }

    startVideoProbeLoop();
    reportPageMetadata(true);

    const titleNode = document.querySelector("title");
    if (titleNode && typeof MutationObserver !== "undefined") {
        const observer = new MutationObserver(() => scheduleMetadataReport());
        observer.observe(titleNode, { childList: true });
    } else {
        document.addEventListener("DOMContentLoaded", () => scheduleMetadataReport());
    }

    const navigationEvents = [
        "yt-page-data-updated",
        "yt-navigate-finish",
        "popstate",
        "pageshow"
    ];
    navigationEvents.forEach((eventName) => {
        window.addEventListener(eventName, () => {
            restartVideoProbeLoop();
            notifyOverlayNavigation(eventName);
            scheduleMetadataReport(true);
        }, { passive: true });
    });
})();
