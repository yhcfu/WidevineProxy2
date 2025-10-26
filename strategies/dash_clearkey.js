import { DownloadStrategy } from "./base.js";

/**
 * @typedef {import("./base.js").StrategyContext} StrategyContext
 */

/**
 * @description DRM なしの DASH / ClearKey 系ストリームを処理するストラテジーです。
 */
export class DashClearKeyStrategy extends DownloadStrategy {
    /**
     * @param {{priority?: number, schemaVersion?: number, helpers?: {deriveOutputSlug?: Function, quoteArg?: Function}}} options 初期化オプションです。
     */
    constructor(options = {}) {
        super({ id: "dash-clear", label: "DASH (Clear)", priority: options.priority ?? 20 });
        this.schemaVersion = options.schemaVersion ?? 1;
        this.helpers = {
            deriveOutputSlug: options.helpers?.deriveOutputSlug,
            quoteArg: options.helpers?.quoteArg
        };
    }

    /**
     * @description DASH かつ DRM が存在しないマニフェストかどうかを判定します。
     * @param {StrategyContext} context 判定対象のコンテキストです。
     * @returns {boolean} 条件を満たせば true。
     */
    canHandle(context) {
        const manifest = context?.manifest;
        if (!manifest?.url) {
            return false;
        }
        if (!this.isDashManifest(manifest)) {
            return false;
        }
        const details = manifest.details || {};
        const drmSystems = this.normalizeDrmSystems(details.drmSystems);
        if (drmSystems.length > 0) {
            return false;
        }
        const hasKeys = Array.isArray(context?.keys) && context.keys.length > 0;
        if (hasKeys) {
            return false;
        }
        const encryption = this.normalizeEncryption(details.encryption);
        return encryption === "clear" || encryption === "none" || encryption === "aes-128";
    }

    /**
     * @description Clear DASH 用のペイロードを生成します。
     * @param {StrategyContext} context 入力情報です。
     * @returns {object} ネイティブホストへ送るペイロードです。
     */
    buildPayload(context) {
        const manifestUrl = (context?.manifest?.url || "").trim();
        if (!manifestUrl) {
            throw new Error("manifest url missing");
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
            keys: [],
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
     * @description DASH クリア配信向けの CLI プレビューを組み立てます。
     * @param {object} payload 生成済みペイロードです。
     * @returns {string} yt-dlp コマンド例です。
     */
    buildCommandPreview(payload) {
        if (!payload?.mpdUrl) {
            return "";
        }
        const quoteArg = this.getQuoteArg();
        const args = [];
        args.push(`yt-dlp ${quoteArg(payload.mpdUrl)}`);
        args.push("-f \"bv*+ba/b\"");
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
     * @description DASH かどうかを URL/種別から判定します。
     * @param {{url?: string, type?: string}} manifest 判定対象のマニフェストです。
     * @returns {boolean} DASH なら true。
     */
    isDashManifest(manifest) {
        const url = manifest?.url || "";
        const type = (manifest?.type || manifest?.details?.type || "").toUpperCase();
        if (type.startsWith("DASH")) {
            return true;
        }
        return /\.mpd(\?|$)/i.test(url);
    }

    /**
     * @description Cookie メタデータを組み立てます。
     * @param {StrategyContext} context 入力値です。
     * @returns {{strategy: string, profile: string}} Cookie 情報です。
     */
    buildCookieMetadata(context) {
        const strategy = context?.cookieStrategy === "netscape" ? "netscape" : "browser";
        const profile = context?.cookieProfile || "chrome:Default";
        return { strategy, profile };
    }

    /**
     * @description トランスポート情報を整形します。
     * @param {StrategyContext} context 入力値です。
     * @returns {{manifestType: string, drmType: string|null, encryption: string, segmentFormat: string|null, notes: string}} トランスポート情報です。
     */
    buildTransportMetadata(context) {
        const manifest = context?.manifest;
        const details = manifest?.details || {};
        const manifestType = (details.type || manifest?.type || "DASH").toUpperCase();
        const encryption = this.normalizeEncryption(details.encryption);
        const segmentFormat = details.segmentFormat || null;
        const notes = this.buildTransportNotes(details);
        return {
            manifestType,
            drmType: null,
            encryption,
            segmentFormat,
            notes
        };
    }

    /**
     * @description 解析ノートを 1 行文字列へまとめます。
     * @param {object} details マニフェスト解析情報です。
     * @returns {string} 連結済みノートです。
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
     * @description 暗号方式を正規化します。
     * @param {string|null|undefined} value 判定対象です。
     * @returns {string} 正規化後の文字列です。
     */
    normalizeEncryption(value) {
        if (!value) {
            return "clear";
        }
        const normalized = value.toString().toLowerCase();
        if (normalized === "none") {
            return "clear";
        }
        return normalized;
    }

    /**
     * @description DRM 配列を正規化して上書きします。
     * @param {Array<string>|null|undefined} drmSystems DRM 名一覧です。
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
     * @description 引数のクォート関数を返します。
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
