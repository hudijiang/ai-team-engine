/**
 * Agent 性能评估追踪器
 * 追踪每个 Agent 的执行指标并计算评分
 */

const STORAGE_KEY = 'agent-auto-performance';

class PerformanceTracker {
    constructor() {
        this.records = [];
        this._load();
    }

    _load() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) this.records = JSON.parse(saved);
        } catch (_) { /* ignore */ }
    }

    _save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.records.slice(-300)));
        } catch (_) { /* ignore */ }
    }

    /**
     * 记录一次 Agent 执行
     */
    record({ agentName, taskName, durationMs, tokenCount, outputLength, qaResult, sessionId }) {
        this.records.push({
            timestamp: new Date().toISOString(),
            agentName,
            taskName,
            durationMs: durationMs || 0,
            tokenCount: tokenCount || 0,
            outputLength: outputLength || 0,
            qaResult: qaResult || 'pass',  // 'pass' | 'revise'
            sessionId: sessionId || '',
        });
        this._save();
    }

    /**
     * 获取 Agent 评分（0-100）
     */
    getAgentScore(agentName) {
        const agentRecords = this.records.filter(r => r.agentName === agentName);
        if (agentRecords.length === 0) return null;

        // 评分维度
        const passRate = agentRecords.filter(r => r.qaResult === 'pass').length / agentRecords.length;
        const avgDuration = agentRecords.reduce((s, r) => s + r.durationMs, 0) / agentRecords.length;
        const avgOutput = agentRecords.reduce((s, r) => s + r.outputLength, 0) / agentRecords.length;

        // 加权评分
        let score = 0;
        score += passRate * 50;                        // QA 通过率 50%
        score += Math.min(avgOutput / 500, 1) * 25;    // 产出长度 25%
        score += Math.max(0, 1 - avgDuration / 30000) * 25; // 响应速度 25%

        return Math.round(Math.min(100, Math.max(0, score)));
    }

    /**
     * 获取所有 Agent 的评估汇总
     */
    getSummary() {
        const agentNames = [...new Set(this.records.map(r => r.agentName))];
        return agentNames.map(name => {
            const records = this.records.filter(r => r.agentName === name);
            const passRate = records.filter(r => r.qaResult === 'pass').length / records.length;
            const avgDuration = records.reduce((s, r) => s + r.durationMs, 0) / records.length;
            const totalTokens = records.reduce((s, r) => s + r.tokenCount, 0);
            return {
                agentName: name,
                taskCount: records.length,
                passRate: parseFloat((passRate * 100).toFixed(1)),
                avgDurationMs: Math.round(avgDuration),
                totalTokens,
                score: this.getAgentScore(name),
            };
        }).sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    /** 清空 */
    clear() {
        this.records = [];
        this._save();
    }
}

const performanceTracker = new PerformanceTracker();
export default performanceTracker;
