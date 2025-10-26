import { DownloadStrategy } from "./base.js";

/**
 * @typedef {import("./base.js").StrategyContext} StrategyContext
 */

/**
 * @description マニフェストが取得できない一般サイト向けに yt-dlp を直接叩くフォールバックストラテジーです。
 */
export class GenericYtDlpStrategy extends DownloadStrategy {
    /**
     * @param {{priority?: number, schemaVersion?: number, helpers?: {deriveOutputSlug?: Function, quoteArg?: Function}}} options 初期化オプションです。
     */
    constructor(options = {}) {
        super({ id: "generic-ytdlp", label: "Generic yt-dlp", priority: options.priority ?? 120 });
        this.schemaVersion = options.schemaVersion ?? 1;
        this.helpers = {
            deriveOutputSlug: options.helpers?.deriveOutputSlug,
            quoteArg: options.helpers?.quoteArg
        };
    }

    /**
     * @description ログやマニフェスト情報からフォールバック対象か判定します。
     * @param {StrategyContext} context 判定対象のコンテキストです。
     * @returns {boolean} 条件を満たせば true。
     */
    canHandle(context) {
        const forcedBySiteProfile = context?.siteProfile?.forcedStrategyId === this.id;
        if (forcedBySiteProfile) {
            return true;
        }
        const manifestType = (context?.manifest?.type || context?.manifest?.details?.type || "").toUpperCase();
        if (manifestType === "GENERIC") {
            return true;
        }
        const logType = (context?.log?.type || "").toUpperCase();
        return logType === "GENERIC";
    }

    /**
     * @description yt-dlp 用のペイロードを生成します。
     * @param {StrategyContext} context 入力情報です。
     * @returns {object} ネイティブホストへ送るペイロードです。
     */
    buildPayload(context) {
        const targetUrl = (
            context?.siteProfile?.canonicalUrl ||
            context?.manifest?.url ||
            context?.log?.url ||
            ""
        ).trim();
        if (!targetUrl) {
            throw new Error("generic target url missing");
        }
        const deriveOutputSlug = this.helpers.deriveOutputSlug || (() => "widevineproxy2");
        const slugCandidate = deriveOutputSlug(context?.log || {}, context.manifest) || "";
        const slug = this.applySlugFallback(slugCandidate, targetUrl);
        const cookies = this.buildCookieMetadata(context);
        const shouldForceCustomOutput = false;
        const outputTemplate = shouldForceCustomOutput ? `${slug}.%(ext)s` : null;
        return {
            schemaVersion: this.schemaVersion,
            kind: "queue",
            clientJobId: context.clientJobId,
            mpdUrl: targetUrl,
            sourceUrl: targetUrl,
            keys: [],
            outputTemplate,
            outputDir: context.outputDir || null,
            metadata: {
                strategyId: this.id,
                type: "GENERIC",
                headers: context.headers || {},
                manifestUrl: targetUrl,
                sourceUrl: targetUrl,
                capturedAt: context?.log?.timestamp ? context.log.timestamp * 1000 : Date.now(),
                cookies,
                outputSlug: shouldForceCustomOutput ? slug : null,
                siteProfile: context?.siteProfile || null,
                log: {
                    url: context?.log?.url || targetUrl,
                    pageTitle: context?.log?.pageTitle || null,
                    tabUrl: context?.log?.tab_url || null,
                    queuedBy: context?.log?.queuedBy || null
                },
                transport: {
                    manifestType: "GENERIC",
                    drmType: null,
                    encryption: "clear",
                    segmentFormat: null,
                    notes: "yt-dlp fallback"
                }
            }
        };
    }

    /**
     * @description yt-dlp CLI プレビューを組み立てます。
     * @param {object} payload 生成済みペイロードです。
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
        args.push("--newline");
        args.push("--no-part");
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
     * @description 引数をクォートする関数を返します。
     * @returns {(value: unknown) => string} クォート関数です。
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

    /**
     * @description スラッグが汎用すぎる場合に URL から推測した値へ差し替えます。
     * @param {string} slug 既定のスラッグです。
     * @param {string} url 参照元 URL です。
     * @returns {string} 調整後のスラッグです。
     */
    applySlugFallback(slug, url) {
        const normalized = (slug || "").trim();
        if (normalized && normalized.toLowerCase() !== "watch") {
            return normalized;
        }
        const derived = this.buildSlugFromUrl(url);
        if (derived) {
            return derived;
        }
        if (normalized) {
            return normalized;
        }
        return `widevineproxy2-${Date.now()}`;
    }

    /**
     * @description URL から動画 ID 等を抽出してスラッグにします。
     * @param {string} url 解析対象の URL です。
     * @returns {string} 抽出できたスラッグです。
     */
    buildSlugFromUrl(url) {
        if (!url) {
            return "";
        }
        try {
            const parsed = new URL(url);
            if (parsed.hostname.includes("youtube.com")) {
                const videoId = parsed.searchParams.get("v");
                if (videoId) {
                    return videoId;
                }
            }
            const pathnameSlug = parsed.pathname.split("/").filter(Boolean).pop();
            if (pathnameSlug && pathnameSlug !== "watch") {
                return pathnameSlug;
            }
            if (parsed.hostname) {
                return parsed.hostname.replace(/^www\./, "");
            }
        } catch {
            // noop
        }
        return "";
    }
}
