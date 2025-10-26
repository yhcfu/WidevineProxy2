import "./protobuf.min.js";
import "./license_protocol.js";
import "./forge.min.js";

import { Session } from "./license.js";
import {
    DeviceManager,
    base64toUint8Array,
    uint8ArrayToBase64,
    uint8ArrayToHex,
    SettingsManager,
    AsyncLocalStorage, RemoteCDMManager
} from "./util.js";
import { WidevineDevice } from "./device.js";
import { RemoteCdm } from "./remote_cdm.js";
import { DownloadStrategyRegistry } from "./strategies/registry.js";
import { DashWidevineStrategy } from "./strategies/dash_widevine.js";
import { DashClearKeyStrategy } from "./strategies/dash_clearkey.js";
import { HlsWidevineStrategy } from "./strategies/hls_widevine.js";
import { HlsFairPlayStrategy } from "./strategies/hls_fairplay.js";
import { LiveHlsStrategy } from "./strategies/live_hls.js";
import { HlsClearStrategy } from "./strategies/hls_clear.js";
import { SmoothStreamingStrategy } from "./strategies/smooth_streaming.js";
import { ProgressiveStrategy } from "./strategies/progressive.js";
import { GenericYtDlpStrategy } from "./strategies/generic_ytdlp.js";
import { isUrlSupportedByYtDlp } from "./supported_sites.js";

const { LicenseType, SignedMessage, LicenseRequest, License } = protobuf.roots.default.license_protocol;

const HOST_NAME = "com.widevineproxy2.downloader";
const HOST_STATUS = {
    DISCONNECTED: "disconnected",
    PENDING: "pending",
    CONNECTING: "connecting",
    CONNECTED: "connected",
    ERROR: "error"
};
const KEEP_ALIVE_ALARM = "nativeHostKeepAlive";
const HOST_RECONNECT_ALARM = "nativeHostReconnect";
const REQUEST_CACHE_LIMIT = 200;
const REQUEST_CACHE_TTL_MS = 5 * 60 * 1000;
const MANIFEST_PSSH_HISTORY_LIMIT = 50;
const MANIFEST_PSSH_HISTORY_TTL_MS = 10 * 60 * 1000;
const TAB_MANIFEST_CACHE_LIMIT = 50;
const TAB_MANIFEST_CACHE_TTL_MS = 10 * 60 * 1000;
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_JUSTIFICATION = "ネイティブホスト常駐のための keepalive";
const OFFSCREEN_REASON = "DOM_PARSER";
const JOB_PAYLOAD_SCHEMA_VERSION = 2;
const OUTPUT_SLUG_MAX_LENGTH = 60;
const overlayStateByTab = new Map();
const overlayLifecycleByTab = new Map();
const overlaySuppressionByLog = new Map();
const jobToastTargets = new Map();
const tabNavigationMetadataByTab = new Map();
let folderRevealReleaseTimer = null;
const OVERLAY_SUPPRESSION_MS = 30 * 1000;
const HOST_JOB_TAB_MAP_KEY = "native_job_tab_targets";
const HOST_PAYLOAD_WARN_THRESHOLD_BYTES = 512 * 1024;
const BF_CACHE_ERROR_REGEX = /back\/forward cache/i;
const RECEIVING_END_ERROR_REGEX = /Receiving end does not exist|No tab with id|frame was removed/i;
const WEB_NAVIGATION_FILTER = { url: [{ schemes: ["http", "https"] }] };
const downloadStrategyRegistry = new DownloadStrategyRegistry();
const OVERLAY_RESET_THROTTLE_MS = 500;
const OVERLAY_METADATA_BLOCKLIST_HOSTS = new Set([
    "google.com",
    "www.google.com",
    "mail.google.com",
    "news.google.com",
    "drive.google.com",
    "calendar.google.com",
    "docs.google.com",
    "accounts.google.com"
]);
downloadStrategyRegistry.register(new DashWidevineStrategy({
    schemaVersion: JOB_PAYLOAD_SCHEMA_VERSION,
    helpers: {
        serializeLicenseKeys,
        deriveOutputSlug,
        quoteArg
    }
}));
downloadStrategyRegistry.register(new DashClearKeyStrategy({
    schemaVersion: JOB_PAYLOAD_SCHEMA_VERSION,
    helpers: {
        deriveOutputSlug,
        quoteArg
    }
}));
downloadStrategyRegistry.register(new HlsWidevineStrategy({
    schemaVersion: JOB_PAYLOAD_SCHEMA_VERSION,
    helpers: {
        serializeLicenseKeys,
        deriveOutputSlug,
        quoteArg
    }
}));
downloadStrategyRegistry.register(new HlsFairPlayStrategy({
    schemaVersion: JOB_PAYLOAD_SCHEMA_VERSION,
    helpers: {
        serializeLicenseKeys,
        deriveOutputSlug,
        quoteArg
    }
}));
downloadStrategyRegistry.register(new LiveHlsStrategy({
    schemaVersion: JOB_PAYLOAD_SCHEMA_VERSION,
    helpers: {
        serializeLicenseKeys,
        deriveOutputSlug,
        quoteArg
    }
}));
downloadStrategyRegistry.register(new HlsClearStrategy({
    schemaVersion: JOB_PAYLOAD_SCHEMA_VERSION,
    helpers: {
        serializeLicenseKeys,
        deriveOutputSlug,
        quoteArg
    }
}));
downloadStrategyRegistry.register(new SmoothStreamingStrategy({
    schemaVersion: JOB_PAYLOAD_SCHEMA_VERSION,
    helpers: {
        serializeLicenseKeys,
        deriveOutputSlug,
        quoteArg
    }
}));
downloadStrategyRegistry.register(new ProgressiveStrategy({
    schemaVersion: JOB_PAYLOAD_SCHEMA_VERSION,
    helpers: {
        deriveOutputSlug,
        quoteArg
    }
}));
downloadStrategyRegistry.register(new GenericYtDlpStrategy({
    schemaVersion: JOB_PAYLOAD_SCHEMA_VERSION,
    helpers: {
        deriveOutputSlug,
        quoteArg
    }
}));
function suppressOverlayForLog(logKey, duration = OVERLAY_SUPPRESSION_MS) {
    if (!logKey) {
        return;
    }
    overlaySuppressionByLog.set(logKey, Date.now() + duration);
}

function isOverlaySuppressed(logKey) {
    if (!logKey) {
        return false;
    }
    const expiresAt = overlaySuppressionByLog.get(logKey);
    if (!expiresAt) {
        return false;
    }
    if (Date.now() > expiresAt) {
        overlaySuppressionByLog.delete(logKey);
        return false;
    }
    return true;
}

/**
 * @description オーバーレイ抑止状態の期限切れを掃除します。
 */
function pruneOverlaySuppressionCache() {
    const now = Date.now();
    for (const [key, expiresAt] of overlaySuppressionByLog.entries()) {
        if (!expiresAt || now > expiresAt) {
            overlaySuppressionByLog.delete(key);
        }
    }
}

class NativeHostBridge {
    constructor() {
        this.port = null;
        this.status = HOST_STATUS.PENDING;
        this.lastError = null;
        this.lastErrorAt = null;
        this.connectingPromise = null;
        this.shouldHoldConnection = false;
        this.desiredConnectionReason = "";
        this.deferredReleaseTimer = null;
    }

    getStatus() {
        return {
            status: this.status,
            lastError: this.lastError,
            lastErrorAt: this.lastErrorAt,
            shouldHoldConnection: this.shouldHoldConnection,
            connected: Boolean(this.port)
        };
    }

    clearDeferredReleaseTimer() {
        if (this.deferredReleaseTimer) {
            clearTimeout(this.deferredReleaseTimer);
            this.deferredReleaseTimer = null;
        }
    }

    scheduleDeferredIdleRelease(reason = "idle", delayMs = 3000) {
        if (this.shouldHoldConnection || this.status === HOST_STATUS.ERROR) {
            return;
        }
        this.clearDeferredReleaseTimer();
        this.deferredReleaseTimer = setTimeout(() => {
            this.deferredReleaseTimer = null;
            this.maybeReleaseIdleConnection(reason).catch((error) => {
                console.debug("[NativeHostBridge] deferred release skipped", error);
            });
        }, Math.max(500, delayMs));
    }

    /**
     * @description ジョブ需要に応じて接続維持要否を更新します。
     * @param {boolean} shouldHold 接続維持が必要なら true。
     * @param {{reason?: string}} [options] 呼び出し理由です。
     * @returns {void}
     */
    setConnectionDemand(shouldHold, { reason = "" } = {}) {
        this.shouldHoldConnection = shouldHold;
        this.desiredConnectionReason = reason;
        if (shouldHold) {
            this.clearDeferredReleaseTimer();
            if (!this.port && this.status !== HOST_STATUS.CONNECTING && this.status !== HOST_STATUS.ERROR) {
                this.updateStatus(HOST_STATUS.PENDING);
            }
            this.ensureConnected().catch((error) => {
                console.warn("[NativeHostBridge] demand connect failed", error);
            });
            return;
        }
        this.clearDeferredReleaseTimer();
        this.teardownConnection(reason).catch((error) => {
            console.debug("[NativeHostBridge] teardown skipped", error);
        });
    }

    async ensureConnected({ force = false } = {}) {
        if (this.port) {
            return this.port;
        }
        if (!force && !this.shouldHoldConnection) {
            return null;
        }
        if (this.connectingPromise) {
            return this.connectingPromise;
        }

        this.connectingPromise = (async () => {
            try {
                console.log("[NativeHostBridge] connecting to", HOST_NAME);
                this.updateStatus(this.shouldHoldConnection ? HOST_STATUS.CONNECTING : HOST_STATUS.PENDING);
                this.port = chrome.runtime.connectNative(HOST_NAME);
                this.port.onMessage.addListener((message) => {
                    this.handleMessage(message);
                });
                this.port.onDisconnect.addListener(() => {
                    const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
                    this.handleDisconnect(error);
                });
                console.log("[NativeHostBridge] connectNative resolved");
                this.lastError = null;
                this.lastErrorAt = null;
                try {
                    this.port.postMessage({ kind: "ping" });
                } catch (pingError) {
                    console.warn("[NativeHostBridge] failed to send ping", pingError);
                }
                scheduleKeepAlive();
                this.updateStatus(HOST_STATUS.CONNECTED);
                if (this.shouldHoldConnection) {
                    ensureOffscreenDocument("native-host-connected").catch((error) => {
                        console.warn("[WidevineProxy2] Offscreen作成失敗(native)", error);
                    });
                } else {
                    this.scheduleDeferredIdleRelease("post-connect");
                }
                replayPendingNativeJobs("connect").catch((error) => {
                    console.warn("[WidevineProxy2] ジョブ再送に失敗しました", error);
                });
            } catch (error) {
                this.handleError(error instanceof Error ? error : new Error(String(error)));
                throw error;
            }
            return this.port;
        })();

        try {
            return await this.connectingPromise;
        } finally {
            this.connectingPromise = null;
        }
    }

    async sendMessage(payload) {
        const transient = !this.shouldHoldConnection;
        try {
            await this.ensureConnected({ force: true });
            if (!this.port) {
                console.warn("[NativeHostBridge] port unavailable");
                return;
            }
            logPayloadSize("nativeHostBridge", payload);
            this.port.postMessage(payload);
            console.log("[NativeHostBridge] sent", payload);
        } catch (error) {
            console.error("[NativeHostBridge] failed to send payload", error);
        } finally {
            if (transient) {
                await this.maybeReleaseIdleConnection("transient-message");
            }
        }
    }

    async reconnect({ force = true, reason = "manual" } = {}) {
        if (this.port) {
            try {
                this.port.disconnect();
            } catch (error) {
                console.warn("native host disconnect error", error);
            }
            this.port = null;
        }
        await this.ensureConnected({ force });
        if (!this.shouldHoldConnection && !force) {
            await this.maybeReleaseIdleConnection(reason);
        }
    }

    /**
     * @description 接続需要がない場合にポートを解放します。
     * @param {string} reason 解放理由です。
     * @returns {Promise<void>} 解放完了の Promise です。
     */
    async maybeReleaseIdleConnection(reason = "idle") {
        if (this.shouldHoldConnection) {
            return;
        }
        await this.teardownConnection(reason);
    }

    /**
     * @description パネルの Retry 操作に応じて再接続します。
     * @param {string} trigger 呼び出し元識別子です。
     * @returns {Promise<void>} 再接続完了の Promise です。
     */
    async retryConnection(trigger = "manual", { holdForMs = 0 } = {}) {
        this.lastError = null;
        this.lastErrorAt = null;
        await this.reconnect({ force: true, reason: trigger });
        if (!this.shouldHoldConnection) {
            if (holdForMs > 0) {
                this.scheduleDeferredIdleRelease("manual-retry", holdForMs);
            } else {
                await this.maybeReleaseIdleConnection("manual-retry-idle");
            }
        }
    }

    /**
     * @description ポートとオフスクリーンを破棄します。
     * @param {string} reason 破棄理由です。
     * @returns {Promise<void>} 破棄完了時に解決します。
     */
    async teardownConnection(reason = "idle") {
        this.clearDeferredReleaseTimer();
        if (this.connectingPromise) {
            try {
                await this.connectingPromise;
            } catch (error) {
                console.debug("[NativeHostBridge] pending connect cancelled", error);
            }
        }
        if (this.port) {
            try {
                this.port.disconnect();
            } catch (error) {
                console.warn("native host disconnect error", error);
            }
            this.port = null;
        }
        if (this.status !== HOST_STATUS.ERROR) {
            // ジョブが無い場合は Pending 表示へ戻し、再待機状態を示す
            const nextStatus = this.shouldHoldConnection ? HOST_STATUS.DISCONNECTED : HOST_STATUS.PENDING;
            this.updateStatus(nextStatus);
        }
        try {
            await closeOffscreenDocumentIfIdle(true);
        } catch (error) {
            console.debug("[NativeHostBridge] offscreen close skipped", error);
        }
        console.debug("[NativeHostBridge] connection released", reason);
    }

    handleMessage(message) {
        console.log("[NativeHostBridge] message", message);
        if (message?.type === "job-progress" || message?.stage) {
            this.handleJobProgress(message);
            return;
        }
        if (message && typeof message.status === "string") {
            if (message.jobId && message.clientJobId) {
                hostJobToClientJob.set(message.jobId, message.clientJobId);
                upsertNativeJobDraft(message.clientJobId, {
                    hostJobId: message.jobId,
                    status: message.status,
                    detail: message.message,
                    updatedAt: Date.now()
                }).catch((error) => {
                    console.error("[WidevineProxy2] ジョブACKの保存に失敗しました", error);
                });
            }
            this.broadcast({
                type: "job-ack",
                ...message
            });
        }
    }

    /**
     * @description ネイティブホストからの進捗イベントを処理します。
     * @param {object} event ネイティブホストが送信した進捗情報です。
     */
    handleJobProgress(event) {
        const jobKey = resolveJobKeyFromEvent(event);
        const jobStatus = getJobStatusFromEvent(event);
        const normalizedStatus = (jobStatus || "").toString().toLowerCase();
        let shouldDrop = false;
        if (jobKey) {
            const update = {
                clientJobId: jobKey,
                hostJobId: event.jobId ?? event.hostJobId ?? null,
                stage: event.stage ?? event.status ?? "pending",
                status: event.status ?? event.stage ?? "pending",
                detail: event.message ?? "",
                progress: typeof event.progress === "number" ? event.progress : null,
                mpdUrl: event.mpd_url ?? event.mpdUrl ?? null,
                sourceUrl: event.source_url ?? event.sourceUrl ?? null,
                outputPath: event.output_path ?? event.outputPath ?? null,
                outputDir: event.output_dir ?? event.outputDir ?? null,
                updatedAt: Date.now()
            };
            if (normalizedStatus === "waiting") {
                update.waitingSince = update.waitingSince || Date.now();
                update.runSlot = null;
                releaseJobSlot(jobKey);
            } else {
                update.waitingSince = null;
            }
            if (RUNNING_JOB_STATUSES.has(normalizedStatus)) {
                const slot = ensureJobSlot(jobKey);
                if (slot !== null) {
                    update.runSlot = slot;
                }
            }
            if (isTerminalJobStatus(normalizedStatus)) {
                releaseJobSlot(jobKey);
                update.runSlot = null;
            }
            if (Object.prototype.hasOwnProperty.call(update, "runSlot")) {
                event.runSlot = update.runSlot;
            }
            if (Object.prototype.hasOwnProperty.call(update, "waitingSince")) {
                event.waitingSince = update.waitingSince;
            }
            upsertNativeJobDraft(jobKey, update).catch((error) => {
                console.error("[WidevineProxy2] 進捗保存に失敗しました", error);
            });
            if (shouldDropPayloadForStatus(normalizedStatus)) {
                shouldDrop = true;
            }
        }
        this.broadcast(event);
        if (jobKey && shouldDrop) {
            dropJobPayload(jobKey).catch((error) => {
                console.debug("[WidevineProxy2] ペイロード削除に失敗", error);
            });
        }
    }

    handleDisconnect(errorMessage) {
        clearKeepAlive();
        this.port = null;
        if (errorMessage) {
            console.warn("Native host disconnected", errorMessage);
            this.handleError(new Error(errorMessage));
            return;
        }
        if (this.shouldHoldConnection) {
            this.updateStatus(HOST_STATUS.PENDING);
            scheduleHostReconnect();
            return;
        }
        this.updateStatus(HOST_STATUS.PENDING);
        closeOffscreenDocumentIfIdle(true).catch((error) => {
            console.warn("[WidevineProxy2] Offscreen close failed", error);
        });
    }

    handleError(error) {
        this.lastError = error ? error.message : null;
        this.lastErrorAt = Date.now();
        console.error("Native host bridge error", error);
        this.updateStatus(HOST_STATUS.ERROR);
        if (this.shouldHoldConnection) {
            scheduleHostReconnect();
        }
        closeOffscreenDocumentIfIdle(true).catch((closeError) => {
            console.warn("[WidevineProxy2] Offscreen close failed", closeError);
        });
    }

    /**
     * @description ホストの現在ステータスを更新し、監視用ログおよびパネルへ通知します。
     * @param {string} status 更新後のステータスです。
     * @returns {void}
     */
    updateStatus(status) {
        const previousStatus = this.status;
        this.status = status;
        console.log("[NativeHostBridge] status", status, this.lastError);
        if (status === HOST_STATUS.CONNECTED) {
            if (previousStatus !== HOST_STATUS.CONNECTED) {
                console.info("Native host: connected");
            }
            resetHostReconnectBackoff();
        }
        safeRuntimeSendMessage({
            type: "HOST_STATUS_UPDATE",
            payload: this.getStatus()
        });
    }

    broadcast(payload) {
        broadcastHostNativeEvent(payload);
    }
}


let manifests = new Map();
const tabManifestTimestamps = new Map();
let requests = new Map();
let sessions = new Map();
let logs = [];
let jobDraftCache = null;
let jobDraftCacheLoadPromise = null;
let jobDraftFlushTimer = null;
let hasActiveNativeJobs = false;
const tabResolutionCache = new Map();
const nativeHostBridge = new NativeHostBridge();
const HOST_JOB_STORAGE_KEY = "native_jobs";
const HOST_JOB_PAYLOAD_KEY = "native_job_payloads";
const HOST_JOB_HISTORY_LIMIT = 50;
const HOST_JOB_STALE_WINDOW_MS = 72 * 60 * 60 * 1000;
const MAX_CONCURRENT_HOST_JOBS = 5;
const RUNNING_JOB_STATUSES = new Set(["queued", "preparing", "downloading", "decrypting", "muxing", "cancelling"]);
const CACHE_MAINTENANCE_ALARM = "cacheMaintenance";
const CACHE_MAINTENANCE_INTERVAL_MIN = 5;
const LOG_MEMORY_LIMIT = 200;
const LOG_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;
const JOB_DRAFT_FLUSH_INTERVAL_MS = 750;
const TAB_RESOLUTION_CACHE_TTL_MS = 10 * 60 * 1000;
const hostJobToClientJob = new Map();
const jobSlotAssignments = new Map();
const manifestHistoryByOrigin = new Map();
const manifestHistoryByOriginAndPssh = new Map();
let reconnectBackoffMs = 1000;
let offscreenCreationPromise = null;
let offscreenActive = false;
let replayJobsPromise = null;

/**
 * @description ネイティブホスト接続を初期化し、起動直後から単一ポートを維持します。
 * @param {string} trigger どのイベントで起動したかを示す識別子です。
 */
function bootstrapNativeHostPort(trigger) {
    ensureJobDraftCache()
        .then(() => {
            if (hasActiveNativeJobs) {
                nativeHostBridge.setConnectionDemand(true, { reason: `bootstrap:${trigger}` });
            } else {
                nativeHostBridge.updateStatus(HOST_STATUS.PENDING);
            }
        })
        .catch((error) => {
            console.warn(`[NativeHostBridge] 初期化失敗(${trigger})`, error);
        });
}

/**
 * @description Offscreen Document を生成し、Service Worker の心拍を維持します。
 * @param {string} trigger 呼び出し元識別子です。
 * @returns {Promise<void>|undefined} 作成処理の Promise です。
 */
function ensureOffscreenDocument(trigger = "") {
    if (!chrome.offscreen?.createDocument) {
        return Promise.resolve();
    }
    if (offscreenCreationPromise) {
        return offscreenCreationPromise;
    }
    offscreenCreationPromise = (async () => {
        try {
            const hasDocument = chrome.offscreen?.hasDocument ? await chrome.offscreen.hasDocument() : false;
            if (hasDocument) {
                offscreenActive = true;
                return;
            }
            await chrome.offscreen.createDocument({
                url: OFFSCREEN_DOCUMENT_PATH,
                reasons: [OFFSCREEN_REASON],
                justification: `${OFFSCREEN_JUSTIFICATION} (${trigger || "bootstrap"})`
            });
            offscreenActive = true;
        } catch (error) {
            offscreenActive = false;
            throw error;
        }
    })().finally(() => {
        offscreenCreationPromise = null;
    });
    return offscreenCreationPromise;
}

/**
 * @description Offscreen Document を必要に応じて閉じ、リソースを解放します。
 * @param {boolean} force true の場合は接続状態に関わらず即座に閉じます。
 */
async function closeOffscreenDocumentIfIdle(force = false) {
    if (!chrome.offscreen?.closeDocument) {
        return;
    }
    if (!force && nativeHostBridge.status === HOST_STATUS.CONNECTED) {
        return;
    }
    const hasDocument = chrome.offscreen?.hasDocument ? await chrome.offscreen.hasDocument() : false;
    if (!hasDocument) {
        offscreenActive = false;
        return;
    }
    try {
        const maybePromise = chrome.runtime.sendMessage({ type: "OFFSCREEN_SHUTDOWN" });
        if (maybePromise && typeof maybePromise.catch === "function") {
            await maybePromise.catch(() => {});
        }
    } catch (error) {
        // Offscreen 側が終了済みの場合は無視
    }
    try {
        await chrome.offscreen.closeDocument();
        offscreenActive = false;
    } catch (error) {
        console.warn("[WidevineProxy2] Offscreen close failed", error);
    }
}

chrome.runtime.onSuspend.addListener(() => {
    flushJobDraftCacheImmediately().catch(() => {});
    closeOffscreenDocumentIfIdle(true).catch(() => {});
});

/**
 * @description 取得したキー情報を保存し、必要であればオーバーレイを表示します。
 * @param {object} log 保存対象のログです。
 * @param {{tabId?: number|null}} [options] 追加オプションです。
 * @returns {Promise<void>} 保存完了時に解決します。
 */
async function persistCapturedKeyLog(log, options = {}) {
    if (!log) {
        return null;
    }
    const enriched = {
        ...log,
        pageTitle: options.tabTitle || log.pageTitle || null
    };
    logs.push(enriched);
    if (typeof options.tabId === "number" && enriched?.url) {
        rememberTabResolution(options.tabId, enriched.url);
        updateOverlayLifecycle(options.tabId, {
            phase: "probing",
            lastKnownUrl: enriched.url,
            lastProbePreparedAt: Date.now()
        });
    }
    pruneLogMemory();
    rememberManifestForLog(enriched);
    try {
        await AsyncLocalStorage.setStorage({ [enriched.pssh_data]: enriched });
    } catch (error) {
        console.warn("[WidevineProxy2] キーログ保存に失敗", error);
    }
    if (options.tabId || enriched?.url) {
        if (!isOverlaySuppressed(enriched.pssh_data)) {
            maybeInjectDownloadOverlay(options.tabId, enriched).catch((error) => {
                console.debug("[WidevineProxy2] overlay injection skipped", error);
            });
        }
    }
    return enriched;
}

/**
 * @description サイトメタデータから汎用ダウンロード候補を生成・保存します。
 * @param {{url?: string|null, title?: string|null}} payload 受信したメタ情報です。
 * @param {chrome.runtime.MessageSender} sender 発信元情報です。
 * @returns {Promise<string>} 処理結果(JSON文字列)です。
 */
async function handleGenericPageMetadata(payload, sender) {
    const response = {
        ok: false,
        reason: "",
        forceGeneric: false
    };
    const tabId = sender?.tab?.id ?? null;
    const reportedUrl = payload?.url || sender?.tab?.url || null;
    const reportedTitle = payload?.title || sender?.tab?.title || null;
    const previousMetadata = getTabPageMetadata(tabId);
    const previousUrl = previousMetadata?.url || null;
    const mediaHintsProvided = Object.prototype.hasOwnProperty.call(payload || {}, "mediaHints");
    const videoHints = payload?.mediaHints || {};
    const pendingProbeRaw = Boolean(videoHints.pendingProbe);
    const probesExhausted = Boolean(videoHints.probesExhausted);
    const pendingProbe = pendingProbeRaw && !probesExhausted;
    const hasInlineVideo = mediaHintsProvided ? Boolean(videoHints.hasInlineVideo) : true;
    const blocklistedHost = isOverlayMetadataBlockedHost(reportedUrl);
    if (typeof tabId === "number" && Boolean(previousUrl && reportedUrl && previousUrl !== reportedUrl)) {
        await resetOverlayForNavigation(tabId, {
            url: reportedUrl,
            navigationEvent: "metadata:url-change",
            reason: "metadata-url-change"
        });
    }
    rememberTabPageMetadata(tabId, { url: reportedUrl, title: reportedTitle });
    if (mediaHintsProvided && typeof tabId === "number") {
        updateOverlayLifecycle(tabId, {
            phase: hasInlineVideo ? "probing" : (pendingProbe ? "probing" : (probesExhausted ? "awaiting-fallback" : "idle")),
            lastVideoCheckAt: Date.now(),
            lastKnownUrl: reportedUrl,
            probesPending: pendingProbe,
            probesExhausted: Boolean(videoHints.probesExhausted),
            lastProbeRequestedAt: videoHints.lastProbeRequestedAt || null,
            lastSuccessfulProbeAt: videoHints.lastSuccessfulProbeAt || null,
            lastProbeReason: videoHints.lastProbeReason || null
        });
    }
    if (mediaHintsProvided && !hasInlineVideo) {
        if (pendingProbe) {
            response.reason = "video-probe-pending";
            return JSON.stringify(response);
        }
        if (probesExhausted && blocklistedHost) {
            if (typeof tabId === "number") {
                await resetOverlayForNavigation(tabId, {
                    url: reportedUrl,
                    navigationEvent: "media-hints:blocklist",
                    reason: "blocked-host",
                    phase: "idle",
                    force: true
                });
            }
            response.reason = "blocked-host";
            return JSON.stringify(response);
        }
        // video 要素が見つからなかったがブロック対象でもないため、フォールバック生成を許可する。
        if (typeof tabId === "number") {
            updateOverlayLifecycle(tabId, {
                phase: "fallback-ready",
                lastFallbackEvaluatedAt: Date.now()
            });
        }
    }
    const preferredUrl = await resolveSupportedPageUrl(payload?.url, sender?.tab?.url);
    if (!preferredUrl) {
        response.reason = "unsupported";
        return JSON.stringify(response);
    }
    const logKey = buildGenericLogKey(preferredUrl);
    const tabTitle = reportedTitle;
    const alreadyTracked = logs.some((entry) => entry?.pssh_data === logKey);
    if (alreadyTracked) {
        await updateGenericLogMetadata(logKey, {
            pageTitle: tabTitle || null,
            url: preferredUrl
        });
        await rehydrateOverlayForPssh(logKey, { tabId, tabTitle, tabUrl: preferredUrl });
        response.ok = true;
        response.forceGeneric = true;
        response.reason = "rehydrated";
        return JSON.stringify(response);
    }
    const genericLog = createGenericLogFromMetadata({ url: preferredUrl, title: tabTitle });
    await persistCapturedKeyLog(genericLog, { tabId, tabTitle });
    if (typeof tabId === "number") {
        updateOverlayLifecycle(tabId, {
            phase: "fallback-ready",
            lastFallbackGeneratedAt: Date.now(),
            lastKnownUrl: preferredUrl
        });
    }
    response.ok = true;
    response.forceGeneric = true;
    response.reason = "created";
    return JSON.stringify(response);
}

/**
 * @description コンテンツスクリプトからのナビゲーション通知を処理します。
 * @param {{url?: string|null, reason?: string|null, event?: string|null}} payload ナビゲーション情報です。
 * @param {chrome.runtime.MessageSender} sender 発信元情報です。
 * @returns {Promise<string>} 処理結果(JSON文字列)です。
 */
async function handleOverlayNavigationSignal(payload, sender) {
    const tabId = sender?.tab?.id ?? payload?.tabId ?? null;
    if (typeof tabId !== "number") {
        return JSON.stringify({ ok: false, reason: "no-tab" });
    }
    const nextUrl = payload?.url || sender?.tab?.url || null;
    await resetOverlayForNavigation(tabId, {
        url: nextUrl,
        navigationEvent: payload?.event || null,
        reason: payload?.reason || "page-navigation"
    });
    return JSON.stringify({ ok: true });
}

/**
 * @description yt-dlp フォールバック用のログオブジェクトを生成します。
 * @param {{url: string, title?: string|null}} options 生成元情報です。
 * @returns {object} ログエントリです。
 */
function createGenericLogFromMetadata({ url, title = null }) {
    const logKey = buildGenericLogKey(url);
    const timestamp = Math.floor(Date.now() / 1000);
    const manifestDetails = {
        type: "GENERIC",
        drmSystems: [],
        encryption: "clear",
        segmentFormat: null,
        notes: ["yt-dlp fallback"]
    };
    return {
        type: "GENERIC",
        pssh_data: logKey,
        keys: [],
        url,
        timestamp,
        manifests: [
            {
                type: "GENERIC",
                url,
                headers: {},
                details: manifestDetails
            }
        ],
        pageTitle: title || null
    };
}

/**
 * @description ログ情報とマニフェスト情報からストラテジーコンテキストをサイト判定で補強します。
 * @param {import("./strategies/base.js").StrategyContext} context 変換元コンテキストです。
 * @returns {Promise<import("./strategies/base.js").StrategyContext>} サイトプロファイル適用後のコンテキストです。
 */
async function attachSiteProfileToStrategyContext(context) {
    const siteProfile = await resolveYtDlpSiteProfile(context.log, context.manifest);
    if (!siteProfile) {
        return { ...context, siteProfile: null };
    }
    if (siteProfile.forcedStrategyId !== "generic-ytdlp") {
        return { ...context, siteProfile };
    }
    const canonicalUrl = siteProfile.canonicalUrl;
    if (!canonicalUrl) {
        return { ...context, siteProfile };
    }

    // GENERIC へ切り替える際はマニフェスト/ログ双方を安全なクリア扱いに整形する。
    const manifestDetails = buildGenericManifestDetails(context?.manifest?.details);
    const genericManifest = {
        ...(context.manifest || {}),
        type: "GENERIC",
        url: canonicalUrl,
        pageTitle: context?.manifest?.pageTitle || context?.log?.pageTitle || siteProfile.titleHint || null,
        headers: context?.manifest?.headers || {},
        details: manifestDetails
    };
    const manifestEntry = {
        type: "GENERIC",
        url: canonicalUrl,
        headers: genericManifest.headers,
        details: manifestDetails
    };
    const existingManifests = Array.isArray(context?.log?.manifests) ? context.log.manifests : [];
    const dedupedManifests = [
        manifestEntry,
        ...existingManifests.filter((entry) => entry?.url !== canonicalUrl)
    ];
    const genericLog = {
        ...(context.log || {}),
        type: "GENERIC",
        url: canonicalUrl,
        pageTitle: context?.log?.pageTitle || siteProfile.titleHint || genericManifest.pageTitle || null,
        manifests: dedupedManifests,
        keys: []
    };
    return {
        ...context,
        manifest: genericManifest,
        log: genericLog,
        keys: [],
        siteProfile
    };
}

/**
 * @description GENERIC マニフェスト用の標準詳細を構築します。
 * @param {object|null|undefined} sourceDetails 既存の詳細情報です。
 * @returns {object} GENERIC 用に正規化された詳細です。
 */
function buildGenericManifestDetails(sourceDetails = null) {
    const base = {
        type: "GENERIC",
        drmSystems: [],
        encryption: "clear",
        segmentFormat: null,
        notes: ["yt-dlp fallback"]
    };
    if (!sourceDetails || typeof sourceDetails !== "object") {
        return base;
    }
    const mergedNotes = Array.from(
        new Set([...(Array.isArray(sourceDetails.notes) ? sourceDetails.notes : []), ...base.notes])
    );
    return {
        ...sourceDetails,
        ...base,
        notes: mergedNotes
    };
}

/**
 * @description ログ/マニフェストから yt-dlp 判定用サイトプロファイルを導出します。
 * @param {object|null} log 判定対象のログです。
 * @param {object|null} manifest 判定対象のマニフェストです。
 * @returns {Promise<{forcedStrategyId: string, canonicalUrl: string, titleHint: string|null}|null>} 判定結果です。
 */
async function resolveYtDlpSiteProfile(log, manifest) {
    const preLabeledGenericUrl = log?.type === "GENERIC"
        ? (log?.url || log?.sourceUrl || null)
        : manifest?.type === "GENERIC"
            ? (manifest?.url || null)
            : null;
    if (preLabeledGenericUrl) {
        return {
            forcedStrategyId: "generic-ytdlp",
            canonicalUrl: preLabeledGenericUrl,
            titleHint: log?.pageTitle || manifest?.pageTitle || null
        };
    }

    const candidates = collectCandidateUrlsForSiteProfile(log, manifest);
    if (candidates.length === 0) {
        return null;
    }
    for (const candidate of candidates) {
        if (isLikelyAuthHost(candidate)) {
            continue;
        }
        try {
            if (await isUrlSupportedByYtDlp(candidate)) {
                return {
                    forcedStrategyId: "generic-ytdlp",
                    canonicalUrl: candidate,
                    titleHint: log?.pageTitle || manifest?.pageTitle || null
                };
            }
        } catch (error) {
            console.debug("[WidevineProxy2] yt-dlp site profile lookup failed", error);
        }
    }
    return null;
}

/**
 * @description ログおよびマニフェストからサイト判定用 URL 候補を抽出します。
 * @param {object|null} log 抽出元ログです。
 * @param {object|null} manifest 抽出元マニフェストです。
 * @returns {Array<string>} 一意な URL 候補配列です。
 */
function collectCandidateUrlsForSiteProfile(log, manifest) {
    const seen = new Set();
    const push = (value) => {
        if (!value || typeof value !== "string") {
            return;
        }
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) {
            return;
        }
        seen.add(trimmed);
    };
    push(log?.url);
    push(log?.sourceUrl);
    push(log?.tab_url);
    push(log?.pageUrl);
    push(log?.page_url);
    push(log?.manifestUrl);
    push(manifest?.url);
    push(manifest?.sourceUrl);
    if (Array.isArray(log?.manifests)) {
        log.manifests.forEach((entry) => push(entry?.url));
    }
    return Array.from(seen);
}

/**
 * @description フォールバックログ識別子を生成します。
 * @param {string} url 基準 URL です。
 * @returns {string} 一意なキーです。
 */
function buildGenericLogKey(url) {
    return `GENERIC:${url}`;
}

/**
 * @description ページ URL とタブ URL から、yt-dlp が対応する方を優先的に選びます。
 * @param {string|null|undefined} payloadUrl コンテンツ側が報告した URL です。
 * @param {string|null|undefined} tabUrl タブが保持する URL です。
 * @returns {Promise<string|null>} 対応サイトであれば URL を返します。
 */
async function resolveSupportedPageUrl(payloadUrl, tabUrl) {
    const candidates = [];
    if (tabUrl) {
        candidates.push(tabUrl);
    }
    if (payloadUrl && payloadUrl !== tabUrl) {
        candidates.push(payloadUrl);
    }
    if (candidates.length === 0) {
        return null;
    }
    for (const url of candidates) {
        if (isLikelyAuthHost(url)) {
            continue;
        }
        try {
            if (await isUrlSupportedByYtDlp(url)) {
                return url;
            }
        } catch {
            // 無視して次候補を試す。
        }
    }
    return null;
}

/**
 * @description 認証ホストなど、ダウンロード対象として不適切な URL かを判別します。
 * @param {string} url 判定対象です。
 * @returns {boolean} 認証系ホストと推定される場合は true。
 */
function isLikelyAuthHost(url) {
    if (!url) {
        return false;
    }
    try {
        const { hostname } = new URL(url);
        if (!hostname) {
            return false;
        }
        const normalized = hostname.toLowerCase();
        if (normalized.startsWith("accounts.")) {
            return true;
        }
        if (normalized.includes("auth.")) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * @description 既存の GENERIC ログを更新し、storage にも反映します。
 * @param {string} logKey 更新対象のキーです。
 * @param {{pageTitle?: string|null, url?: string|null}} updates 反映したい値です。
 * @returns {Promise<void>} 完了時に解決します。
 */
async function updateGenericLogMetadata(logKey, updates = {}) {
    if (!logKey) {
        return;
    }
    const index = logs.findIndex((entry) => entry?.pssh_data === logKey);
    if (index < 0) {
        return;
    }
    const current = logs[index] || {};
    const next = {
        ...current,
        pageTitle: updates.pageTitle || current.pageTitle || null,
        url: updates.url || current.url || null
    };
    logs[index] = next;
    try {
        await AsyncLocalStorage.setStorage({ [logKey]: next });
    } catch (error) {
        console.debug("[WidevineProxy2] failed to persist generic log update", error);
    }
}

/**
 * @description メモリ保持中のキー履歴をTTLと上限で整頓します。
 */
function pruneLogMemory() {
    if (!Array.isArray(logs) || logs.length === 0) {
        return;
    }
    const now = Date.now();
    logs = logs.filter((entry) => {
        const timestampMs = typeof entry?.timestamp === "number"
            ? entry.timestamp * 1000
            : entry?.updatedAt ?? now;
        return now - timestampMs <= LOG_MEMORY_TTL_MS;
    });
    if (logs.length > LOG_MEMORY_LIMIT) {
        logs = logs.slice(logs.length - LOG_MEMORY_LIMIT);
    }
}

/**
 * @description タブIDとURLの対応関係を記録します。
 * @param {number|null} tabId タブIDです。
 * @param {string|null} tabUrl 紐付けたいURLです。
 */
function rememberTabResolution(tabId, tabUrl) {
    if (typeof tabId !== "number" || !tabUrl) {
        return;
    }
    try {
        const parsed = new URL(tabUrl);
        upsertTabResolutionEntry(parsed.href, tabId);
        upsertTabResolutionEntry(parsed.origin, tabId);
    } catch {
        upsertTabResolutionEntry(tabUrl, tabId);
    }
}

/**
 * @description タブに紐づく最新のページメタデータを記録します。
 * @param {number|null} tabId 対象タブIDです。
 * @param {{url?: string|null, title?: string|null}} metadata 保存したい情報です。
 */
function rememberTabPageMetadata(tabId, metadata = {}) {
    if (typeof tabId !== "number") {
        return;
    }
    const next = {
        url: metadata.url || null,
        title: metadata.title || null,
        recordedAt: Date.now()
    };
    tabNavigationMetadataByTab.set(tabId, next);
    if (next.url) {
        rememberTabResolution(tabId, next.url);
    }
}

/**
 * @description タブに保存された最新メタデータを取得します。
 * @param {number|null} tabId 対象タブIDです。
 * @returns {{url: string|null, title: string|null}|null} 保存済みデータです。
 */
function getTabPageMetadata(tabId) {
    if (typeof tabId !== "number") {
        return null;
    }
    return tabNavigationMetadataByTab.get(tabId) || null;
}

/**
 * @description タブ上で document.title を直接取得します。
 * @param {number} tabId 対象タブIDです。
 * @returns {Promise<string|null>} 取得したタイトルです。
 */
async function probeDocumentTitle(tabId) {
    if (typeof tabId !== "number") {
        return null;
    }
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => document?.title || null
        });
        const first = Array.isArray(results) ? results[0] : null;
        const value = first?.result || null;
        return typeof value === "string" && value.trim() ? value : null;
    } catch (error) {
        if (!isExpectedRuntimePortError(error)) {
            console.debug("[WidevineProxy2] probeDocumentTitle failed", error);
        }
        return null;
    }
}

/**
 * @description タブAPIとキャッシュを併用して最新のURLとタイトルを推測します。
 * @param {number|null} tabId 対象タブIDです。
 * @param {{url?: string|null, title?: string|null}} fallback 初期候補です。
 * @returns {Promise<{url: string|null, title: string|null}>} 推測結果です。
 */
async function resolveLatestTabContext(tabId, fallback = {}) {
    let resolvedUrl = fallback?.url || null;
    let resolvedTitle = fallback?.title || null;
    if (typeof tabId === "number") {
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab?.url) {
                resolvedUrl = tab.url;
            }
            if (tab?.title) {
                resolvedTitle = tab.title;
            }
            rememberTabPageMetadata(tabId, { url: tab?.url || resolvedUrl, title: tab?.title || resolvedTitle });
        } catch (error) {
            if (!isExpectedRuntimePortError(error)) {
                console.debug("[WidevineProxy2] failed to resolve latest tab context", error);
            }
        }
    }
    if (typeof tabId === "number") {
        const cached = getTabPageMetadata(tabId);
        if (cached) {
            if (!resolvedUrl && cached.url) {
                resolvedUrl = cached.url;
            }
            if (!resolvedTitle && cached.title) {
                resolvedTitle = cached.title;
            }
        }
        if (!resolvedTitle) {
            const probedTitle = await probeDocumentTitle(tabId);
            if (probedTitle) {
                resolvedTitle = probedTitle;
                rememberTabPageMetadata(tabId, { url: resolvedUrl || cached?.url || fallback?.url || null, title: probedTitle });
            }
        }
    }
    return {
        url: resolvedUrl || null,
        title: resolvedTitle || null
    };
}

/**
 * @description タブ解決キャッシュへ単一キーを登録します。
 * @param {string} key 正規化済みURLまたはオリジンです。
 * @param {number} tabId 紐付けるタブIDです。
 */
function upsertTabResolutionEntry(key, tabId) {
    if (!key) {
        return;
    }
    tabResolutionCache.set(key, {
        tabId,
        recordedAt: Date.now()
    });
}

/**
 * @description キャッシュからURLに対応するタブIDを引き当てます。
 * @param {string|null} tabUrl 検索キーとなるURLです。
 * @returns {number|null} 見つかったタブIDです。
 */
function resolveTabIdFromCache(tabUrl) {
    if (!tabUrl || tabResolutionCache.size === 0) {
        return null;
    }
    pruneTabResolutionCache();
    const candidates = [];
    try {
        const parsed = new URL(tabUrl);
        candidates.push(parsed.href, parsed.origin);
    } catch {
        candidates.push(tabUrl);
    }
    for (const key of candidates) {
        const entry = tabResolutionCache.get(key);
        if (entry && typeof entry.tabId === "number") {
            return entry.tabId;
        }
    }
    return null;
}

/**
 * @description タブ解決キャッシュのTTLを超過したエントリを削除します。
 */
function pruneTabResolutionCache() {
    if (tabResolutionCache.size === 0) {
        return;
    }
    const now = Date.now();
    for (const [key, entry] of tabResolutionCache.entries()) {
        if (!entry || typeof entry.tabId !== "number" || now - (entry.recordedAt ?? 0) > TAB_RESOLUTION_CACHE_TTL_MS) {
            tabResolutionCache.delete(key);
        }
    }
}

/**
 * @description 指定タブIDに紐づくキャッシュエントリを破棄します。
 * @param {number} tabId 対象タブIDです。
 */
function forgetTabResolutionForTab(tabId) {
    if (typeof tabId !== "number" || tabResolutionCache.size === 0) {
        return;
    }
    for (const [key, entry] of tabResolutionCache.entries()) {
        if (entry?.tabId === tabId) {
            tabResolutionCache.delete(key);
        }
    }
}

/**
 * @description ペイロードサイズを概算し、必要に応じてログへ出力します。
 * @param {string} context 識別用の文言です。
 * @param {unknown} payload 計測したいデータです。
 */
function logPayloadSize(context, payload) {
    const bytes = estimateJsonBytes(payload);
    if (!bytes) {
        return;
    }
    if (bytes >= HOST_PAYLOAD_WARN_THRESHOLD_BYTES) {
        console.warn(`[WidevineProxy2] ${context} payload約${Math.round(bytes / 1024)}KB`);
    }
}

/**
 * @description JSON化時のおおよそのバイト数を返します。
 * @param {unknown} payload 測定対象データです。
 * @returns {number} バイト数です。
 */
function estimateJsonBytes(payload) {
    try {
        if (typeof payload === "string") {
            return payload.length;
        }
        return JSON.stringify(payload || "").length;
    } catch {
        return 0;
    }
}

/**
 * @description ジョブが keepalive 対象かを判定します。
 * @param {object} job 判定したいジョブです。
 * @returns {boolean} アクティブなら true。
 */
function isJobDraftActive(job) {
    if (!job) {
        return false;
    }
    const status = (job.status || job.stage || "").toString();
    return !isTerminalJobStatus(status);
}

/**
 * @description keepalive を維持すべきかどうかを返します。
 * @returns {boolean} 維持すべきなら true。
 */
function shouldMaintainKeepAlive() {
    return hasActiveNativeJobs;
}

/**
 * @description ジョブ状況に応じて keepalive リソースを起動/停止します。
 */
function refreshJobActivityState() {
    const cacheEntries = jobDraftCache ? Object.values(jobDraftCache) : [];
    const next = cacheEntries.some(isJobDraftActive);
    hasActiveNativeJobs = next;
    if (hasActiveNativeJobs) {
        scheduleKeepAlive();
        ensureOffscreenDocument("jobs-active").catch(() => {});
        nativeHostBridge.setConnectionDemand(true, { reason: "jobs-active" });
        return;
    }
    clearKeepAlive();
    nativeHostBridge.setConnectionDemand(false, { reason: "jobs-idle" });
    closeOffscreenDocumentIfIdle().catch(() => {});
}

async function rehydrateOverlayForPssh(pssh, options = {}) {
    if (!pssh) {
        return;
    }
    if (isOverlaySuppressed(pssh)) {
        return;
    }
    const cached = logs.find((entry) => entry.pssh_data === pssh);
    if (cached) {
        await maybeInjectDownloadOverlay(options.tabId, { ...cached, url: options.tabUrl || cached.url });
        return;
    }
    try {
        const stored = await AsyncLocalStorage.getStorage([pssh]);
        const revived = stored?.[pssh];
        if (revived) {
            await maybeInjectDownloadOverlay(options.tabId, {
                ...revived,
                url: options.tabUrl || revived.url,
                pageTitle: options.tabTitle || revived.pageTitle || null
            });
        }
    } catch (error) {
        console.debug("[WidevineProxy2] overlay rehydrate failed", error);
    }
}

/**
 * @description オーバーレイを対象タブへ注入し、最新の動画情報を通知します。
 * @param {number} tabId 対象タブIDです。
 * @param {object} log キー取得ログです。
 * @returns {Promise<void>} 注入完了時に解決します。
 */
async function maybeInjectDownloadOverlay(tabId, log) {
    if (!log) {
        return;
    }
    const enabled = await SettingsManager.getOverlayPreviewEnabled();
    if (!enabled) {
        console.debug("[WidevineProxy2] overlay preview disabled");
        return;
    }
    const resolution = await resolveOverlayTargetTab(tabId, log.url);
    if (!resolution?.tab || !resolution.tabId) {
        console.debug("[WidevineProxy2] overlay target tab not found", tabId, log.url);
        return;
    }
    const { tab, tabId: targetTabId } = resolution;
    rememberTabResolution(targetTabId, tab.url);
    if (tab.url.startsWith("chrome://") || tab.url.startsWith("edge://")) {
        return;
    }
    const manifestUrl = Array.isArray(log.manifests) && log.manifests[0]?.url ? log.manifests[0].url : null;
    const sourceUrl = log.url || tab.url;
    const bridgeReady = await ensureOverlayBridge(targetTabId);
    if (!bridgeReady) {
        updateOverlayLifecycle(targetTabId, {
            phase: "probing",
            lastInjectionFailureReason: "bridge-init",
            lastInjectionFailureAt: Date.now(),
            lastKnownUrl: tab.url
        });
        return;
    }
    upsertOverlayState(targetTabId, {
        lastLogKey: log.pssh_data || null,
        lastManifestUrl: manifestUrl,
        lastSourceUrl: sourceUrl,
        lastUpdateAt: Date.now()
    });
    updateOverlayLifecycle(targetTabId, {
        phase: "ready",
        lastInjectionAt: Date.now(),
        lastKnownUrl: tab.url,
        lastLogKey: log.pssh_data || null
    });
    const payload = {
        sourceUrl,
        manifestUrl,
        logKey: log.pssh_data || null
    };
    let delivered = await sendOverlayUpdateMessage(targetTabId, payload);
    if (!delivered) {
        const reinjected = await ensureOverlayBridge(targetTabId, true);
        if (reinjected) {
            delivered = await sendOverlayUpdateMessage(targetTabId, payload);
        }
        if (!delivered) {
            console.debug("[WidevineProxy2] overlay update failed after retry", targetTabId);
        }
    }
    if (!delivered) {
        updateOverlayLifecycle(targetTabId, {
            phase: "probing",
            lastInjectionFailureReason: "delivery-failed",
            lastInjectionFailureAt: Date.now()
        });
    }
}

/**
 * @description タブに紐づくオーバーレイライフサイクル状態を取得します。
 * @param {number} tabId 対象タブIDです。
 * @returns {object|null} 保存済み状態です。
 */
function getOverlayLifecycle(tabId) {
    if (typeof tabId !== "number") {
        return null;
    }
    return overlayLifecycleByTab.get(tabId) || null;
}

/**
 * @description タブに紐づくオーバーレイライフサイクル状態を更新します。
 * @param {number} tabId 対象タブIDです。
 * @param {object} patch 反映したい差分です。
 * @returns {void}
 */
function updateOverlayLifecycle(tabId, patch = {}) {
    if (typeof tabId !== "number") {
        return;
    }
    const current = overlayLifecycleByTab.get(tabId) || {};
    overlayLifecycleByTab.set(tabId, { ...current, ...patch });
}

/**
 * @description タブのオーバーレイライフサイクル状態を破棄します。
 * @param {number} tabId 対象タブIDです。
 * @returns {void}
 */
function clearOverlayLifecycle(tabId) {
    if (typeof tabId !== "number") {
        return;
    }
    overlayLifecycleByTab.delete(tabId);
}

/**
 * @description フォールバック生成をブロックすべきホストかを判定します。
 * @param {string|null} url 判定対象の URL です。
 * @returns {boolean} ブロック対象であれば true。
 */
function isOverlayMetadataBlockedHost(url) {
    if (!url) {
        return false;
    }
    try {
        const { hostname } = new URL(url);
        if (!hostname) {
            return false;
        }
        const lower = hostname.toLowerCase();
        if (OVERLAY_METADATA_BLOCKLIST_HOSTS.has(lower)) {
            return true;
        }
        const baseHost = lower.replace(/^www\./, "");
        if (OVERLAY_METADATA_BLOCKLIST_HOSTS.has(baseHost)) {
            return true;
        }
    } catch {
        return false;
    }
    return false;
}

/**
 * @description ナビゲーション検知時にオーバーレイ状態をリセットします。
 * @param {number} tabId 対象タブIDです。
 * @param {{reason?: string, url?: string|null, navigationEvent?: string|null, phase?: string, force?: boolean}} meta 付随情報です。
 * @returns {Promise<void>} 完了時に解決します。
 */
async function resetOverlayForNavigation(tabId, meta = {}) {
    if (typeof tabId !== "number") {
        return;
    }
    const now = Date.now();
    const reason = meta.reason || "page-navigation";
    const lifecycle = getOverlayLifecycle(tabId) || {};
    if (!meta.force && lifecycle.lastResetAt && (now - lifecycle.lastResetAt) < OVERLAY_RESET_THROTTLE_MS) {
        updateOverlayLifecycle(tabId, {
            lastResetReason: reason,
            lastKnownUrl: meta.url || lifecycle.lastKnownUrl || null,
            navigationEvent: meta.navigationEvent || lifecycle.navigationEvent || null
        });
        return;
    }
    if (overlayStateByTab.has(tabId)) {
        await destroyOverlayForTab(tabId, reason);
    }
    updateOverlayLifecycle(tabId, {
        phase: meta.phase || "resetting",
        lastResetReason: reason,
        lastResetAt: now,
        lastKnownUrl: meta.url || lifecycle.lastKnownUrl || null,
        navigationEvent: meta.navigationEvent || null
    });
}

/**
 * @description オーバーレイを破棄し、状態管理から除外します。
 * @param {number} tabId 対象タブIDです。
 * @param {string} reason 除去理由です。
 * @returns {Promise<void>} 削除完了時に解決します。
 */
async function destroyOverlayForTab(tabId, reason = "cleanup") {
    if (!overlayStateByTab.has(tabId)) {
        return;
    }
    overlayStateByTab.delete(tabId);
    await chrome.tabs.sendMessage(tabId, {
        type: "WVP_OVERLAY_DESTROY",
        reason
    }).catch(() => {
        // タブが閉じている場合などは無視する
    });
}

/**
 * @description タブごとのオーバーレイ状態をマージ更新します。
 * @param {number} tabId 対象タブIDです。
 * @param {object} patch 反映したい差分です。
 */
function upsertOverlayState(tabId, patch = {}) {
    if (typeof tabId !== "number") {
        return;
    }
    const current = overlayStateByTab.get(tabId) || {};
    const next = { ...current, ...patch };
    if (!next.injectedAt) {
        next.injectedAt = Date.now();
    }
    overlayStateByTab.set(tabId, next);
}

async function ensureOverlayBridge(tabId, force = false) {
    if (typeof tabId !== "number") {
        return false;
    }
    if (!force && overlayStateByTab.has(tabId)) {
        return true;
    }
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["overlay/overlay.js"],
            world: "ISOLATED"
        });
        upsertOverlayState(tabId, { injectedAt: Date.now() });
        return true;
    } catch (error) {
        overlayStateByTab.delete(tabId);
        console.warn("[WidevineProxy2] overlay script注入に失敗", error);
        return false;
    }
}

async function sendOverlayUpdateMessage(tabId, payload) {
    try {
        await chrome.tabs.sendMessage(tabId, {
            type: "WVP_OVERLAY_UPDATE",
            payload
        });
        return true;
    } catch (error) {
        if (isMissingOverlayReceiverError(error)) {
            overlayStateByTab.delete(tabId);
        }
        console.debug("[WidevineProxy2] overlay update failed", error);
        return false;
    }
}

/**
 * @description 現在オーバーレイが有効な全タブへ同一メッセージを配信します。
 * @param {object} message コンテンツスクリプトへ送るメッセージです。
 * @returns {Promise<void>} 送信完了時に解決します。
 */
async function multicastOverlayMessage(message) {
    const tabIds = Array.from(overlayStateByTab.keys());
    if (tabIds.length === 0) {
        return;
    }
    await Promise.all(tabIds.map(async (tabId) => {
        try {
            await chrome.tabs.sendMessage(tabId, message);
        } catch (error) {
            if (isMissingOverlayReceiverError(error)) {
                overlayStateByTab.delete(tabId);
                return;
            }
            console.debug("[WidevineProxy2] overlay multicast failed", error);
        }
    }));
}

/**
 * @description HOST_NATIVE_EVENT を適切なタブへ配信し、必要に応じてフォールバックします。
 * @param {{type:string,payload:object}} message 送信メッセージです。
 */
async function deliverHostNativeEvent(message) {
    const targetTabIds = await resolveHostEventTabTargets(message?.payload);
    if (targetTabIds.length === 0) {
        await multicastOverlayMessage(message);
        return;
    }
    const results = await Promise.all(targetTabIds.map((tabId) => sendTargetedOverlayMessage(tabId, message)));
    if (!results.some(Boolean)) {
        await multicastOverlayMessage(message);
    }
}

/**
 * @description イベントからトースト表示対象のタブIDを推測します。
 * @param {object} payload HOST_NATIVE_EVENT のペイロードです。
 * @returns {Promise<Array<number>>} タブID一覧です。
 */
async function resolveHostEventTabTargets(payload = {}) {
    const targets = new Set();
    if (typeof payload?.tabId === "number") {
        targets.add(payload.tabId);
    }
    if (payload?.clientJobId) {
        const cachedTabId = jobDraftCache?.[payload.clientJobId]?.tabId;
        if (typeof cachedTabId === "number") {
            targets.add(cachedTabId);
        } else {
            const mapped = await getJobTabTarget(payload.clientJobId);
            if (typeof mapped === "number") {
                targets.add(mapped);
            }
        }
    }
    return Array.from(targets);
}

/**
 * @description 指定タブへメッセージを送信します。
 * @param {number} tabId 対象タブIDです。
 * @param {object} message 送信メッセージです。
 * @returns {Promise<boolean>} 成功時は true。
 */
async function sendTargetedOverlayMessage(tabId, message) {
    try {
        await chrome.tabs.sendMessage(tabId, message);
        return true;
    } catch (error) {
        if (isMissingOverlayReceiverError(error)) {
            overlayStateByTab.delete(tabId);
            forgetJobTabTargetsForTab(tabId).catch(() => {});
            return false;
        }
        console.debug("[WidevineProxy2] overlay targeted send failed", error);
        return false;
    }
}

/**
 * @description オーバーレイへページURLヒントを通知し、UI更新を促します。
 * @param {number} tabId 対象タブIDです。
 * @param {string} pageUrl 現在のページURLです。
 * @param {{reason?: string, transitionType?: string|null}} meta 付随情報です。
 * @returns {Promise<void>} 完了時に解決します。
 */
async function emitOverlayLocationHint(tabId, pageUrl, meta = {}) {
    if (typeof tabId !== "number" || !pageUrl) {
        return;
    }
    await sendTargetedOverlayMessage(tabId, {
        type: "WVP_OVERLAY_LOCATION_HINT",
        payload: {
            pageUrl,
            reason: meta.reason || "navigation",
            transitionType: meta.transitionType || null,
            hintedAt: Date.now()
        }
    });
}

/**
 * @description webNavigationイベントをもとにSPA遷移時のURL変化を追跡します。
 * @param {chrome.webNavigation.WebNavigationTransitionCallbackDetails} details イベント詳細です。
 * @param {string} reason 呼び出し理由です。
 * @returns {Promise<void>} 処理完了時に解決します。
 */
async function handleTabNavigationMutation(details, reason) {
    if (!details || details.frameId !== 0) {
        return;
    }
    const tabId = details.tabId;
    const pageUrl = details.url || null;
    if (!pageUrl) {
        return;
    }
    await resetOverlayForNavigation(tabId, {
        url: pageUrl,
        navigationEvent: `webNavigation:${reason}`,
        reason: `webNavigation-${reason}`
    });
    const state = overlayStateByTab.get(tabId) || {};
    if (state.lastKnownTabUrl === pageUrl) {
        return;
    }
    rememberTabResolution(tabId, pageUrl);
    const previousMetadata = getTabPageMetadata(tabId);
    let effectiveTitle = previousMetadata?.title || null;
    const probedTitle = await probeDocumentTitle(tabId);
    if (probedTitle) {
        effectiveTitle = probedTitle;
    }
    rememberTabPageMetadata(tabId, {
        url: pageUrl,
        title: effectiveTitle
    });
    if (overlayStateByTab.has(tabId)) {
        upsertOverlayState(tabId, {
            lastKnownTabUrl: pageUrl,
            lastNavigationReason: reason,
            lastNavigationAt: Date.now()
        });
        await emitOverlayLocationHint(tabId, pageUrl, {
            reason,
            transitionType: details.transitionType || null
        });
    }
}

function isMissingOverlayReceiverError(error) {
    return isExpectedRuntimePortError(error);
}

/**
 * @description BFCache 由来のポート切断メッセージかどうかを判定します。
 * @param {string} message 判定対象の文字列です。
 * @returns {boolean} BFCache により切断された場合は true。
 */
function isBfCacheDisconnectMessage(message) {
    if (!message) {
        return false;
    }
    return BF_CACHE_ERROR_REGEX.test(message);
}

/**
 * @description runtime 由来の既知エラーメッセージかどうかを判定する際の文字列を抽出します。
 * @param {unknown} error 判定対象のエラーです。
 * @returns {string} エラーメッセージ文字列です。
 */
function extractErrorMessage(error) {
    if (!error) {
        return "";
    }
    return typeof error === "string" ? error : error.message || "";
}

/**
 * @description 受信側不在や BFCache 切断といった想定内の runtime エラーかを判定します。
 * @param {unknown} error 判定対象です。
 * @returns {boolean} 想定内であれば true。
 */
function isExpectedRuntimePortError(error) {
    const message = extractErrorMessage(error);
    if (!message) {
        return false;
    }
    return RECEIVING_END_ERROR_REGEX.test(message) || isBfCacheDisconnectMessage(message);
}

/**
 * @description オーバーレイから届いたDLキュー要求を処理します。
 * @param {object} message コンテンツ側から届いたメッセージです。
 * @param {chrome.runtime.MessageSender} sender 発信元情報です。
 * @returns {Promise<{ok: boolean, message: string}>} レスポンス情報です。
 */
async function handleOverlayQueueDownload(message, sender) {
    const log = await loadCapturedLogByKey(message?.logKey);
    suppressOverlayForLog(log?.pssh_data || null);
    const tabId = sender?.tab?.id ?? null;
    const { clientJobId } = await enqueueNativeJob(log, { tabId });
    if (typeof tabId === "number") {
        upsertOverlayState(tabId, { lastQueuedLogKey: log?.pssh_data || null, lastQueuedAt: Date.now() });
        if (clientJobId) {
            await rememberJobTabTarget(clientJobId, tabId);
        }
        rememberTabResolution(tabId, log?.url || null);
    }
    broadcastDownloadStart({
        clientJobId,
        sourceUrl: log?.url,
        mpdUrl: log?.manifests?.[0]?.url,
        tabId: typeof tabId === "number" ? tabId : null
    });
    return { ok: true, message: "ジョブをキューに追加しました", clientJobId };
}

/**
 * @description パネルからのキュー要求を処理します。
 * @param {{logKey?: string, pssh?: string}} message 送信元メッセージです。
 * @returns {Promise<{ok: boolean, clientJobId: string|null}>} 処理結果を返します。
 */
async function handlePanelQueueDownload(message) {
    const logKey = message?.logKey || message?.pssh;
    const log = await loadCapturedLogByKey(logKey);
    suppressOverlayForLog(log?.pssh_data || null);
    const { clientJobId } = await enqueueNativeJob(log);
    broadcastDownloadStart({ clientJobId, sourceUrl: log?.url, mpdUrl: log?.manifests?.[0]?.url, tabId: null });
    return { ok: true, clientJobId: clientJobId || null };
}

/**
 * @description ストレージからDLログを読み込みます。
 * @param {string|null|undefined} logKey 取得するログキーです。
 * @returns {Promise<object>} 保存済みログです。
 */
async function loadCapturedLogByKey(logKey) {
    if (!logKey) {
        throw new Error("logKey がありません");
    }
    const snapshot = await AsyncLocalStorage.getStorage([logKey]);
    const log = snapshot[logKey];
    if (!log) {
        throw new Error("指定されたDLログが見つかりません");
    }
    return log;
}

/**
 * @description オーバーレイ挿入対象のタブをIDまたはURLから解決します。
 * @param {number|null} tabId 既知のタブIDです。
 * @param {string|null} tabUrl キー取得源のURLです。
 * @returns {Promise<{tab: chrome.tabs.Tab|null, tabId: number|null}>} 解決結果です。
 */
async function resolveOverlayTargetTab(tabId, tabUrl) {
    let tab = null;
    if (tabId) {
        tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab) {
            return { tab, tabId };
        }
    }
    if (!tabUrl) {
        return { tab: null, tabId: null };
    }
    const cachedTabId = resolveTabIdFromCache(tabUrl);
    if (typeof cachedTabId === "number") {
        tab = await chrome.tabs.get(cachedTabId).catch(() => null);
        if (tab) {
            return { tab, tabId: tab.id };
        }
        forgetTabResolutionForTab(cachedTabId);
    }
    const candidates = await chrome.tabs.query({});
    tab = candidates.find((candidate) => candidate.url === tabUrl) || null;
    if (!tab) {
        try {
            const origin = new URL(tabUrl).origin;
            tab = candidates.find((candidate) => candidate.url && candidate.url.startsWith(origin)) || null;
        } catch {
            // 無視
        }
    }
    if (tab) {
        rememberTabResolution(tab.id, tab.url);
    }
    return { tab, tabId: tab?.id ?? null };
}

chrome.webRequest.onBeforeSendHeaders.addListener(
    function(details) {
        if (details.method === "GET") {
            const headers = details.requestHeaders
                .filter(item => !(
                    item.name.startsWith('sec-ch-ua') ||
                    item.name.startsWith('Sec-Fetch') ||
                    item.name.startsWith('Accept-') ||
                    item.name.startsWith('Host') ||
                    item.name === "Connection"
                )).reduce((acc, item) => {
                    acc[item.name] = item.value;
                    return acc;
                }, {});
            rememberRequestHeaders(details.url, headers);
        }
    },
    {urls: ["<all_urls>"]},
    ['requestHeaders', chrome.webRequest.OnSendHeadersOptions.EXTRA_HEADERS].filter(Boolean)
);

async function parseClearKey(body, tabUrlHint, tabId = null, tabTitle = null) {
    const tabContext = await resolveLatestTabContext(tabId, { url: tabUrlHint, title: tabTitle });
    const tabUrl = tabContext.url || tabUrlHint || null;
    const effectiveTitle = tabContext.title || tabTitle || null;
    const clearkey = JSON.parse(atob(body));

    const formatted_keys = clearkey["keys"].map(key => ({
        ...key,
        kid: uint8ArrayToHex(base64toUint8Array(key.kid.replace(/-/g, "+").replace(/_/g, "/") + "==")),
        k: uint8ArrayToHex(base64toUint8Array(key.k.replace(/-/g, "+").replace(/_/g, "/") + "=="))
    }));
    const pssh_data = btoa(JSON.stringify({kids: clearkey["keys"].map(key => key.k)}));

    if (logs.some((log) => log.pssh_data === pssh_data)) {
        console.log("[WidevineProxy2]", `KEYS_ALREADY_RETRIEVED: ${pssh_data}`);
        await rehydrateOverlayForPssh(pssh_data, { tabId, tabUrl, tabTitle: effectiveTitle });
        return;
    }

    console.log("[WidevineProxy2]", "CLEARKEY KEYS", formatted_keys, tabUrl);
    const log = {
        type: "CLEARKEY",
        pssh_data: pssh_data,
        keys: formatted_keys,
        url: tabUrl,
        timestamp: Math.floor(Date.now() / 1000),
        manifests: getTabManifestHistory(tabUrl) || [],
        pageTitle: effectiveTitle || null
    }
    await persistCapturedKeyLog(log, { tabId, tabTitle: effectiveTitle });
}

async function generateChallenge(body) {
    const signed_message =  SignedMessage.decode(base64toUint8Array(body));
    const license_request = LicenseRequest.decode(signed_message.msg);
    const pssh_data = license_request.contentId.widevinePsshData.psshData[0];

    if (!pssh_data) {
        console.log("[WidevineProxy2]", "NO_PSSH_DATA_IN_CHALLENGE");
        return body;
    }

    if (logs.some((log) => log.pssh_data === Session.psshDataToPsshBoxB64(pssh_data))) {
        const existing = Session.psshDataToPsshBoxB64(pssh_data);
        console.log("[WidevineProxy2]", `KEYS_ALREADY_RETRIEVED: ${uint8ArrayToBase64(pssh_data)}`);
        await rehydrateOverlayForPssh(existing, { tabId, tabUrl: null, tabTitle: null });
        return body;
    }

    const selected_device_name = await DeviceManager.getSelectedWidevineDevice();
    if (!selected_device_name) {
        return body;
    }

    const device_b64 = await DeviceManager.loadWidevineDevice(selected_device_name);
    const widevine_device = new WidevineDevice(base64toUint8Array(device_b64).buffer);

    const private_key = `-----BEGIN RSA PRIVATE KEY-----${uint8ArrayToBase64(widevine_device.private_key)}-----END RSA PRIVATE KEY-----`;
    const session = new Session(
        {
            privateKey: private_key,
            identifierBlob: widevine_device.client_id_bytes
        },
        pssh_data
    );

    const [challenge, request_id] = session.createLicenseRequest(LicenseType.STREAMING, widevine_device.type === 2);
    sessions.set(uint8ArrayToBase64(request_id), session);

    return uint8ArrayToBase64(challenge);
}

async function parseLicense(body, tabUrlHint, tabId = null, tabTitle = null) {
    const tabContext = await resolveLatestTabContext(tabId, { url: tabUrlHint, title: tabTitle });
    const tabUrl = tabContext.url || tabUrlHint || null;
    const effectiveTitle = tabContext.title || tabTitle || null;
    const license = base64toUint8Array(body);
    const signed_license_message = SignedMessage.decode(license);

    if (signed_license_message.type !== SignedMessage.MessageType.LICENSE) {
        console.log("[WidevineProxy2]", "INVALID_MESSAGE_TYPE", signed_license_message.type.toString());
        return null;
    }

    const license_obj = License.decode(signed_license_message.msg);
    const loaded_request_id = uint8ArrayToBase64(license_obj.id.requestId);

    if (!sessions.has(loaded_request_id)) {
        return null;
    }

    const loadedSession = sessions.get(loaded_request_id);
    const keys = await loadedSession.parseLicense(license);
    const pssh = loadedSession.getPSSH();

    console.log("[WidevineProxy2]", "KEYS", JSON.stringify(keys), tabUrl);
    const log = {
        type: "WIDEVINE",
        pssh_data: pssh,
        keys: keys,
        url: tabUrl,
        timestamp: Math.floor(Date.now() / 1000),
        manifests: getTabManifestHistory(tabUrl) || [],
        pageTitle: effectiveTitle || null
    }
    await persistCapturedKeyLog(log, { tabId, tabTitle: effectiveTitle });

    sessions.delete(loaded_request_id);
    return null;
}

async function generateChallengeRemote(body) {
    const signed_message =  SignedMessage.decode(base64toUint8Array(body));
    const license_request = LicenseRequest.decode(signed_message.msg);
    const pssh_data = license_request.contentId.widevinePsshData.psshData[0];

    if (!pssh_data) {
        console.log("[WidevineProxy2]", "NO_PSSH_DATA_IN_CHALLENGE");
        return body;
    }

    const pssh = Session.psshDataToPsshBoxB64(pssh_data);

    if (logs.some((log) => log.pssh_data === pssh)) {
        console.log("[WidevineProxy2]", `KEYS_ALREADY_RETRIEVED: ${uint8ArrayToBase64(pssh_data)}`);
        await rehydrateOverlayForPssh(pssh, { tabId: null, tabUrl: null, tabTitle: null });
        return body;
    }

    const selected_remote_cdm_name = await RemoteCDMManager.getSelectedRemoteCDM();
    if (!selected_remote_cdm_name) {
        return body;
    }

    const selected_remote_cdm = JSON.parse(await RemoteCDMManager.loadRemoteCDM(selected_remote_cdm_name));
    const remote_cdm = RemoteCdm.from_object(selected_remote_cdm);

    const session_id = await remote_cdm.open();
    const challenge_b64 = await remote_cdm.get_license_challenge(session_id, pssh, true);

    const signed_challenge_message = SignedMessage.decode(base64toUint8Array(challenge_b64));
    const challenge_message = LicenseRequest.decode(signed_challenge_message.msg);

    sessions.set(uint8ArrayToBase64(challenge_message.contentId.widevinePsshData.requestId), {
        id: session_id,
        pssh: pssh
    });
    return challenge_b64;
}

async function parseLicenseRemote(body, tabUrlHint, tabId = null, tabTitle = null) {
    const tabContext = await resolveLatestTabContext(tabId, { url: tabUrlHint, title: tabTitle });
    const tabUrl = tabContext.url || tabUrlHint || null;
    const effectiveTitle = tabContext.title || tabTitle || null;
    const license = base64toUint8Array(body);
    const signed_license_message = SignedMessage.decode(license);

    if (signed_license_message.type !== SignedMessage.MessageType.LICENSE) {
        console.log("[WidevineProxy2]", "INVALID_MESSAGE_TYPE", signed_license_message.type.toString());
        return null;
    }

    const license_obj = License.decode(signed_license_message.msg);
    const loaded_request_id = uint8ArrayToBase64(license_obj.id.requestId);

    if (!sessions.has(loaded_request_id)) {
        return null;
    }

    const session_id = sessions.get(loaded_request_id);

    const selected_remote_cdm_name = await RemoteCDMManager.getSelectedRemoteCDM();
    if (!selected_remote_cdm_name) {
        sendResponse();
        return;
    }

    const selected_remote_cdm = JSON.parse(await RemoteCDMManager.loadRemoteCDM(selected_remote_cdm_name));
    const remote_cdm = RemoteCdm.from_object(selected_remote_cdm);

    await remote_cdm.parse_license(session_id.id, body);
    const returned_keys = await remote_cdm.get_keys(session_id.id, "CONTENT");
    await remote_cdm.close(session_id.id);

    if (returned_keys.length === 0) {
        sendResponse();
        return;
    }

    const keys = returned_keys.map(({ key, key_id }) => ({ k: key, kid: key_id }));

    console.log("[WidevineProxy2]", "KEYS", JSON.stringify(keys), tabUrl);
    const log = {
        type: "WIDEVINE",
        pssh_data: session_id.pssh,
        keys: keys,
        url: tabUrl,
        timestamp: Math.floor(Date.now() / 1000),
        manifests: getTabManifestHistory(tabUrl) || [],
        pageTitle: effectiveTitle || null
    }
    await persistCapturedKeyLog(log, { tabId, tabTitle: effectiveTitle });

    sessions.delete(loaded_request_id);
    return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleExtensionMessage(message, sender)
        .then((result) => {
            sendResponse(result);
        })
        .catch((error) => {
            console.error("runtime.onMessage error", error);
            sendResponse();
        });
    return true;
});

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "wvp-message-proxy") {
        return;
    }
    bootstrapNativeHostPort("runtime.onConnect");
    const portTab = port.sender?.tab || null;
    let portDisconnected = false;
    let lastDisconnectReason = "";
    port.onDisconnect.addListener(() => {
        portDisconnected = true;
        lastDisconnectReason = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
        if (isBfCacheDisconnectMessage(lastDisconnectReason)) {
            console.debug("[WidevineProxy2] runtime port detached (BFCache)", {
                tabId: portTab?.id ?? null,
                url: portTab?.url || null
            });
        } else if (lastDisconnectReason) {
            console.warn("[WidevineProxy2] runtime port disconnected", lastDisconnectReason);
        }
    });
    /**
     * @description ポート切断時にも落ちないよう、安全にレスポンスを返します。
     * @param {object} payload 応答メッセージです。
     */
    function safePortReply(payload) {
        if (portDisconnected) {
            return;
        }
        try {
            port.postMessage(payload);
        } catch (error) {
            if (isExpectedRuntimePortError(error)) {
                return;
            }
            console.warn("[WidevineProxy2] ポート返信に失敗", error);
        }
    }
    port.onMessage.addListener((message) => {
        const sender = {
            tab: {
                url: message?.tabUrl || portTab?.url || null,
                id: portTab?.id ?? null
            }
        };
        handleExtensionMessage(message, sender)
            .then((result) => {
                safePortReply({
                    requestId: message.requestId,
                    payload: result ?? ""
                });
            })
            .catch((error) => {
                safePortReply({
                    requestId: message.requestId,
                    error: error?.message || String(error)
                });
            });
    });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local") {
        if (Object.prototype.hasOwnProperty.call(changes, "overlay_preview_enabled")) {
            const newValue = Boolean(changes.overlay_preview_enabled.newValue);
            if (!newValue) {
                for (const tabId of Array.from(overlayStateByTab.keys())) {
                    destroyOverlayForTab(tabId, "feature-disabled")
                        .then(() => {
                            updateOverlayLifecycle(tabId, {
                                phase: "idle",
                                lastResetReason: "feature-disabled",
                                lastResetAt: Date.now()
                            });
                        })
                        .catch(() => void 0);
                }
            }
        }
        return;
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    overlayStateByTab.delete(tabId);
    forgetJobTabTargetsForTab(tabId).catch(() => {});
    forgetTabResolutionForTab(tabId);
    clearOverlayLifecycle(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo || changeInfo.status !== "loading") {
        return;
    }
    resetOverlayForNavigation(tabId, {
        url: changeInfo.url || tab?.url || null,
        navigationEvent: "tabs.onUpdated",
        reason: "tab-loading"
    }).catch(() => {});
});

if (chrome?.webNavigation?.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
        handleTabNavigationMutation(details, "history-state").catch((error) => {
            console.debug("[WidevineProxy2] history-state observer failed", error);
        });
    }, WEB_NAVIGATION_FILTER);
}

if (chrome?.webNavigation?.onCommitted) {
    chrome.webNavigation.onCommitted.addListener((details) => {
        handleTabNavigationMutation(details, "committed").catch((error) => {
            console.debug("[WidevineProxy2] committed observer failed", error);
        });
    }, WEB_NAVIGATION_FILTER);
}

async function handleExtensionMessage(message, sender) {
    if (!message || !message.type) {
        return null;
    }
    if (message?.body) {
        logPayloadSize(`sw-inbound:${message.type}`, message.body);
    }
    const tab_url = sender?.tab?.url || message?.tabUrl || null;
    const tabId = sender?.tab?.id ?? null;
    const tabTitle = sender?.tab?.title || message?.tabTitle || null;

    switch (message.type) {
        case "REQUEST": {
            if (!await SettingsManager.getEnabled()) {
                return message.body;
            }
            try {
                JSON.parse(atob(message.body));
                return message.body;
            } catch {
                if (message.body) {
                    const device_type = await SettingsManager.getSelectedDeviceType();
                    switch (device_type) {
                        case "WVD":
                            return await generateChallenge(message.body);
                        case "REMOTE":
                            return await generateChallengeRemote(message.body);
                    }
                }
            }
            return message.body;
        }
        case "RESPONSE": {
            if (!await SettingsManager.getEnabled()) {
                return message.body;
            }
            try {
                await parseClearKey(message.body, tab_url, tabId, tabTitle);
                return null;
            } catch (e) {
                const device_type = await SettingsManager.getSelectedDeviceType();
                switch (device_type) {
                    case "WVD":
                        return await parseLicense(message.body, tab_url, tabId, tabTitle);
                    case "REMOTE":
                        return await parseLicenseRemote(message.body, tab_url, tabId, tabTitle);
                }
                return null;
            }
        }
        case "GET_LOGS":
            return logs;
        case "OPEN_PICKER_WVD":
            chrome.windows.create({
                url: 'picker/wvd/filePicker.html',
                type: 'popup',
                width: 300,
                height: 200,
            });
            return null;
        case "OPEN_PICKER_REMOTE":
            chrome.windows.create({
                url: 'picker/remote/filePicker.html',
                type: 'popup',
                width: 300,
                height: 200,
            });
            return null;
        case "CLEAR":
            logs = [];
            manifests.clear();
            tabManifestTimestamps.clear();
            return null;
        case "MANIFEST": {
            const parsed = JSON.parse(message.body);
            const headers = sanitizeHeaders(getCachedRequestHeaders(parsed.url));
            const element = {
                type: parsed.type,
                url: parsed.url,
                headers,
                size: parsed.size ?? null,
                details: parsed.details || null
            };
            const tabContext = await resolveLatestTabContext(tabId, { url: tab_url, title: tabTitle });
            rememberManifest(tabContext.url, element);
            return null;
        }
        case "PAGE_NAVIGATION": {
            let payload = {};
            try {
                payload = JSON.parse(message.body || "{}");
            } catch (error) {
                console.debug("[WidevineProxy2] invalid PAGE_NAVIGATION payload", error);
            }
            return handleOverlayNavigationSignal(payload, sender);
        }
        case "PAGE_METADATA": {
            let payload = {};
            try {
                payload = JSON.parse(message.body || "{}");
            } catch (error) {
                console.debug("[WidevineProxy2] invalid PAGE_METADATA payload", error);
            }
            return handleGenericPageMetadata(payload, sender);
        }
        case "HOST_STATUS_QUERY":
            try {
                await nativeHostBridge.ensureConnected({ force: true });
                if (!hasActiveNativeJobs) {
                    nativeHostBridge.scheduleDeferredIdleRelease("status-query", 4000);
                }
            } catch (error) {
                console.warn("[NativeHostBridge] status query connect failed", error);
            }
            return nativeHostBridge.getStatus();
        case "HOST_RECONNECT":
            await nativeHostBridge.retryConnection("panel", {
                holdForMs: hasActiveNativeJobs ? 0 : 5000
            });
            return nativeHostBridge.getStatus();
        case "HOST_REVEAL_OUTPUT": {
            const targetPath = sanitizeRevealPathInput(message?.outputPath);
            if (!targetPath) {
                throw new Error("outputPath がありません");
            }
            await requestNativeFolderReveal(targetPath);
            return { ok: true };
        }
        case "OFFSCREEN_SHUTDOWN":
            return { ok: true };
        case "HOST_JOB_RETRY": {
            const jobKey = message?.clientJobId;
            if (!jobKey) {
                throw new Error("clientJobId がありません");
            }
            const payload = await getJobPayload(jobKey);
            if (!payload) {
                throw new Error("再送可能なペイロードが見つかりません");
            }
            await upsertNativeJobDraft(jobKey, {
                status: "pending",
                stage: "pending",
                detail: "再送中",
                updatedAt: Date.now()
            });
            nativeHostBridge.setConnectionDemand(true, { reason: "host-job-retry" });
            await nativeHostBridge.sendMessage(payload);
            return { ok: true };
        }
        case "HOST_JOB_DELETE": {
            const jobKey = message?.clientJobId;
            if (!jobKey) {
                throw new Error("clientJobId がありません");
            }
            await deleteNativeJobDraft(jobKey);
            await dropJobPayload(jobKey);
            return { ok: true };
        }
        case "HOST_JOB_ABORT": {
            const jobKey = message?.clientJobId;
            if (!jobKey) {
                throw new Error("clientJobId がありません");
            }
            const abortPayload = {
                kind: "abort",
                clientJobId: jobKey
            };
            if (message?.hostJobId) {
                abortPayload.jobId = message.hostJobId;
            }
            await upsertNativeJobDraft(jobKey, {
                status: "cancelling",
                stage: "cancelling",
                detail: "キャンセル要求を送信しています",
                updatedAt: Date.now()
            });
            await nativeHostBridge.sendMessage(abortPayload);
            return { ok: true };
        }
        case "OFFSCREEN_KEEPALIVE_TICK":
            ensureOffscreenDocument("offscreen-tick").catch((error) => {
                console.debug("[WidevineProxy2] Offscreen keepalive failed", error);
            });
            await nativeHostBridge.ensureConnected();
            return nativeHostBridge.getStatus();
        case "OVERLAY_QUEUE_DOWNLOAD":
            return handleOverlayQueueDownload(message, sender);
        case "OVERLAY_DISMISSED":
            if (tabId) {
                upsertOverlayState(tabId, { lastDismissedAt: Date.now(), lastDismissedReason: message?.reason || null });
            }
            return { ok: true };
        case "QUEUE_LOG_DOWNLOAD":
            return handlePanelQueueDownload(message);
        default:
            return null;
    }
}

/**
 * @description タブとオリジンごとの最新マニフェストを記憶します。
 * @param {string|null} tabUrl 発生元タブのURLです。
 * @param {{url?: string}} manifest 解析済みマニフェスト情報です。
 */
function rememberManifest(tabUrl, manifest) {
    if (!manifest?.url) {
        return;
    }
    try {
        pruneExpiredTabManifestCache();
        const origin = new URL(manifest.url).origin;
        const history = manifestHistoryByOrigin.get(origin) || [];
        history.unshift({ ...manifest, tabUrl, seenAt: Date.now() });
        manifestHistoryByOrigin.set(origin, history.slice(0, 5));
        if (tabUrl) {
            const existing = getTabManifestHistory(tabUrl) || [];
            const deduped = existing.filter((item) => item?.url !== manifest.url);
            deduped.unshift({ ...manifest, recordedAt: Date.now() });
            setTabManifestHistory(tabUrl, deduped.slice(0, 5));
        }
    } catch (error) {
        console.debug("[WidevineProxy2] failed to record manifest history", error);
    }
}

/**
 * @description タブURLに紐づくマニフェスト履歴を取得し、期限切れの要素を除去します。
 * @param {string|null} tabUrl 対象タブのURLです。
 * @returns {Array<object>|null} 有効なマニフェスト配列です。
 */
function getTabManifestHistory(tabUrl) {
    if (!tabUrl || !manifests.has(tabUrl)) {
        return null;
    }
    const now = Date.now();
    const touchedAt = tabManifestTimestamps.get(tabUrl) ?? 0;
    if (now - touchedAt > TAB_MANIFEST_CACHE_TTL_MS) {
        manifests.delete(tabUrl);
        tabManifestTimestamps.delete(tabUrl);
        return null;
    }
    const cached = manifests.get(tabUrl) || [];
    const filtered = cached.filter((entry) => {
        const recordedAt = entry?.recordedAt ?? touchedAt;
        return now - recordedAt <= TAB_MANIFEST_CACHE_TTL_MS;
    });
    if (filtered.length === 0) {
        manifests.delete(tabUrl);
        tabManifestTimestamps.delete(tabUrl);
        return null;
    }
    if (filtered.length !== cached.length) {
        manifests.set(tabUrl, filtered);
        tabManifestTimestamps.set(tabUrl, filtered[0]?.recordedAt ?? now);
    }
    return filtered;
}

/**
 * @description タブごとのマニフェスト履歴を登録し、LRU制御を行います。
 * @param {string|null} tabUrl ひも付け対象のタブURLです。
 * @param {Array<object>} history 保存する履歴配列です。
 */
function setTabManifestHistory(tabUrl, history) {
    if (!tabUrl) {
        return;
    }
    if (!Array.isArray(history) || history.length === 0) {
        manifests.delete(tabUrl);
        tabManifestTimestamps.delete(tabUrl);
        return;
    }
    manifests.set(tabUrl, history);
    tabManifestTimestamps.set(tabUrl, history[0]?.recordedAt ?? Date.now());
    enforceTabManifestLimit();
}

/**
 * @description タブ別マニフェストキャッシュが上限を越えた場合に古いものから削除します。
 */
function enforceTabManifestLimit() {
    if (manifests.size <= TAB_MANIFEST_CACHE_LIMIT) {
        return;
    }
    const entries = Array.from(tabManifestTimestamps.entries())
        .sort(([, a], [, b]) => (a ?? 0) - (b ?? 0));
    const overflow = Math.max(0, manifests.size - TAB_MANIFEST_CACHE_LIMIT);
    for (let i = 0; i < overflow; i++) {
        const [key] = entries[i] || [];
        if (key) {
            manifests.delete(key);
            tabManifestTimestamps.delete(key);
        }
    }
}

/**
 * @description TTL を過ぎたタブ別マニフェストキャッシュを一括で掃除します。
 */
function pruneExpiredTabManifestCache() {
    const now = Date.now();
    for (const [key, touchedAt] of tabManifestTimestamps.entries()) {
        if (now - (touchedAt ?? 0) > TAB_MANIFEST_CACHE_TTL_MS) {
            tabManifestTimestamps.delete(key);
            manifests.delete(key);
        }
    }
}

/**
 * @description PSSH とオリジンをキーにしたマニフェスト履歴を保存します。
 * @param {{pssh_data?: string, url?: string, manifests?: Array<object>}} log 紐づけ対象のログです。
 */
function rememberManifestForLog(log) {
    if (!log?.pssh_data) {
        return;
    }
    const candidates = Array.isArray(log.manifests) ? log.manifests.filter(Boolean) : [];
    if (candidates.length === 0) {
        return;
    }
    try {
        const origin = log.url ? new URL(log.url).origin : new URL(candidates[0].url).origin;
        const cacheKey = buildOriginPsshKey(origin, log.pssh_data);
        manifestHistoryByOriginAndPssh.set(cacheKey, {
            manifest: candidates[0],
            recordedAt: Date.now()
        });
        trimManifestHistoryByPssh();
    } catch (error) {
        console.debug("[WidevineProxy2] failed to index manifest by pssh", error);
    }
}

/**
 * @description ログ情報から送信可能なマニフェストを推定します。
 * @param {object} log キー保存時のログです。
 * @returns {object|null} 使用するマニフェストです。
 */
function resolveManifestCandidate(log) {
    const inlineList = Array.isArray(log.manifests) ? log.manifests.filter(Boolean) : [];
    if (inlineList.length > 0) {
        return inlineList[0];
    }
    const stored = log.url ? getTabManifestHistory(log.url) : null;
    if (stored && stored.length > 0) {
        return stored[0];
    }
    const originPsshCandidate = resolveManifestByOriginAndPssh(log);
    if (originPsshCandidate) {
        return originPsshCandidate;
    }
    if (log.url) {
        try {
            const origin = new URL(log.url).origin;
            const history = manifestHistoryByOrigin.get(origin);
            if (history && history.length > 0) {
                return history[0];
            }
        } catch (error) {
            console.debug("[WidevineProxy2] manifest fallback resolution failed", error);
        }
    }
    return null;
}

/**
 * @description ヘッダーオブジェクトを正規化します。
 * @param {unknown} raw 抽出したヘッダー値です。
 * @returns {Record<string,string>} 正規化済みのヘッダーです。
 */
function sanitizeHeaders(raw) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return raw;
    }
    return {};
}

/**
 * @description リクエストヘッダーを URL キーで記録します。
 * @param {string} url リクエストURLです。
 * @param {Record<string,string>} headers 保存したいヘッダーです。
 */
function rememberRequestHeaders(url, headers) {
    if (!url || !headers) {
        return;
    }
    pruneExpiredRequestCache();
    requests.set(url, {
        headers,
        recordedAt: Date.now()
    });
    enforceRequestCacheLimit();
}

/**
 * @description キャッシュ容量が上限を超えた場合に古いエントリを削除します。
 */
function enforceRequestCacheLimit() {
    if (requests.size <= REQUEST_CACHE_LIMIT) {
        return;
    }
    const entries = Array.from(requests.entries())
        .sort(([, a], [, b]) => (a.recordedAt ?? 0) - (b.recordedAt ?? 0));
    const overflow = Math.max(0, requests.size - REQUEST_CACHE_LIMIT);
    for (let i = 0; i < overflow; i++) {
        const [key] = entries[i] || [];
        if (key) {
            requests.delete(key);
        }
    }
}

/**
 * @description URL に対する保存済みヘッダーを取得します。
 * @param {string} url リクエストURLです。
 * @returns {Record<string,string>|null} 有効なヘッダーです。
 */
function getCachedRequestHeaders(url) {
    if (!url || !requests.has(url)) {
        return null;
    }
    const entry = requests.get(url);
    if (!entry) {
        return null;
    }
    if (Date.now() - (entry.recordedAt ?? 0) > REQUEST_CACHE_TTL_MS) {
        requests.delete(url);
        return null;
    }
    return entry.headers || null;
}

/**
 * @description TTL を過ぎたヘッダーエントリを削除します。
 */
function pruneExpiredRequestCache() {
    const now = Date.now();
    for (const [key, entry] of requests.entries()) {
        if (now - (entry.recordedAt ?? 0) > REQUEST_CACHE_TTL_MS) {
            requests.delete(key);
        }
    }
}

/**
 * @description オリジンと PSSH をキーにしたマニフェストを検索します。
 * @param {{pssh_data?: string, url?: string}} log 検索条件となるログです。
 * @returns {object|null} 一致したマニフェストです。
 */
function resolveManifestByOriginAndPssh(log) {
    if (!log?.pssh_data || !log?.url) {
        return null;
    }
    try {
        const origin = new URL(log.url).origin;
        const cacheKey = buildOriginPsshKey(origin, log.pssh_data);
        const cached = manifestHistoryByOriginAndPssh.get(cacheKey);
        if (!cached) {
            return null;
        }
        if (Date.now() - cached.recordedAt > MANIFEST_PSSH_HISTORY_TTL_MS) {
            manifestHistoryByOriginAndPssh.delete(cacheKey);
            return null;
        }
        return cached.manifest || null;
    } catch (error) {
        console.debug("[WidevineProxy2] failed to resolve manifest by pssh", error);
        return null;
    }
}

/**
 * @description オリジンと PSSH からキャッシュキーを生成します。
 * @param {string} origin オリジンです。
 * @param {string} pssh PSSH 値です。
 * @returns {string} キャッシュキーです。
 */
function buildOriginPsshKey(origin, pssh) {
    return `${origin}::${pssh}`;
}

/**
 * @description PSSH 紐づけマニフェスト履歴を上限内に保ちます。
 */
function trimManifestHistoryByPssh() {
    if (manifestHistoryByOriginAndPssh.size <= MANIFEST_PSSH_HISTORY_LIMIT) {
        return;
    }
    const entries = Array.from(manifestHistoryByOriginAndPssh.entries())
        .sort(([, a], [, b]) => (a.recordedAt ?? 0) - (b.recordedAt ?? 0));
    const overflow = manifestHistoryByOriginAndPssh.size - MANIFEST_PSSH_HISTORY_LIMIT;
    for (let i = 0; i < overflow; i++) {
        const [key] = entries[i] || [];
        if (key) {
            manifestHistoryByOriginAndPssh.delete(key);
        }
    }
}

/**
 * @description ネイティブイベントからクライアントジョブIDを導出します。
 * @param {object} event ネイティブイベントです。
 * @returns {string|null} クライアント側でのジョブIDです。
 */
function resolveJobKeyFromEvent(event) {
    if (event?.clientJobId) {
        return event.clientJobId;
    }
    if (event?.jobId && hostJobToClientJob.has(event.jobId)) {
        return hostJobToClientJob.get(event.jobId) || null;
    }
    return null;
}

/**
 * @description ジョブステータスが終端状態かどうかを判定します。
 * @param {string} status 判定したいステータスです。
 * @returns {boolean} 完了済みであれば true。
 */
function isTerminalJobStatus(status, { includeFailed = true } = {}) {
    const normalized = (status || "").toString().toLowerCase();
    if (normalized === "completed") {
        return true;
    }
    if (!includeFailed) {
        return false;
    }
    return normalized === "failed" || normalized === "cancelled";
}

function safeRuntimeSendMessage(message) {
    if (!chrome?.runtime?.sendMessage) {
        return;
    }
    try {
        const maybePromise = chrome.runtime.sendMessage(message);
        if (maybePromise && typeof maybePromise.catch === "function") {
            maybePromise.catch((error) => {
                if (isExpectedRuntimePortError(error)) {
                    return;
                }
                console.debug("runtime.sendMessage rejected", error);
            });
        }
    } catch (error) {
        if (isExpectedRuntimePortError(error)) {
            return;
        }
        console.debug("runtime.sendMessage failed", error);
    }
}

/**
 * @description `native_jobs` のキャッシュを初期化または再利用します。
 * @returns {Promise<Record<string, object>>} 現在のジョブキャッシュです。
 */
async function ensureJobDraftCache() {
    if (jobDraftCache) {
        return jobDraftCache;
    }
    if (jobDraftCacheLoadPromise) {
        return jobDraftCacheLoadPromise;
    }
    jobDraftCacheLoadPromise = (async () => {
        try {
            const snapshot = await AsyncLocalStorage.getStorage([HOST_JOB_STORAGE_KEY]);
            const stored = snapshot[HOST_JOB_STORAGE_KEY] || {};
            jobDraftCache = { ...stored };
        } catch (error) {
            console.warn("[WidevineProxy2] ジョブキャッシュ初期化に失敗", error);
            jobDraftCache = {};
        } finally {
            jobDraftCacheLoadPromise = null;
            refreshJobActivityState();
        }
        return jobDraftCache;
    })();
    return jobDraftCacheLoadPromise;
}

/**
 * @description バッチ書き込みをスケジュールし、過剰な storage I/O を避けます。
 */
function scheduleJobDraftFlush() {
    if (jobDraftFlushTimer) {
        return;
    }
    jobDraftFlushTimer = setTimeout(() => {
        jobDraftFlushTimer = null;
        persistJobDraftCache().catch((error) => {
            console.warn("[WidevineProxy2] ジョブキャッシュ書き込み失敗", error);
        });
    }, JOB_DRAFT_FLUSH_INTERVAL_MS);
}

/**
 * @description キャッシュ済みジョブを storage へ同期します。
 * @returns {Promise<void>} フラッシュ完了の Promise です。
 */
async function persistJobDraftCache() {
    if (!jobDraftCache) {
        return;
    }
    const trimmed = trimJobsObject(jobDraftCache);
    jobDraftCache = trimmed;
    await AsyncLocalStorage.setStorage({ [HOST_JOB_STORAGE_KEY]: trimmed });
    refreshJobActivityState();
}

/**
 * @description バッファを即時書き込みし、待機中タイマーを停止します。
 * @returns {Promise<void>} 同期完了の Promise です。
 */
async function flushJobDraftCacheImmediately() {
    if (jobDraftFlushTimer) {
        clearTimeout(jobDraftFlushTimer);
        jobDraftFlushTimer = null;
    }
    await persistJobDraftCache();
}

/**
 * @description メモリ上のジョブキャッシュにタブIDを反映します。
 * @param {string} jobKey 対象ジョブIDです。
 * @param {number} tabId 紐付けるタブIDです。
 */
function updateCachedJobTab(jobKey, tabId) {
    if (!jobKey || typeof tabId !== "number" || !jobDraftCache) {
        return;
    }
    const current = jobDraftCache[jobKey] || { clientJobId: jobKey };
    if (current.tabId === tabId) {
        jobDraftCache[jobKey] = current;
        return;
    }
    jobDraftCache[jobKey] = {
        ...current,
        tabId
    };
    scheduleJobDraftFlush();
}

/**
 * @description ネイティブジョブイベントを拡張内の各コンテキストとオーバーレイへ伝搬させます。
 * @param {object} payload 共有したいイベントペイロードです。
 */
function broadcastHostNativeEvent(payload) {
    const message = {
        type: "HOST_NATIVE_EVENT",
        payload
    };
    safeRuntimeSendMessage(message);
    deliverHostNativeEvent(message).catch((error) => {
        console.debug("[WidevineProxy2] overlay delivery failed", error);
    });
}

/**
 * @description DL開始時のイベントを統一フォーマットで配信します。
 * @param {object} payload クライアントジョブIDやURLを含むメタデータです。
 */
function broadcastDownloadStart(payload) {
    broadcastHostNativeEvent({
        type: "job-start",
        ...payload,
        startedAt: Date.now()
    });
}

/**
 * @description ネイティブジョブの状態を chrome.storage.local に保存します。
 * @param {string} jobKey クライアントジョブIDです。
 * @param {object} patch 反映したい差分です。
 */
async function upsertNativeJobDraft(jobKey, patch) {
    if (!jobKey) {
        return;
    }
    const cache = await ensureJobDraftCache();
    const existing = cache[jobKey] || {};
    const next = {
        ...existing,
        ...patch,
        clientJobId: jobKey,
        updatedAt: patch?.updatedAt ?? Date.now()
    };
    if (!next.createdAt) {
        next.createdAt = Date.now();
    }
    cache[jobKey] = next;
    jobDraftCache = trimJobsObject(cache);
    scheduleJobDraftFlush();
    const validKeys = Object.keys(jobDraftCache);
    await pruneJobPayloadStore(validKeys);
    await pruneJobTabTargets(validKeys);
    refreshJobActivityState();
    return next;
}

/**
 * @description 保持数を超えないようにジョブ履歴をトリミングします。
 * @param {Record<string, object>} jobs ジョブマップです。
 * @returns {Record<string, object>} トリミング済みマップです。
 */
function trimJobsObject(jobs) {
    const now = Date.now();
    return Object.entries(jobs)
        .filter(([, value]) => {
            const updated = value?.updatedAt ?? value?.createdAt ?? 0;
            return now - updated <= HOST_JOB_STALE_WINDOW_MS;
        })
        .sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, HOST_JOB_HISTORY_LIMIT)
        .reduce((acc, [key, value]) => {
            acc[key] = value;
            return acc;
        }, {});
}

/**
 * @description ジョブ投入時のペイロードをストレージに保存します。
 * @param {string} jobKey クライアントジョブIDです。
 * @param {object} payload ネイティブホストへ送る実ペイロードです。
 */
async function stashJobPayload(jobKey, payload) {
    if (!jobKey || !payload) {
        return;
    }
    const snapshot = await AsyncLocalStorage.getStorage([HOST_JOB_PAYLOAD_KEY]);
    const current = snapshot[HOST_JOB_PAYLOAD_KEY] || {};
    current[jobKey] = {
        payload,
        savedAt: Date.now()
    };
    const trimmed = trimJobPayloadStore(current);
    await AsyncLocalStorage.setStorage({ [HOST_JOB_PAYLOAD_KEY]: trimmed });
}

/**
 * @description 完了済みのジョブペイロードを削除します。
 * @param {string} jobKey クライアントジョブIDです。
 */
async function dropJobPayload(jobKey) {
    if (!jobKey) {
        return;
    }
    const snapshot = await AsyncLocalStorage.getStorage([HOST_JOB_PAYLOAD_KEY]);
    const current = snapshot[HOST_JOB_PAYLOAD_KEY] || {};
    if (!current[jobKey]) {
        return;
    }
    delete current[jobKey];
    await AsyncLocalStorage.setStorage({ [HOST_JOB_PAYLOAD_KEY]: current });
}

async function getJobPayload(jobKey) {
    if (!jobKey) {
        return null;
    }
    const snapshot = await AsyncLocalStorage.getStorage([HOST_JOB_PAYLOAD_KEY]);
    const current = snapshot[HOST_JOB_PAYLOAD_KEY] || {};
    const record = current[jobKey];
    return extractPayload(record);
}

async function deleteNativeJobDraft(jobKey) {
    if (!jobKey) {
        return;
    }
    const cache = await ensureJobDraftCache();
    if (!cache[jobKey]) {
        return;
    }
    delete cache[jobKey];
    jobDraftCache = trimJobsObject(cache);
    scheduleJobDraftFlush();
    const validKeys = Object.keys(jobDraftCache);
    await pruneJobPayloadStore(validKeys);
    await pruneJobTabTargets(validKeys);
    releaseJobSlot(jobKey);
    refreshJobActivityState();
}

/**
 * @description 最新のジョブ一覧に存在しないペイロードを掃除します。
 * @param {Array<string>} validKeys 生存しているジョブIDリストです。
 */
async function pruneJobPayloadStore(validKeys = []) {
    const snapshot = await AsyncLocalStorage.getStorage([HOST_JOB_PAYLOAD_KEY]);
    const current = snapshot[HOST_JOB_PAYLOAD_KEY] || {};
    if (validKeys.length === 0) {
        if (Object.keys(current).length === 0) {
            return;
        }
        await AsyncLocalStorage.setStorage({ [HOST_JOB_PAYLOAD_KEY]: {} });
        return;
    }
    const validSet = new Set(validKeys);
    let mutated = false;
    for (const key of Object.keys(current)) {
        if (!validSet.has(key)) {
            delete current[key];
            mutated = true;
        }
    }
    if (mutated) {
        await AsyncLocalStorage.setStorage({ [HOST_JOB_PAYLOAD_KEY]: current });
    }
}

/**
 * @description ペイロードストアを履歴数以内にトリミングします。
 * @param {Record<string, {payload: object, savedAt: number}>} store 現在のストアです。
 * @returns {Record<string, {payload: object, savedAt: number}>} トリミング後のストアです。
 */
function trimJobPayloadStore(store) {
    const now = Date.now();
    return Object.entries(store)
        .filter(([, record]) => {
            const updated = record?.payload?.updatedAt ?? record?.savedAt ?? 0;
            return now - updated <= HOST_JOB_STALE_WINDOW_MS;
        })
        .sort(([, a], [, b]) => (b?.savedAt ?? 0) - (a?.savedAt ?? 0))
        .slice(0, HOST_JOB_HISTORY_LIMIT)
        .reduce((acc, [key, value]) => {
            acc[key] = value;
            return acc;
        }, {});
}

/**
 * @description ジョブとタブIDの紐付けを保存します。
 * @param {string} jobKey ジョブIDです。
 * @param {number} tabId 対象タブIDです。
 */
async function rememberJobTabTarget(jobKey, tabId) {
    if (!jobKey || typeof tabId !== "number") {
        return;
    }
    jobToastTargets.set(jobKey, tabId);
    const snapshot = await AsyncLocalStorage.getStorage([HOST_JOB_TAB_MAP_KEY]);
    const current = snapshot[HOST_JOB_TAB_MAP_KEY] || {};
    current[jobKey] = {
        tabId,
        savedAt: Date.now()
    };
    const trimmed = trimJobTabStore(current);
    await AsyncLocalStorage.setStorage({ [HOST_JOB_TAB_MAP_KEY]: trimmed });
    updateCachedJobTab(jobKey, tabId);
    const cached = jobDraftCache?.[jobKey];
    if (cached?.sourceUrl) {
        rememberTabResolution(tabId, cached.sourceUrl);
    }
}

/**
 * @description 実行中ジョブに 1〜5 のスロット番号を割り当てます。
 * @param {string} jobKey 対象ジョブIDです。
 * @returns {number|null} 付与したスロット番号です。
 */
function ensureJobSlot(jobKey) {
    if (!jobKey) {
        return null;
    }
    if (jobSlotAssignments.has(jobKey)) {
        return jobSlotAssignments.get(jobKey) || null;
    }
    const used = new Set(jobSlotAssignments.values());
    for (let slot = 1; slot <= MAX_CONCURRENT_HOST_JOBS; slot += 1) {
        if (!used.has(slot)) {
            jobSlotAssignments.set(jobKey, slot);
            return slot;
        }
    }
    return null;
}

/**
 * @description スロット割り当てを解放します。
 * @param {string} jobKey 対象ジョブIDです。
 */
function releaseJobSlot(jobKey) {
    if (!jobKey) {
        return;
    }
    jobSlotAssignments.delete(jobKey);
}

/**
 * @description ジョブに紐づくタブIDを取得します。
 * @param {string} jobKey ジョブIDです。
 * @returns {Promise<number|null>} タブIDです。
 */
async function getJobTabTarget(jobKey) {
    if (!jobKey) {
        return null;
    }
    if (jobToastTargets.has(jobKey)) {
        return jobToastTargets.get(jobKey) ?? null;
    }
    const snapshot = await AsyncLocalStorage.getStorage([HOST_JOB_TAB_MAP_KEY]);
    const current = snapshot[HOST_JOB_TAB_MAP_KEY] || {};
    for (const [key, record] of Object.entries(current)) {
        if (typeof record?.tabId === "number") {
            jobToastTargets.set(key, record.tabId);
        }
    }
    return jobToastTargets.has(jobKey) ? jobToastTargets.get(jobKey) ?? null : null;
}

/**
 * @description 特定タブに紐づくジョブ情報を一括で削除します。
 * @param {number} tabId 対象タブIDです。
 */
async function forgetJobTabTargetsForTab(tabId) {
    if (typeof tabId !== "number") {
        return;
    }
    const snapshot = await AsyncLocalStorage.getStorage([HOST_JOB_TAB_MAP_KEY]);
    const current = snapshot[HOST_JOB_TAB_MAP_KEY] || {};
    let mutated = false;
    for (const [jobKey, record] of Object.entries(current)) {
        if (record?.tabId === tabId) {
            delete current[jobKey];
            jobToastTargets.delete(jobKey);
            mutated = true;
        }
    }
    if (mutated) {
        await AsyncLocalStorage.setStorage({ [HOST_JOB_TAB_MAP_KEY]: current });
    }
}

/**
 * @description タブ紐付けストアを履歴サイズ以内に圧縮します。
 * @param {Record<string, {tabId:number,savedAt:number}>} store 現在のストアです。
 * @returns {Record<string, {tabId:number,savedAt:number}>} トリミング後のストアです。
 */
function trimJobTabStore(store) {
    return Object.entries(store)
        .sort(([, a], [, b]) => (b?.savedAt ?? 0) - (a?.savedAt ?? 0))
        .slice(0, HOST_JOB_HISTORY_LIMIT)
        .reduce((acc, [key, value]) => {
            acc[key] = value;
            return acc;
        }, {});
}

/**
 * @description 有効なジョブIDだけが残るようタブ紐付けを整理します。
 * @param {Array<string>} validKeys 現在存続しているジョブID一覧です。
 */
async function pruneJobTabTargets(validKeys = []) {
    const snapshot = await AsyncLocalStorage.getStorage([HOST_JOB_TAB_MAP_KEY]);
    const current = snapshot[HOST_JOB_TAB_MAP_KEY] || {};
    if (validKeys.length === 0) {
        if (Object.keys(current).length === 0) {
            return;
        }
        await AsyncLocalStorage.setStorage({ [HOST_JOB_TAB_MAP_KEY]: {} });
        jobToastTargets.clear();
        return;
    }
    const validSet = new Set(validKeys);
    let mutated = false;
    for (const key of Object.keys(current)) {
        if (!validSet.has(key)) {
            delete current[key];
            jobToastTargets.delete(key);
            mutated = true;
        }
    }
    if (mutated) {
        await AsyncLocalStorage.setStorage({ [HOST_JOB_TAB_MAP_KEY]: current });
    }
    for (const jobKey of Array.from(jobToastTargets.keys())) {
        if (!validSet.has(jobKey)) {
            jobToastTargets.delete(jobKey);
        }
    }
}

/**
 * @description ストアに保存したレコードからペイロード本体を取り出します。
 * @param {{payload?: object}} record ストアのレコードです。
 * @returns {object|null} 送信用ペイロードです。
 */
function extractPayload(record) {
    if (!record) {
        return null;
    }
    if (record.payload) {
        return record.payload;
    }
    return record;
}

/**
 * @description ジョブ再送が必要かどうかを判定します。
 * @param {object} jobDraft ストレージ上のジョブ情報です。
 * @returns {boolean} 再送対象であれば true。
 */
function shouldReplayJob(jobDraft) {
    if (!jobDraft) {
        return false;
    }
    if (isTerminalJobStatus(jobDraft.status || jobDraft.stage)) {
        return false;
    }
    return true;
}

/**
 * @description 進捗イベントに応じてペイロードを破棄すべきか判定します。
 * @param {string} status 最新ステータスです。
 * @returns {boolean} 破棄対象なら true。
 */
function shouldDropPayloadForStatus(status) {
    return isTerminalJobStatus(status, { includeFailed: false });
}

/**
 * @description 進捗イベントからステータス文字列を抽出します。
 * @param {object} event ネイティブホストイベントです。
 * @returns {string} ステータス文字列です。
 */
function getJobStatusFromEvent(event) {
    return (event?.status || event?.stage || "").toString();
}

/**
 * @description ネイティブホスト再接続時に未完了ジョブを再送します。
 * @param {string} reason 呼び出し理由です。
 * @returns {Promise<void>} 再送処理の完了を表す Promise。
 */
async function replayPendingNativeJobs(reason = "connect") {
    if (replayJobsPromise) {
        return replayJobsPromise;
    }
    replayJobsPromise = (async () => {
        try {
            await flushJobDraftCacheImmediately();
            const snapshot = await AsyncLocalStorage.getStorage([HOST_JOB_STORAGE_KEY, HOST_JOB_PAYLOAD_KEY]);
            const jobDrafts = snapshot[HOST_JOB_STORAGE_KEY] || {};
            const payloadStore = snapshot[HOST_JOB_PAYLOAD_KEY] || {};
            const pending = Object.entries(jobDrafts)
                .filter(([, draft]) => shouldReplayJob(draft));
            for (const [jobKey] of pending) {
                const payloadRecord = payloadStore[jobKey];
                const payload = extractPayload(payloadRecord);
                if (!payload) {
                    continue;
                }
                await nativeHostBridge.sendMessage(payload);
            }
        } catch (error) {
            console.warn(`[WidevineProxy2] ジョブ再送に失敗しました (${reason})`, error);
        } finally {
            replayJobsPromise = null;
        }
    })();
    return replayJobsPromise;
}

function scheduleKeepAlive() {
    if (!chrome.alarms) {
        return;
    }
    if (!shouldMaintainKeepAlive()) {
        clearKeepAlive();
        return;
    }
    chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.25 });
}

function clearKeepAlive() {
    if (!chrome.alarms) {
        return;
    }
    chrome.alarms.clear(KEEP_ALIVE_ALARM);
}


/**
 * @description キャッシュ保守用のアラームを設定します。
 */
function scheduleCacheMaintenance() {
    if (!chrome.alarms) {
        return;
    }
    chrome.alarms.create(CACHE_MAINTENANCE_ALARM, {
        periodInMinutes: CACHE_MAINTENANCE_INTERVAL_MIN
    });
}

/**
 * @description キャッシュ・抑止テーブルなどを定期的に掃除します。
 */
function performCacheMaintenance() {
    pruneExpiredRequestCache();
    pruneExpiredTabManifestCache();
    pruneOverlaySuppressionCache();
    pruneTabResolutionCache();
}

/**
 * @description ネイティブホスト再接続のアラームを設定します。
 */
function scheduleHostReconnect() {
    if (!chrome.alarms) {
        return;
    }
    const delayMinutes = Math.min(Math.max(reconnectBackoffMs / 60000, 0.05), 1);
    chrome.alarms.create(HOST_RECONNECT_ALARM, { delayInMinutes: delayMinutes });
    reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, 60000);
}

/**
 * @description 再接続バックオフを初期化し、関連アラームを除去します。
 */
function resetHostReconnectBackoff() {
    reconnectBackoffMs = 1000;
    if (!chrome.alarms) {
        return;
    }
    chrome.alarms.clear(HOST_RECONNECT_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (!chrome.alarms) {
        return;
    }
    if (alarm.name === KEEP_ALIVE_ALARM) {
        if (!nativeHostBridge.port) {
            chrome.alarms.clear(KEEP_ALIVE_ALARM);
            return;
        }
        try {
            nativeHostBridge.port.postMessage({ kind: "ping" });
        } catch (error) {
            console.warn("[NativeHostBridge] keepalive ping failed", error);
        }
        return;
    }
    if (alarm.name === HOST_RECONNECT_ALARM) {
        nativeHostBridge.ensureConnected().catch((error) => {
            console.warn("[NativeHostBridge] reconnect attempt failed", error);
            scheduleHostReconnect();
        });
        return;
    }
    if (alarm.name === CACHE_MAINTENANCE_ALARM) {
        performCacheMaintenance();
    }
});

bootstrapNativeHostPort("service-worker-init");
scheduleCacheMaintenance();
performCacheMaintenance();

chrome.runtime.onStartup.addListener(() => {
    bootstrapNativeHostPort("runtime.onStartup");
});

chrome.runtime.onInstalled.addListener((details) => {
    const reason = details?.reason || "unknown";
    bootstrapNativeHostPort(`runtime.onInstalled:${reason}`);
});

/**
 * @description Widevineログからネイティブホスト向けのジョブを生成します。
 * @param {object} log キーとマニフェスト情報を含むログです。
 */
async function enqueueNativeJob(log, options = {}) {
    try {
        if (!log) {
            return;
        }
        const manifest = resolveManifestCandidate(log);

        const headers = sanitizeHeaders(manifest?.headers);
        nativeHostBridge.setConnectionDemand(true, { reason: "job-enqueue" });
        const enqueueTabId = typeof options.tabId === "number" ? options.tabId : null;
        const clientJobId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const cookieStrategy = await SettingsManager.getCookieStrategy();
        const cookieProfile = await SettingsManager.getCookieProfile();
        const preferredOutputDir = typeof options.outputDir === "string"
            ? options.outputDir
            : await SettingsManager.getOutputDirectory();
        const outputDir = sanitizeOutputDirectorySetting(preferredOutputDir);

        const baseContext = {
            clientJobId,
            manifest,
            log,
            headers,
            cookieStrategy,
            cookieProfile,
            outputDir,
            keys: Array.isArray(log.keys) ? log.keys : []
        };
        const strategyContext = await attachSiteProfileToStrategyContext(baseContext);
        const effectiveManifest = strategyContext.manifest || manifest;
        if (!effectiveManifest?.url) {
            console.debug("[WidevineProxy2] enqueueNativeJob skipped: manifest missing after site profile");
            return;
        }
        const effectiveLog = strategyContext.log || log;
        const keyCount = Array.isArray(strategyContext.keys) ? strategyContext.keys.length : 0;

        await upsertNativeJobDraft(clientJobId, {
            clientJobId,
            stage: "pending",
            status: "pending",
            detail: "ネイティブホストへ送信中",
            mpdUrl: effectiveManifest.url,
            sourceUrl: effectiveLog?.url ?? effectiveManifest.url,
            keyCount,
            outputDir: strategyContext.outputDir || null,
            tabId: enqueueTabId,
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
        if (enqueueTabId && effectiveLog?.url) {
            rememberTabResolution(enqueueTabId, effectiveLog.url);
        }
        let payload;
        try {
            payload = buildNativeJobPayload(strategyContext);
        } catch (error) {
            if (error && typeof error.message === "string" && error.message.includes("ダウンロードストラテジー")) {
                console.debug("[WidevineProxy2] enqueueNativeJob skipped:", error.message);
                return;
            }
            throw error;
        }
        validateNativeJobPayload(payload);

        const commandPreview = buildCommandPreviewForPayload(payload, strategyContext);
        if (commandPreview) {
            await upsertNativeJobDraft(clientJobId, { commandPreview });
        }
        if (payload.outputDir) {
            await upsertNativeJobDraft(clientJobId, { outputDir: payload.outputDir });
        }
        await stashJobPayload(clientJobId, payload);
        await nativeHostBridge.sendMessage(payload);
        purgeManifestForTab(effectiveLog?.url || log.url);
        return { clientJobId };
    } catch (error) {
        console.error("[WidevineProxy2] enqueueNativeJob error", error);
        throw error;
    }
}

/**
 * @description 選択したストラテジーでジョブペイロードを構築します。
 * @param {object} context ジョブ生成用のコンテキストです。
 * @returns {object} 構築済みペイロードです。
 */
function buildNativeJobPayload(context) {
    const strategy = downloadStrategyRegistry.resolve(context);
    if (!strategy) {
        throw new Error("適用可能なダウンロードストラテジーが見つかりません");
    }
    const payload = strategy.buildPayload(context);
    if (payload?.metadata && !payload.metadata.strategyId) {
        payload.metadata.strategyId = strategy.id;
    }
    return payload;
}

/**
 * @description ジョブペイロードの必須項目を検証します。不正な場合はエラーを投げます。
 * @param {object} payload 検証対象のペイロードです。
 */
function validateNativeJobPayload(payload) {
    if (!payload || typeof payload !== "object") {
        throw new Error("payload が不正です");
    }
    if (!payload.clientJobId) {
        throw new Error("clientJobId がありません");
    }
    if (!payload.mpdUrl || !/^https?:\/\//i.test(payload.mpdUrl)) {
        throw new Error("mpdUrl が不正です");
    }
    if (!Array.isArray(payload.keys)) {
        throw new Error("keys が配列ではありません");
    }
    const requiresKeys = doesPayloadRequireKeys(payload);
    if (requiresKeys && payload.keys.length === 0) {
        throw new Error("keys が空です");
    }
    payload.keys.forEach((entry, index) => {
        if (!entry?.kid || !entry?.key) {
            throw new Error(`keys[${index}] が不正です`);
        }
        if (!/^[0-9a-f]{32}$/i.test(entry.kid) || !/^[0-9a-f]{32}$/i.test(entry.key)) {
            throw new Error(`keys[${index}] が16進32桁ではありません`);
        }
    });
    if (!payload.metadata || typeof payload.metadata !== "object") {
        throw new Error("metadata が不正です");
    }
    if (!payload.metadata.strategyId) {
        throw new Error("metadata.strategyId が不正です");
    }
    if (!payload.metadata.headers || typeof payload.metadata.headers !== "object") {
        throw new Error("metadata.headers が不正です");
    }
    const cookies = payload.metadata.cookies;
    if (!cookies || typeof cookies !== "object") {
        throw new Error("metadata.cookies が不正です");
    }
    if (!cookies.profile) {
        throw new Error("cookies.profile が不正です");
    }
    const needsCustomOutput = doesPayloadRequireKeys(payload);
    if (needsCustomOutput && !payload.outputTemplate) {
        throw new Error("outputTemplate が不正です");
    }
    if (payload.outputDir && typeof payload.outputDir !== "string") {
        throw new Error("outputDir が不正です");
    }
    if (payload.outputDir && payload.outputDir.length > 1024) {
        throw new Error("outputDir が長すぎます");
    }
}

/**
 * @description キー配列をネイティブホスト用に整形します。
 * @param {Array<{kid:string,k:string}>} keys キー配列です。
 * @returns {Array<{kid:string,key:string}>} 整形済みキー配列です。
 */
function serializeLicenseKeys(keys = []) {
    return keys
        .filter((entry) => entry && entry.kid && entry.k)
        .map((entry) => ({
            kid: sanitizeHexString(entry.kid),
            key: sanitizeHexString(entry.k)
        }))
        .filter((entry) => entry.kid && entry.key);
}

/**
 * @description ペイロードが鍵を必要とするかどうかを判定します。
 * @param {object} payload 判定対象のペイロードです。
 * @returns {boolean} 鍵が必須なら true。
 */
function doesPayloadRequireKeys(payload) {
    const encryption = payload?.metadata?.transport?.encryption || payload?.metadata?.encryption;
    if (!encryption) {
        return true;
    }
    const normalized = encryption.toString().toLowerCase();
    return normalized !== "clear" && normalized !== "none";
}

/**
 * @description 適用ストラテジーに応じた CLI プレビューを生成します。
 * @param {object} payload ネイティブホストへ送信するペイロードです。
 * @param {object} context ストラテジー判定用のコンテキストです。
 * @returns {string} 改行付きのコマンドプレビューです。
 */
function buildCommandPreviewForPayload(payload, context) {
    if (!payload) {
        return "";
    }
    const strategyId = payload?.metadata?.strategyId;
    let strategy = strategyId ? downloadStrategyRegistry.getById(strategyId) : null;
    if (!strategy) {
        strategy = downloadStrategyRegistry.resolve(context);
    }
    if (!strategy) {
        return "";
    }
    try {
        return strategy.buildCommandPreview(payload, context);
    } catch (error) {
        console.warn("[WidevineProxy2] buildCommandPreview failed", strategy.id, error);
        return "";
    }
}

function quoteArg(value) {
    if (value == null) {
        return "\"\"";
    }
    const stringValue = String(value);
    const escaped = stringValue.replace(/"/g, '\\"');
    return `"${escaped}"`;
}

/**
 * @description 保存先ディレクトリ入力をサニタイズします。
 * @param {string|null|undefined} value 入力値です。
 * @returns {string|null} 空なら null。
 */
function sanitizeOutputDirectorySetting(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

/**
 * @description フォルダを開く際に空文字を排除します。
 * @param {string} value 入力パスです。
 * @returns {string} トリム済み文字列。
 */
function sanitizeRevealPathInput(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim();
}

/**
 * @description ネイティブホストへフォルダオープン要求を送信します。
 * @param {string} path 対象パスです。
 * @returns {Promise<void>} 送信完了時に解決します。
 */
async function requestNativeFolderReveal(path) {
    nativeHostBridge.setConnectionDemand(true, { reason: "folder-reveal" });
    if (folderRevealReleaseTimer) {
        clearTimeout(folderRevealReleaseTimer);
        folderRevealReleaseTimer = null;
    }
    await nativeHostBridge.sendMessage({ kind: "reveal-output", path });
    folderRevealReleaseTimer = setTimeout(() => {
        nativeHostBridge.setConnectionDemand(false, { reason: "folder-reveal-release" });
        folderRevealReleaseTimer = null;
    }, 2000);
}

/**
 * @description 16進文字列以外の文字を取り除き、小文字32桁へ揃えます。
 * @param {string} value 対象文字列です。
 * @returns {string} 整形済み文字列です。
 */
function sanitizeHexString(value) {
    if (!value) {
        return "";
    }
    const normalized = value.toString().replace(/[^0-9a-f]/gi, "").toLowerCase();
    if (normalized.length === 32) {
        return normalized;
    }
    if (normalized.length > 32) {
        return normalized.slice(0, 32);
    }
    return normalized.padEnd(32, "0");
}

/**
 * @description 出力ファイル名に利用するスラッグを生成します。
 * @param {object} log キーログです。
 * @param {object} manifest マニフェスト情報です。
 * @returns {string} サニタイズ済みスラッグです。
 */
/**
 * @description document.title 由来の文字列を最優先でスラッグにします。
 * @param {object} log キーログ情報です。
 * @param {object} manifest マニフェスト情報です。
 * @returns {string} ファイル名に用いるスラッグです。
 */
function deriveOutputSlug(log, manifest) {
    const primaryTitle = sanitizeDocumentTitle(log?.pageTitle || manifest?.pageTitle || "");
    const urlSlug = sanitizeOutputSlug(extractSlugFromUrl(log?.url) || extractSlugFromUrl(manifest?.url));
    if (primaryTitle && urlSlug) {
        const merged = sanitizeOutputSlug(`${primaryTitle}_${urlSlug}`);
        if (merged) {
            return merged;
        }
        return primaryTitle;
    }
    if (primaryTitle) {
        return primaryTitle;
    }
    if (urlSlug) {
        return urlSlug;
    }
    const fallbackCandidates = [log?.pssh_data, log?.clientJobId];
    for (const candidate of fallbackCandidates) {
        const sanitized = sanitizeOutputSlug(candidate);
        if (sanitized) {
            return sanitized;
        }
    }
    return `widevineproxy2-${Date.now()}`;
}

/**
 * @description document.title をサニタイズして安全なスラッグへ変換します。
 * @param {string} value document.title 文字列です。
 * @returns {string} サニタイズ済みスラッグです。
 */
function sanitizeDocumentTitle(value) {
    if (!value || typeof value !== "string") {
        return "";
    }
    return sanitizeOutputSlug(value);
}

function extractSlugFromUrl(url) {
    if (!url) {
        return "";
    }
    try {
        const { pathname } = new URL(url);
        const segments = pathname.split("/").filter(Boolean);
        if (segments.length === 0) {
            return "";
        }
        return segments[segments.length - 1];
    } catch {
        return "";
    }
}

function sanitizeOutputSlug(value) {
    if (!value) {
        return "";
    }
    const normalized = value.toString().normalize("NFKC");
    const withoutForbidden = normalized.replace(/[\\/:*?"<>|]/g, "");
    const collapsedSpaces = withoutForbidden.trim().replace(/\s+/g, "_");
    const singleUnderscore = collapsedSpaces.replace(/_{2,}/g, "_");
    const trimmed = singleUnderscore.replace(/^_+|_+$/g, "");
    if (!trimmed) {
        return "";
    }
    return trimmed.slice(0, OUTPUT_SLUG_MAX_LENGTH);
}

/**
 * @description タブ単位のマニフェスト記憶をクリアします。
 * @param {string|null} tabUrl 対象タブの URL です。
 */
function purgeManifestForTab(tabUrl) {
    if (!tabUrl) {
        return;
    }
    manifests.delete(tabUrl);
    tabManifestTimestamps.delete(tabUrl);
}
