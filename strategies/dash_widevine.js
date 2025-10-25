import { DownloadStrategy } from "./base.js";

/**
 * @typedef {import("./base.js").StrategyContext} StrategyContext
 */

/**
 * @description DASH + Widevine を処理するストラテジー実装です。
 */
export class DashWidevineStrategy extends DownloadStrategy {
    /**
     * @param {{priority?: number, schemaVersion?: number, helpers?: {serializeLicenseKeys?: Function, deriveOutputSlug?: Function, quoteArg?: Function}}} options 初期化オプションです。
     */
    constructor(options = {}) {
        super({ id: "dash-widevine", label: "DASH + Widevine", priority: options.priority ?? 10 });
        this.schemaVersion = options.schemaVersion ?? 1;
        this.helpers = {
            serializeLicenseKeys: options.helpers?.serializeLicenseKeys,
            deriveOutputSlug: options.helpers?.deriveOutputSlug,
            quoteArg: options.helpers?.quoteArg
        };
    }

    /**
     * @description マニフェストURLと鍵情報から対応可否を判定します。
     * @param {StrategyContext} context 判定対象のコンテキストです。
     * @returns {boolean} 条件を満たせば true。
     */
    canHandle(context) {
        const manifestUrl = context?.manifest?.url || "";
        const hasDashSignature = /\.mpd(\?|$)/i.test(manifestUrl) || /manifest/i.test(manifestUrl);
        const hasKeys = Array.isArray(context?.log?.keys) && context.log.keys.length > 0;
        return Boolean(manifestUrl && hasDashSignature && hasKeys);
    }

    /**
     * @description DASH + Widevine 向けのネイティブジョブペイロードを生成します。
     * @param {StrategyContext} context 入力パラメータです。
     * @returns {object} 生成済みペイロードです。
     */
    buildPayload(context) {
        const serializeLicenseKeys = this.helpers.serializeLicenseKeys;
        if (typeof serializeLicenseKeys !== "function") {
            throw new Error("serializeLicenseKeys helper is missing");
        }
        const manifestUrl = (context?.manifest?.url || "").trim();
        if (!manifestUrl) {
            throw new Error("manifest url missing");
        }
        const keys = serializeLicenseKeys(context?.log?.keys || []);
        if (keys.length === 0) {
            throw new Error("keys missing");
        }
        const deriveOutputSlug = this.helpers.deriveOutputSlug || (() => "widevineproxy2");
        const slug = deriveOutputSlug(context.log, context.manifest) || `widevineproxy2-${Date.now()}`;
        const sourceUrl = context?.log?.url || manifestUrl;
        const metadataCookies = this.buildCookieMetadata(context);
        // transport 情報を細分化しておくと、将来的に HLS など他方式とも比較しやすくなる
        const payload = {
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
                type: context?.manifest?.type || "DASH",
                headers: context.headers || {},
                manifestUrl,
                sourceUrl,
                capturedAt: context?.log?.timestamp ? context.log.timestamp * 1000 : Date.now(),
                cookies: metadataCookies,
                outputSlug: slug,
                log: {
                    url: context?.log?.url || null,
                    pageTitle: context?.log?.pageTitle || null,
                    tabUrl: context?.log?.tab_url || null,
                    queuedBy: context?.log?.queuedBy || null
                },
                transport: {
                    manifestType: "DASH",
                    drmType: this.inferDrmType(context),
                    encryption: keys.length > 0 ? "cenc" : "clear",
                    segmentFormat: this.detectSegmentFormat(context?.manifest),
                    notes: this.buildTransportNotes(context)
                }
            }
        };
        return payload;
    }

    /**
     * @description CLI プレビューを DASH 仕様に合わせて生成します。
     * @param {object} payload ネイティブジョブペイロードです。
     * @param {StrategyContext} _context 生成元のコンテキストです。
     * @returns {string} yt-dlp コマンド例です。
     */
    buildCommandPreview(payload, _context) {
        if (!payload?.mpdUrl) {
            return "";
        }
        const quoteArg = this.helpers.quoteArg || ((value) => `"${String(value)}"`);
        const args = [];
        args.push(`yt-dlp ${quoteArg(payload.mpdUrl)}`);
        args.push("--allow-unplayable-formats");
        args.push("--no-part");
        args.push("--concurrent-fragments 5");
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
        return args.join(" \\\n  ");
    }

    /**
     * @description DRM種別のヒューリスティック推定を行います。
     * @param {StrategyContext} _context 推定対象のコンテキストです。
     * @returns {string} DRM種別ラベルです。
     */
    inferDrmType(_context) {
        return "WIDEVINE";
    }

    /**
     * @description セグメントの入れ物を簡易推定します。
     * @param {object|null} manifest マニフェスト情報です。
     * @returns {string} 代表的な形式です。
     */
    detectSegmentFormat(manifest) {
        const hint = manifest?.container || manifest?.format || manifest?.mimeType || "";
        if (/mp4|cmaf/i.test(hint)) {
            return "fmp4";
        }
        if (/webm/i.test(hint)) {
            return "webm";
        }
        return "unknown";
    }

    /**
     * @description Cookie戦略をメタデータへ整形します。
     * @param {StrategyContext} context 入力値です。
     * @returns {{strategy: string, profile: string}} Cookie情報です。
     */
    buildCookieMetadata(context) {
        const strategy = context?.cookieStrategy === "netscape" ? "netscape" : "browser";
        const profile = context?.cookieProfile || "chrome:Default";
        return { strategy, profile };
    }

    /**
     * @description トランスポート診断情報を生成します。
     * @param {StrategyContext} context 入力値です。
     * @returns {string} 備考文字列です。
     */
    buildTransportNotes(context) {
        const label = context?.manifest?.label || context?.manifest?.quality;
        if (label) {
            return `label=${label}`;
        }
        return "";
    }
}
