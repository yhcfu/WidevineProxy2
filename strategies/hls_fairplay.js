import { DownloadStrategy } from "./base.js";

/**
 * @typedef {import("./base.js").StrategyContext} StrategyContext
 */

/**
 * @description SAMPLE-AES / FairPlay で暗号化された HLS を扱うストラテジーです。
 */
export class HlsFairPlayStrategy extends DownloadStrategy {
    /**
     * @param {{priority?: number, schemaVersion?: number, helpers?: {serializeLicenseKeys?: Function, deriveOutputSlug?: Function, quoteArg?: Function}}} options 初期化オプションです。
     */
    constructor(options = {}) {
        super({ id: "hls-fairplay", label: "HLS + FairPlay", priority: options.priority ?? 32 });
        this.schemaVersion = options.schemaVersion ?? 1;
        this.helpers = {
            serializeLicenseKeys: options.helpers?.serializeLicenseKeys,
            deriveOutputSlug: options.helpers?.deriveOutputSlug,
            quoteArg: options.helpers?.quoteArg
        };
    }

    /**
     * @description HLS かつ FairPlay DRM を利用しているかを判定します。
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
        const drmSystems = this.normalizeDrmSystems(details.drmSystems);
        const isFairPlay = drmSystems.includes("FAIRPLAY");
        if (!isFairPlay) {
            return false;
        }
        const keys = this.extractKeys(context);
        return keys.length > 0;
    }

    /**
     * @description FairPlay HLS 向けペイロードを構築します。
     * @param {StrategyContext} context 入力値です。
     * @returns {object} ネイティブホスト用ペイロードです。
     */
    buildPayload(context) {
        const manifestUrl = (context?.manifest?.url || "").trim();
        if (!manifestUrl) {
            throw new Error("manifest url missing");
        }
        const keys = this.extractKeys(context);
        if (keys.length === 0) {
            throw new Error("FairPlay の鍵が見つかりません");
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
     * @description FairPlay 向け CLI プレビューを生成します。
     * @param {object} payload ネイティブペイロードです。
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
        args.push("--hls-use-mpegts");
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
     * @description HLS 判定を行います。
     * @param {{url?: string, type?: string, details?: {type?: string}}} manifest 判定対象です。
     * @returns {boolean} true なら HLS。
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
     * @description Cookie メタを整形します。
     * @param {StrategyContext} context 入力値です。
     * @returns {{strategy: string, profile: string}} Cookie 情報です。
     */
    buildCookieMetadata(context) {
        const strategy = context?.cookieStrategy === "netscape" ? "netscape" : "browser";
        const profile = context?.cookieProfile || "chrome:Default";
        return { strategy, profile };
    }

    /**
     * @description トランスポート情報を組み立てます。
     * @param {StrategyContext} context 入力コンテキストです。
     * @returns {{manifestType: string, drmType: string|null, encryption: string, segmentFormat: string|null, notes: string}} トランスポート情報です。
     */
    buildTransportMetadata(context) {
        const manifest = context?.manifest;
        const details = manifest?.details || {};
        const manifestType = (details.type || manifest?.type || "HLS").toUpperCase();
        const encryption = this.normalizeEncryption(details.encryption);
        const segmentFormat = details.segmentFormat || null;
        const notes = this.buildTransportNotes(details);
        return {
            manifestType,
            drmType: "FAIRPLAY",
            encryption,
            segmentFormat,
            notes
        };
    }

    /**
     * @description ノート配列を文字列へ結合します。
     * @param {object} details マニフェスト詳細です。
     * @returns {string} 連結ノートです。
     */
    buildTransportNotes(details) {
        const list = Array.isArray(details?.notes)
            ? details.notes
            : details?.notes
                ? [details.notes]
                : [];
        return list.join(", ");
    }

    /**
     * @description 鍵配列をシリアライズします。
     * @param {StrategyContext} context 入力値です。
     * @returns {Array<{kid: string, key: string}>} 整形済み鍵です。
     */
    extractKeys(context) {
        const serializeLicenseKeys = this.helpers.serializeLicenseKeys;
        if (typeof serializeLicenseKeys !== "function") {
            return [];
        }
        return serializeLicenseKeys(context?.keys || context?.log?.keys || []);
    }

    /**
     * @description DRM 名配列を正規化します。
     * @param {Array<string>|null|undefined} drmSystems 入力配列です。
     * @returns {Array<string>} 正規化配列です。
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
     * @description 暗号方式を正規化します。
     * @param {string|null|undefined} value 入力値です。
     * @returns {string} 正規化文字列です。
     */
    normalizeEncryption(value) {
        if (!value) {
            return "sample-aes";
        }
        const normalized = value.toString().toLowerCase();
        if (normalized === "none" || normalized === "clear") {
            return "clear";
        }
        return normalized;
    }

    /**
     * @description クォート関数を返します。
     * @returns {(value: unknown) => string} クォート済み文字列を返す関数です。
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
