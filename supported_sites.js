const SUPPORTED_SITE_DATA_PATH = "data/yt_dlp_supported_hosts.json";

let ytDlpSiteDataPromise = null;
let ytDlpSiteData = null;

/**
 * @description yt-dlp 対応サイト情報を読み込みキャッシュします。
 * @returns {Promise<{hostSet: Set<string>, tokenSet: Set<string>}>} 読み込み済みデータです。
 */
async function ensureYtDlpSiteData() {
    if (ytDlpSiteData) {
        return ytDlpSiteData;
    }
    if (!ytDlpSiteDataPromise) {
        ytDlpSiteDataPromise = (async () => {
            try {
                const response = await fetch(chrome.runtime.getURL(SUPPORTED_SITE_DATA_PATH));
                if (!response.ok) {
                    throw new Error(`failed to load supported sites (${response.status})`);
                }
                const json = await response.json();
                const hostSet = new Set((json?.hostnames || []).map((entry) => entry.toLowerCase()));
                const tokenSet = new Set((json?.tokens || []).map((entry) => entry.toLowerCase()));
                ytDlpSiteData = { hostSet, tokenSet };
                return ytDlpSiteData;
            } catch (error) {
                console.warn("[WidevineProxy2] yt-dlp supported site load failed", error);
                ytDlpSiteDataPromise = null;
                throw error;
            }
        })();
    }
    return ytDlpSiteDataPromise;
}

/**
 * @description URL が yt-dlp 対応サイトかどうかを判定します。
 * @param {string|null} url 判定したい URL です。
 * @returns {Promise<boolean>} 対応サイトなら true。
 */
export async function isUrlSupportedByYtDlp(url) {
    if (!url || typeof url !== "string") {
        return false;
    }
    let host = "";
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }
    if (!host) {
        return false;
    }
    const baseHost = host.replace(/^www\./, "");
    try {
        const data = await ensureYtDlpSiteData();
        if (data.hostSet.has(host) || data.hostSet.has(baseHost)) {
            return true;
        }
        for (const token of data.tokenSet) {
            if (!token) {
                continue;
            }
            if (baseHost.includes(token)) {
                return true;
            }
        }
    } catch {
        // ロードに失敗した場合は非対応扱いにする。
    }
    return false;
}
