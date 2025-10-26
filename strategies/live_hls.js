import { DownloadStrategy } from "./base.js";

/**
 * @typedef {import("./base.js").StrategyContext} StrategyContext
 */

/**
 * @description ライブ/イベント系の HLS を対象としたストラテジーです。
 */
export class LiveHlsStrategy extends DownloadStrategy {
    /**
     * @param {{priority?: number, schemaVersion?: number, helpers?: {serializeLicenseKeys?: Function, deriveOutputSlug?: Function, quoteArg?: Function}}} options 初期化オプションです。
     */
    constructor(options = {}) {
        super({ id: "live-hls", label: "Live HLS", priority: options.priority ?? 35 });
        this.schemaVersion = options.schemaVersion ?? 1;
        this.helpers = {
            serializeLicenseKeys: options.helpers?.serializeLicenseKeys,
            deriveOutputSlug: options.helpers?.deriveOutputSlug,
            quoteArg: options.helpers?.quoteArg
        };
    }

    /**
     * @description マニフェストがライブ HLS かどうかを判定します。
     * @param {StrategyContext} context 判定対象です。
     * @returns {boolean} 条件を満たせば true。
     */
    canHandle(context) {
        const manifest = context?.manifest;
        if (!manifest?.url) {
            return false;
        }
        if (!this.isHlsManifest(manifest)) {
            return false;
        }
        const details = manifest.details || {};
        if (!details.isLive && details.playlistType !== "EVENT") {
            return false;
        }
        const encryption = this.normalizeEncryption(details.encryption);
        if (encryption === "clear") {
            return true;
        }
        const keys = this.extractKeys(context);
        return keys.length > 0;
    }

    /**
     * @description ライブ HLS 向けペイロードを生成します。
     * @param {StrategyContext} context 入力情報です。
     * @returns {object} ネイティブホストペイロードです。
     */
    buildPayload(context) {
        const manifestUrl = (context?.manifest?.url || "").trim();
        if (!manifestUrl) {
            throw new Error("manifest url missing");
        }
        const details = context?.manifest?.details || {};
        const encryption = this.normalizeEncryption(details.encryption);
        const keys = this.extractKeys(context);
        if (encryption !== "clear" && keys.length === 0) {
            throw new Error("ライブ HLS の鍵が見つかりません");
        }
        const deriveOutputSlug = this.helpers.deriveOutputSlug || (() => "widevineproxy2");
        const slug = deriveOutputSlug(context?.log || {}, context.manifest) || `widevineproxy2-${Date.now()}`;
        const sourceUrl = context?.log?.url || manifestUrl;
        const cookies = this.buildCookieMetadata(context);
        const transport = this.buildTransportMetadata(context, encryption, keys.length > 0);
        const shouldForceCustomOutput = encryption !== "clear" || keys.length > 0;
        const outputTemplate = shouldForceCustomOutput ? `${slug}.%(ext)s` : null;

        return {
            schemaVersion: this.schemaVersion,
            kind: "queue",
            clientJobId: context.clientJobId,
            mpdUrl: manifestUrl,
            sourceUrl,
            keys,
            outputTemplate,
            outputDir: context.outputDir || null,
            metadata: {
                strategyId: this.id,
                type: transport.manifestType,
                headers: context.headers || {},
                manifestUrl,
                sourceUrl,
                capturedAt: context?.log?.timestamp ? context.log.timestamp * 1000 : Date.now(),
                cookies,
                outputSlug: shouldForceCustomOutput ? slug : null,
                log: {
                    url: context?.log?.url || null,
                    pageTitle: context?.log?.pageTitle || null,
                    tabUrl: context?.log?.tab_url || null,
                    queuedBy: context?.log?.queuedBy || null
                },
                transport
            }
        };
    }

    /**
     * @description ライブ HLS 用 CLI プレビューを生成します。
     * @param {object} payload ペイロードです。
     * @returns {string} CLI コマンド例です。
     */
    buildCommandPreview(payload) {
        if (!payload?.mpdUrl) {
            return "";
        }
        const quoteArg = this.getQuoteArg();
        const args = [];
        args.push(`yt-dlp ${quoteArg(payload.mpdUrl)}`);
        args.push("-f \"bv*+ba/b\"");
        args.push("--hls-use-mpegts");
        args.push("--hls-prefer-native");
        args.push("--no-part");
        args.push("--newline");
        args.push("--live-from-start");
        args.push("--retry-sleep=3");
        if (payload?.outputDir) {
            args.push(`--paths ${quoteArg(payload.outputDir)}`);
        }
        const cookies = payload?.metadata?.cookies;
        if (cookies?.strategy === "browser") {
            args.push(`--cookies-from-browser ${quoteArg(cookies.profile || "chrome:Default")}`);
        } else if (cookies?.strategy === "netscape") {
            args.push("--cookies /PATH/TO/cookies.txt");
        }
        if (payload?.outputTemplate) {
            args.push(`-o ${quoteArg(payload.outputTemplate)}`);
        }
        const headers = payload?.metadata?.headers || {};
        Object.entries(headers).forEach(([key, value]) => {
            if (!key || value == null) {
                return;
            }
            const sanitizedValue = String(value).replace(/"/g, '\\"');
            args.push(`--add-header "${key}: ${sanitizedValue}"`);
        });
        payload.keys?.forEach((entry) => {
            if (!entry?.kid || !entry?.key) {
                return;
            }
            args.push(`--key ${entry.kid}:${entry.key}`);
        });
        return args.join(" \\\n  ");
    }

    /**
     * @description HLS かどうかを判定します。
     * @param {{url?: string, type?: string, details?: {type?: string}}} manifest 判定対象です。
     * @returns {boolean} HLS なら true。
     */
    isHlsManifest(manifest) {
        const type = (manifest?.details?.type || manifest?.type || "").toUpperCase();
        if (type.startsWith("HLS")) {
            return true;
        }
        const url = manifest?.url?.toLowerCase() || "";
        return url.includes(".m3u8") || url.includes("/hls");
    }

    /**
     * @description トランスポート情報を構築します。
     * @param {StrategyContext} context 入力値です。
     * @param {string} encryption 暗号方式です。
     * @param {boolean} hasKeys 鍵有無です。
     * @returns {{manifestType: string, drmType: string|null, encryption: string, segmentFormat: string|null, notes: string, live: boolean}} トランスポート情報です。
     */
    buildTransportMetadata(context, encryption, hasKeys) {
        const manifest = context?.manifest;
        const details = manifest?.details || {};
        const manifestType = (details.type || manifest?.type || "HLS").toUpperCase();
        const segmentFormat = details.segmentFormat || (details?.encryption ? "fmp4" : "ts");
        const notes = this.buildTransportNotes(details);
        const drmType = hasKeys ? (this.normalizeDrmSystems(details.drmSystems)[0] || null) : null;
        return {
            manifestType,
            drmType,
            encryption,
            segmentFormat,
            notes,
            live: true
        };
    }

    /**
     * @description Cookie 情報を返します。
     * @param {StrategyContext} context 入力値です。
     * @returns {{strategy: string, profile: string}} Cookie 情報です。
     */
    buildCookieMetadata(context) {
        const strategy = context?.cookieStrategy === "netscape" ? "netscape" : "browser";
        const profile = context?.cookieProfile || "chrome:Default";
        return { strategy, profile };
    }

    /**
     * @description マニフェストノートを 1 行文字列に整形します。
     * @param {object} details マニフェスト詳細です。
     * @returns {string} 連結済みノートです。
     */
    buildTransportNotes(details) {
        const list = Array.isArray(details?.notes)
            ? details.notes
            : details?.notes
                ? [details.notes]
                : [];
        if (details.playlistType) {
            list.unshift(`playlist=${details.playlistType}`);
        }
        if (details.isLive) {
            list.unshift("live=true");
        }
        return list.join(", ");
    }

    /**
     * @description DRM 配列を正規化します。
     * @param {Array<string>|null|undefined} drmSystems DRM 名配列です。
     * @returns {Array<string>} 正規化済み配列です。
     */
    normalizeDrmSystems(drmSystems) {
        if (!Array.isArray(drmSystems)) {
            return [];
        }
        return drmSystems
            .map((value) => (value ? value.toString().toUpperCase() : ""))
            .filter(Boolean);
    }

    /**
     * @description 暗号名を正規化します。
     * @param {string|null|undefined} value 入力値です。
     * @returns {string} 正規化済み暗号名です。
     */
    normalizeEncryption(value) {
        if (!value) {
            return "clear";
        }
        const normalized = value.toString().toLowerCase();
        if (normalized === "none" || normalized === "clear") {
            return "clear";
        }
        return normalized;
    }

    /**
     * @description 鍵配列を抽出します。
     * @param {StrategyContext} context 入力値です。
     * @returns {Array<{kid: string, key: string}>} 整形済み鍵配列です。
     */
    extractKeys(context) {
        const serializeLicenseKeys = this.helpers.serializeLicenseKeys;
        if (typeof serializeLicenseKeys !== "function") {
            return [];
        }
        return serializeLicenseKeys(context?.keys || context?.log?.keys || []);
    }

    /**
     * @description クォート関数を返します。
     * @returns {(value: unknown) => string} クォート済み文字列を返します。
     */
    getQuoteArg() {
        if (typeof this.helpers.quoteArg === "function") {
            return this.helpers.quoteArg;
        }
        return (value) => {
            const stringValue = value == null ? "" : String(value);
            const escaped = stringValue.replace(/"/g, '\\"');
            return `"${escaped}"`;
        };
    }
}
