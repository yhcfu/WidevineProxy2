import { DownloadStrategy } from "./base.js";

/**
 * @typedef {import("./base.js").StrategyContext} StrategyContext
 */

/**
 * @description Widevine で暗号化された HLS (m3u8) を処理するストラテジーです。
 */
export class HlsWidevineStrategy extends DownloadStrategy {
    /**
     * @param {{priority?: number, schemaVersion?: number, helpers?: {serializeLicenseKeys?: Function, deriveOutputSlug?: Function, quoteArg?: Function}}} options 初期化オプションです。
     */
    constructor(options = {}) {
        super({ id: "hls-widevine", label: "HLS + Widevine", priority: options.priority ?? 30 });
        this.schemaVersion = options.schemaVersion ?? 1;
        this.helpers = {
            serializeLicenseKeys: options.helpers?.serializeLicenseKeys,
            deriveOutputSlug: options.helpers?.deriveOutputSlug,
            quoteArg: options.helpers?.quoteArg
        };
    }

    /**
     * @description HLS かつ Widevine DRM が有効かを判定します。
     * @param {StrategyContext} context 判定対象のコンテキストです。
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
        if (!drmSystems.includes("WIDEVINE")) {
            return false;
        }
        const keys = this.extractKeys(context);
        return keys.length > 0;
    }

    /**
     * @description HLS + Widevine 向けのペイロードを生成します。
     * @param {StrategyContext} context 入力情報です。
     * @returns {object} ネイティブホスト用ペイロードです。
     */
    buildPayload(context) {
        const manifestUrl = (context?.manifest?.url || "").trim();
        if (!manifestUrl) {
            throw new Error("manifest url missing");
        }
        const keys = this.extractKeys(context);
        if (keys.length === 0) {
            throw new Error("Widevine 鍵が見つかりません");
        }
        const deriveOutputSlug = this.helpers.deriveOutputSlug || (() => "widevineproxy2");
        const slug = deriveOutputSlug(context?.log || {}, context.manifest) || `widevineproxy2-${Date.now()}`;
        const sourceUrl = context?.log?.url || manifestUrl;
        const cookies = this.buildCookieMetadata(context);
        const transport = this.buildTransportMetadata(context, { drmType: "WIDEVINE" });

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
     * @description HLS Widevine 用の CLI プレビューを生成します。
     * @param {object} payload ペイロードです。
     * @returns {string} コマンドプレビューです。
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
     * @description HLS かどうかを判定します。
     * @param {{url?: string, type?: string, details?: {type?: string}}} manifest 判定対象のマニフェストです。
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
     * @description ライブ/DRM 情報を含むトランスポートメタを生成します。
     * @param {StrategyContext} context 入力値です。
     * @param {{drmType?: string|null}} overrides 追加上書きです。
     * @returns {{manifestType: string, drmType: string|null, encryption: string, segmentFormat: string|null, notes: string}} トランスポート情報です。
     */
    buildTransportMetadata(context, overrides = {}) {
        const manifest = context?.manifest;
        const details = manifest?.details || {};
        const manifestType = (details.type || manifest?.type || "HLS").toUpperCase();
        const encryption = this.normalizeEncryption(details.encryption);
        const segmentFormat = details.segmentFormat || null;
        const notes = this.buildTransportNotes(details);
        return {
            manifestType,
            drmType: overrides.drmType || this.normalizeDrmSystems(details.drmSystems)[0] || "WIDEVINE",
            encryption,
            segmentFormat,
            notes
        };
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
     * @description マニフェスト解析ノートを文字列化します。
     * @param {object} details マニフェスト詳細です。
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
     * @description コンテキストから鍵を抽出してシリアライズします。
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
     * @description DRM 名の配列を正規化します。
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
     * @description 暗号名を正規化します。
     * @param {string|null|undefined} value 入力値です。
     * @returns {string} 正規化名です。
     */
    normalizeEncryption(value) {
        if (!value) {
            return "cenc";
        }
        return value.toString().toLowerCase();
    }

    /**
     * @description 引数をクォートする関数を取得します。
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
}
