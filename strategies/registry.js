import { DownloadStrategy } from "./base.js";

/**
 * @description ストラテジーを優先度付きで管理するレジストリです。
 */
export class DownloadStrategyRegistry {
    /**
     * @param {Array<DownloadStrategy>} strategies 事前登録するストラテジー配列です。
     */
    constructor(strategies = []) {
        this.strategies = [];
        this.strategyMap = new Map();
        strategies.forEach((strategy) => this.register(strategy));
    }

    /**
     * @description ストラテジーをレジストリへ登録します。
     * @param {DownloadStrategy} strategy 追加対象のストラテジーです。
     * @returns {void}
     */
    register(strategy) {
        if (!(strategy instanceof DownloadStrategy)) {
            throw new Error("strategy must extend DownloadStrategy");
        }
        if (this.strategyMap.has(strategy.id)) {
            throw new Error(`strategy with id ${strategy.id} already registered`);
        }
        this.strategies.push(strategy);
        this.strategyMap.set(strategy.id, strategy);
        this.strategies.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    }

    /**
     * @description 条件に合致するストラテジーを解決します。
     * @param {import("./base.js").StrategyContext} context 判定対象のコンテキストです。
     * @returns {DownloadStrategy|null} 該当があればストラテジーを返します。
     */
    resolve(context) {
        for (const strategy of this.strategies) {
            try {
                if (strategy.canHandle(context)) {
                    return strategy;
                }
            } catch (error) {
                console.warn("[DownloadStrategyRegistry] canHandle failed", strategy.id, error);
            }
        }
        return null;
    }

    /**
     * @description ID でストラテジーを取得します。
     * @param {string} id 取得したいストラテジーIDです。
     * @returns {DownloadStrategy|null} 見つかれば該当ストラテジーです。
     */
    getById(id) {
        if (!id) {
            return null;
        }
        return this.strategyMap.get(id) || null;
    }

    /**
     * @description 登録済みストラテジー一覧を返します。
     * @returns {Array<DownloadStrategy>} 現在の登録状況です。
     */
    list() {
        return [...this.strategies];
    }
}
