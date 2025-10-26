import { DownloadStrategy } from "./base.js";

/**
 * @typedef {import("./base.js").StrategyContext} StrategyContext
 */

/**
 * @description Smooth Streaming (.ism/manifest) を処理するストラテジーです。
 */
export class SmoothStreamingStrategy extends DownloadStrategy {
    /**
     * @param {{priority?: number, schemaVersion?: number, helpers?: {serializeLicenseKeys?: Function, deriveOutputSlug?: Function, quoteArg?: Function}}} options 初期化オプションです。
     */
    constructor(options = {}) {
        super({ id: "smooth-streaming", label: "Smooth Streaming", priority: options.priority ?? 50 });
        this.schemaVersion = options.schemaVersion ?? 1;
        this.helpers = {
            serializeLicenseKeys: options.helpers?.serializeLicenseKeys,
            deriveOutputSlug: options.helpers?.deriveOutputSlug,
            quoteArg: options.helpers?.quoteArg
        };
    }

    /**
     * @description Smooth Streaming かつ DRM 鍵を保有しているかを判定します。
     * @param {StrategyContext} context 判定対象です。
     * @returns {boolean} 条件を満たせば true。
     */
    canHandle(context) {
        const manifest = context?.manifest;
        if (!manifest?.url) {
            return false;
        }
        if (!this.isSmoothStreamingManifest(manifest)) {
            return false;
        }
        const keys = this.extractKeys(context);
        return keys.length > 0;
    }

    /**
     * @description Smooth Streaming 用ペイロードを構築します。
     * @param {StrategyContext} context 入力情報です。
     * @returns {object} ネイティブホストペイロードです。
     */
    buildPayload(context) {
        const manifestUrl = (context?.manifest?.url || "").trim();
        if (!manifestUrl) {
            throw new Error("manifest url missing");
        }
        const keys = this.extractKeys(context);
        if (keys.length === 0) {
            throw new Error("Smooth Streaming の鍵が不足しています");
        }
        const deriveOutputSlug = this.helpers.deriveOutputSlug || (() => "widevineproxy2");
        const slug = deriveOutputSlug(context?.log || {}, context.manifest) || `widevineproxy2-${Date.now()}`;
        const sourceUrl = context?.log?.url || manifestUrl;
        const cookies = this.buildCookieMetadata(context);
        const transport = this.buildTransportMetadata(context);

        return {
            schemaVersion: this.schemaVersion,
            kind: "queue",
            clientJobId: context.clientJobId,
            mpdUrl: manifestUrl,
            sourceUrl,
            keys,
            outputTemplate: `${slug}.%(ext)s`,
            outputDir: context.outputDir || null,
            metadata: {
                strategyId: this.id,
                type: transport.manifestType,
                headers: context.headers || {},
                manifestUrl,
                sourceUrl,
                capturedAt: context?.log?.timestamp ? context.log.timestamp * 1000 : Date.now(),
                cookies,
                outputSlug: slug,
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
     * @description Smooth Streaming の CLI プレビューを生成します。
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
        args.push("--allow-unplayable-formats");
        args.push("--no-part");
        args.push("--newline");
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
     * @description Smooth Streaming マニフェストかどうかを判定します。
     * @param {{url?: string, type?: string, details?: {type?: string}}} manifest 判定対象です。
     * @returns {boolean} Smooth Streaming なら true。
     */
    isSmoothStreamingManifest(manifest) {
        const type = (manifest?.details?.type || manifest?.type || "").toUpperCase();
        if (type === "MSS" || type.includes("SMOOTH")) {
            return true;
        }
        const url = manifest?.url?.toLowerCase() || "";
        return url.includes(".ism") || url.endsWith("manifest") || url.includes("manifest?");
    }

    /**
     * @description トランスポート情報を整形します。
     * @param {StrategyContext} context 入力情報です。
     * @returns {{manifestType: string, drmType: string|null, encryption: string, segmentFormat: string|null, notes: string}} トランスポート情報です。
     */
    buildTransportMetadata(context) {
        const manifest = context?.manifest;
        const details = manifest?.details || {};
        const manifestType = "SMOOTH_STREAMING";
        const drmType = this.normalizeDrmSystems(details.drmSystems)[0] || "PLAYREADY";
        const encryption = this.normalizeEncryption(details.encryption);
        const segmentFormat = details.segmentFormat || "fmp4";
        const notes = this.buildTransportNotes(details);
        return {
            manifestType,
            drmType,
            encryption,
            segmentFormat,
            notes
        };
    }

    /**
     * @description ノート文字列を生成します。
     * @param {object} details マニフェスト詳細です。
     * @returns {string} 結合済みノートです。
     */
    buildTransportNotes(details) {
        const list = Array.isArray(details?.notes)
            ? details.notes
            : details?.notes
                ? [details.notes]
                : [];
        if (details?.drmSystems?.length) {
            list.unshift(`drm=${details.drmSystems.join("+")}`);
        }
        return list.join(", ");
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
     * @description DRM 配列を正規化します。
     * @param {Array<string>|null|undefined} drmSystems DRM 名です。
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
     * @returns {string} 正規化後の暗号名です。
     */
    normalizeEncryption(value) {
        if (!value) {
            return "cenc";
        }
        const normalized = value.toString().toLowerCase();
        if (normalized === "none" || normalized === "clear") {
            return "clear";
        }
        return normalized;
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
