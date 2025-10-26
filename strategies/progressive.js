import { DownloadStrategy } from "./base.js";

/**
 * @typedef {import("./base.js").StrategyContext} StrategyContext
 */

/**
 * @description 1 本の MP4/WEBM などを直接取得するプログレッシブ配信向けストラテジーです。
 */
export class ProgressiveStrategy extends DownloadStrategy {
    /**
     * @param {{priority?: number, schemaVersion?: number, helpers?: {deriveOutputSlug?: Function, quoteArg?: Function}}} options 初期化オプションです。
     */
    constructor(options = {}) {
        super({ id: "progressive", label: "Progressive", priority: options.priority ?? 80 });
        this.schemaVersion = options.schemaVersion ?? 1;
        this.helpers = {
            deriveOutputSlug: options.helpers?.deriveOutputSlug,
            quoteArg: options.helpers?.quoteArg
        };
        this.supportedExtensions = ["mp4", "mov", "m4v", "m4a", "webm", "mp3", "ts", "mkv"];
    }

    /**
     * @description URL からプログレッシブ配信かどうかを判定します。
     * @param {StrategyContext} context 判定対象です。
     * @returns {boolean} 条件を満たせば true。
     */
    canHandle(context) {
        const manifestUrl = context?.manifest?.url || context?.log?.mediaUrl || null;
        if (!manifestUrl) {
            return false;
        }
        return Boolean(this.detectExtension(manifestUrl));
    }

    /**
     * @description プログレッシブ配信向けペイロードを生成します。
     * @param {StrategyContext} context 入力情報です。
     * @returns {object} ネイティブホスト用ペイロードです。
     */
    buildPayload(context) {
        const mediaUrl = (context?.manifest?.url || context?.log?.mediaUrl || "").trim();
        if (!mediaUrl) {
            throw new Error("media url missing");
        }
        const extension = this.detectExtension(mediaUrl) || "mp4";
        const deriveOutputSlug = this.helpers.deriveOutputSlug || (() => "widevineproxy2");
        const slug = deriveOutputSlug(context?.log || {}, context.manifest) || `widevineproxy2-${Date.now()}`;
        const sourceUrl = context?.log?.url || mediaUrl;
        const cookies = this.buildCookieMetadata(context);
        const transport = this.buildTransportMetadata(extension);

        return {
            schemaVersion: this.schemaVersion,
            kind: "queue",
            clientJobId: context.clientJobId,
            mpdUrl: mediaUrl,
            sourceUrl,
            keys: [],
            outputTemplate: `${slug}.%(ext)s`,
            outputDir: context.outputDir || null,
            metadata: {
                strategyId: this.id,
                type: transport.manifestType,
                headers: context.headers || {},
                manifestUrl: mediaUrl,
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
     * @description プログレッシブ配信用 CLI プレビューを生成します。
     * @param {object} payload ペイロードです。
     * @returns {string} aria2c コマンド例です。
     */
    buildCommandPreview(payload) {
        if (!payload?.mpdUrl) {
            return "";
        }
        const quoteArg = this.getQuoteArg();
        const headers = payload?.metadata?.headers || {};
        const args = [];
        args.push("aria2c");
        args.push("--allow-overwrite=true");
        if (payload?.outputDir) {
            args.push(`--dir=${quoteArg(payload.outputDir)}`);
        }
        if (payload?.outputTemplate) {
            args.push(`--out=${quoteArg(payload.outputTemplate.replace("%(ext)s", this.guessExtension(payload.mpdUrl)))}`);
        }
        Object.entries(headers).forEach(([key, value]) => {
            if (!key || value == null) {
                return;
            }
            const sanitizedValue = String(value).replace(/"/g, '\\"');
            args.push(`--header=${quoteArg(`${key}: ${sanitizedValue}`)}`);
        });
        const cookies = payload?.metadata?.cookies;
        if (cookies?.strategy === "browser") {
            args.push(`--header=${quoteArg("Cookie: <ADD_BROWSER_COOKIE>")}`);
        } else if (cookies?.strategy === "netscape") {
            args.push("--load-cookies=/PATH/TO/cookies.txt");
        }
        args.push(quoteArg(payload.mpdUrl));
        return args.join(" \\\n  ");
    }

    /**
     * @description Cookie 情報を生成します。
     * @param {StrategyContext} context 入力値です。
     * @returns {{strategy: string, profile: string}} Cookie 情報です。
     */
    buildCookieMetadata(context) {
        const strategy = context?.cookieStrategy === "netscape" ? "netscape" : "browser";
        const profile = context?.cookieProfile || "chrome:Default";
        return { strategy, profile };
    }

    /**
     * @description プログレッシブ用途のトランスポート情報を返します。
     * @param {string} extension 推定拡張子です。
     * @returns {{manifestType: string, drmType: null, encryption: string, segmentFormat: string, notes: string}} トランスポート情報です。
     */
    buildTransportMetadata(extension) {
        return {
            manifestType: "PROGRESSIVE",
            drmType: null,
            encryption: "clear",
            segmentFormat: extension,
            notes: `direct-file=${extension}`
        };
    }

    /**
     * @description URL から拡張子を推定します。
     * @param {string} url 判定対象です。
     * @returns {string|null} サポート拡張子なら文字列、それ以外は null。
     */
    detectExtension(url) {
        if (!url) {
            return null;
        }
        try {
            const parsed = new URL(url);
            const pathname = parsed.pathname.toLowerCase();
            const match = pathname.match(/\.([a-z0-9]+)$/i);
            if (!match) {
                return null;
            }
            const ext = match[1].toLowerCase();
            return this.supportedExtensions.includes(ext) ? ext : null;
        } catch {
            return null;
        }
    }

    /**
     * @description CLI 出力用に拡張子を推定します。
     * @param {string} url 判定対象です。
     * @returns {string} 推定拡張子です。
     */
    guessExtension(url) {
        return this.detectExtension(url) || "mp4";
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
