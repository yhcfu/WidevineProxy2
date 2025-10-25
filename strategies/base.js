/**
 * @typedef {object} StrategyContext
 * @property {string} clientJobId クライアント側で生成したジョブIDです。
 * @property {object|null} manifest 抽出したマニフェスト情報です。
 * @property {object|null} log Widevineログや解析メタデータです。
 * @property {Array<object>|null} log.keys 抽出済みの鍵配列です。
 * @property {object|null} headers マニフェスト取得時のヘッダー群です。
 * @property {"browser"|"netscape"|string|null} cookieStrategy Cookie取得方式です。
 * @property {string|null} cookieProfile Cookie取得対象プロファイルです。
 * @property {string|null} outputDir 出力ディレクトリの希望値です。
 */

/**
 * @description ダウンロード処理の個別戦略を表す基底クラスです。
 */
export class DownloadStrategy {
    /**
     * @param {{id: string, label?: string, priority?: number}} options ストラテジーの初期化オプションです。
     */
    constructor({ id, label = "", priority = 100 } = {}) {
        if (!id) {
            throw new Error("strategy id is required");
        }
        this.id = id;
        this.label = label || id;
        this.priority = priority;
    }

    /**
     * @description 与えられたコンテキストを処理可能かを判定します。
     * @param {StrategyContext} _context 判定対象のコンテキストです。
     * @returns {boolean} 対応可能なら true。
     */
    canHandle(_context) {
        return false;
    }

    /**
     * @description ネイティブホストへ送るペイロードを生成します。
     * @param {StrategyContext} _context 入力パラメータ一式です。
     * @returns {object} 生成されたペイロードです。
     */
    buildPayload(_context) {
        throw new Error("buildPayload must be implemented by subclasses");
    }

    /**
     * @description CLIプレビュー文字列を生成します。
     * @param {object} _payload 生成済みペイロードです。
     * @param {StrategyContext} _context ペイロード生成時のコンテキストです。
     * @returns {string} CLIでの実行例です。
     */
    buildCommandPreview(_payload, _context) {
        return "";
    }
}
