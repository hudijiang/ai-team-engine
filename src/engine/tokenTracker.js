/**
 * Token 追踪器
 * 估算每次 LLM 调用的 Token 消耗，按 Agent/Provider 聚合统计
 */

const STORAGE_KEY = 'agent-auto-token-stats';

/** Token 估算：中文约 1.5 字/token，英文约 4 字/token */
function estimateTokens(text) {
    if (!text) return 0;
    let chineseChars = 0;
    let otherChars = 0;
    for (const ch of text) {
        if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
            chineseChars++;
        } else {
            otherChars++;
        }
    }
    return Math.ceil(chineseChars / 1.5) + Math.ceil(otherChars / 4);
}

/** 默认模型定价（每百万 token，美元）*/
const MODEL_PRICING = {
    'gpt-4': { input: 30, output: 60 },
    'gpt-4o': { input: 2.5, output: 10 },
    'gpt-5': { input: 5, output: 15 },
    'claude': { input: 3, output: 15 },
    'sonnet': { input: 3, output: 15 },
    'opus': { input: 15, output: 75 },
    'deepseek': { input: 0.27, output: 1.1 },
    'gemini': { input: 1.25, output: 5 },
    'qwen': { input: 1, output: 3 },
    'glm': { input: 1, output: 1 },
    'minimax': { input: 1, output: 1 },
    'default': { input: 2, output: 5 },
};

function getPricing(modelId) {
    const lower = (modelId || '').toLowerCase();
    for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
        if (key !== 'default' && lower.includes(key)) return pricing;
    }
    return MODEL_PRICING.default;
}

class TokenTracker {
    constructor() {
        this.records = [];
        this._loadFromStorage();
    }

    _loadFromStorage() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) this.records = JSON.parse(saved);
        } catch (_) { /* ignore */ }
    }

    _saveToStorage() {
        try {
            // 只保留最近 500 条
            const toSave = this.records.slice(-500);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
        } catch (_) { /* ignore */ }
    }

    /**
     * 记录一次 LLM 调用
     */
    record({ model, provider, agentName, inputText, outputText, durationMs }) {
        const inputTokens = estimateTokens(inputText);
        const outputTokens = estimateTokens(outputText);
        const pricing = getPricing(model);
        const costUSD = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

        const entry = {
            timestamp: new Date().toISOString(),
            model,
            provider: provider || 'unknown',
            agentName: agentName || 'unknown',
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            durationMs: durationMs || 0,
            costUSD: parseFloat(costUSD.toFixed(6)),
        };

        this.records.push(entry);
        this._saveToStorage();
        return entry;
    }

    /** 获取所有记录 */
    getRecords() { return this.records; }

    /** 获取汇总统计 */
    getSummary() {
        const totalTokens = this.records.reduce((s, r) => s + r.totalTokens, 0);
        const totalCost = this.records.reduce((s, r) => s + r.costUSD, 0);
        const totalCalls = this.records.length;

        // 按 Agent 聚合
        const byAgent = {};
        this.records.forEach(r => {
            if (!byAgent[r.agentName]) byAgent[r.agentName] = { tokens: 0, cost: 0, calls: 0 };
            byAgent[r.agentName].tokens += r.totalTokens;
            byAgent[r.agentName].cost += r.costUSD;
            byAgent[r.agentName].calls += 1;
        });

        // 按 Model 聚合
        const byModel = {};
        this.records.forEach(r => {
            if (!byModel[r.model]) byModel[r.model] = { tokens: 0, cost: 0, calls: 0 };
            byModel[r.model].tokens += r.totalTokens;
            byModel[r.model].cost += r.costUSD;
            byModel[r.model].calls += 1;
        });

        return { totalTokens, totalCost: parseFloat(totalCost.toFixed(4)), totalCalls, byAgent, byModel };
    }

    /** 清空记录 */
    clear() {
        this.records = [];
        this._saveToStorage();
    }
}

// 全局单例
const tokenTracker = new TokenTracker();
export default tokenTracker;
