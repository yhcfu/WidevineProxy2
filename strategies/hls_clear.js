import { DownloadStrategy } from "./base.js";

/**
 * @typedef {import("./base.js").StrategyContext} StrategyContext
 */

/**
 * @description DRM なしの HLS (m3u8) を処理するストラテジーです。
 */
export class HlsClearStrategy extends DownloadStrategy {
    /**
     * @param {{priority?: number, schemaVersion?: number, helpers?: {serializeLicenseKeys?: Function, deriveOutputSlug?: Function, quoteArg?: Function}}} options 初期化オプションです。
     */
    constructor(options = {}) {
        super({ id: "hls-clear", label: "HLS (Clear)", priority: options.priority ?? 40 });
        this.schemaVersion = options.schemaVersion ?? 1;
        this.helpers = {
            serializeLicenseKeys: options.helpers?.serializeLicenseKeys,
            deriveOutputSlug: options.helpers?.deriveOutputSlug,
            quoteArg: options.helpers?.quoteArg
        };
    }

    /**
     * @description HLS かつ暗号化されていない配信かどうかを判定します。
     * @param {StrategyContext} context 判定対象のコンテキストです。
     * @returns {boolean} 対応可能なら true。
     */
    canHandle(context) {
        const manifest = context?.manifest;
        if (!manifest?.url) {
            return false;
        }
        const normalizedUrl = manifest.url.toLowerCase();
        const details = manifest.details || {};
        const manifestType = (details.type || manifest.type || "").toUpperCase();
        const isHlsType = manifestType.startsWith("HLS");
        const isHlsUrl = normalizedUrl.includes(".m3u8") || normalizedUrl.includes("/hls");
        if (!isHlsType && !isHlsUrl) {
            return false;
        }
        const encryption = this.normalizeEncryption(details.encryption);
        if (encryption && encryption !== "clear") {
            return false;
        }
        const drmSystems = Array.isArray(details.drmSystems) ? details.drmSystems : [];
        if (drmSystems.length > 0) {
            return false;
        }
        const keys = this.extractKeys(context);
        // DRM なしであることを示すため、鍵が存在する場合はこのストラテジーでは扱わない
        if (keys.length > 0) {
            return false;
        }
        return true;
    }

    /**
     * @description HLS クリアストリーム向けのペイロードを構築します。
     * @param {StrategyContext} context 入力情報です。
     * @returns {object} ネイティブホストへ送るペイロードです。
     */
    buildPayload(context) {
        const deriveOutputSlug = this.helpers.deriveOutputSlug || (() => "widevineproxy2");
        const manifestUrl = (context?.manifest?.url || "").trim();
        if (!manifestUrl) {
            throw new Error("manifest url missing");
        }
        const sourceUrl = context?.log?.url || manifestUrl;
        const slug = deriveOutputSlug(context?.log || {}, context.manifest);
        const cookies = this.buildCookieMetadata(context);
        const transport = this.buildTransportMetadata(context);
        const keys = this.extractKeys(context);
        if (keys.length > 0) {
            throw new Error("HLS クリアストリームに鍵が含まれています");
        }
        const shouldForceCustomOutput = false;
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
     * @description CLI プレビュー（yt-dlp）を生成します。
     * @param {object} payload ネイティブジョブペイロードです。
     * @returns {string} 生成したコマンド文字列です。
     */
    buildCommandPreview(payload) {
        if (!payload?.mpdUrl) {
            return "";
        }
        const quoteArg = this.helpers.quoteArg || ((value) => `"${String(value)}"`);
        const args = [];
        args.push(`yt-dlp ${quoteArg(payload.mpdUrl)}`);
        args.push("-f \"bv*+ba/b\"");
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
        return args.join(" \\\n  ");
    }

    /**
     * @description Cookie 戦略を整形します。
     * @param {StrategyContext} context 入力値です。
     * @returns {{strategy: string, profile: string}} Cookie 情報です。
     */
    buildCookieMetadata(context) {
        const strategy = context?.cookieStrategy === "netscape" ? "netscape" : "browser";
        const profile = context?.cookieProfile || "chrome:Default";
        return { strategy, profile };
    }

    /**
     * @description マニフェスト解析結果からトランスポート情報を構築します。
     * @param {StrategyContext} context 入力値です。
     * @returns {{manifestType: string, drmType: string|null, encryption: string, segmentFormat: string|null, notes: string}} トランスポート情報です。
     */
    buildTransportMetadata(context) {
        const details = context?.manifest?.details || {};
        const manifestType = (details.type || "HLS").toUpperCase();
        const encryption = this.normalizeEncryption(details.encryption);
        const segmentFormat = details.segmentFormat || null;
        const noteList = Array.isArray(details.notes)
            ? details.notes
            : details.notes
                ? [details.notes]
                : [];
        const notes = noteList.join(", ");
        return {
            manifestType,
            drmType: null,
            encryption: encryption || "clear",
            segmentFormat,
            notes
        };
    }

    /**
     * @description コンテキストから鍵配列を抽出してシリアライズします。
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
     * @description 暗号方式を正規化します。
     * @param {string|null|undefined} value 入力された暗号文字列です。
     * @returns {string} 正規化された暗号名です。
     */
    normalizeEncryption(value) {
        if (!value) {
            return "clear";
        }
        const normalized = value.toString().toLowerCase();
        if (normalized === "none") {
            return "clear";
        }
        if (normalized === "clear") {
            return "clear";
        }
        return normalized;
    }
}
