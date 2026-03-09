/**
 * Agent 记忆模块
 * 为每个 Agent 提供跨会话的持久化记忆
 * 存储历史任务经验摘要，用于注入后续 LLM prompt
 */

const STORAGE_KEY = 'agent-auto-memories';
const MAX_MEMORIES_PER_AGENT = 5;

/**
 * 加载所有 Agent 记忆
 */
function loadAllMemories() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) return JSON.parse(saved);
    } catch (_) { /* ignore */ }
    return {};
}

/**
 * 保存所有 Agent 记忆
 */
function saveAllMemories(memories) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(memories));
    } catch (_) { /* ignore */ }
}

/**
 * 获取指定 Agent 的历史记忆
 * @param {string} agentName - Agent 名称
 * @returns {Array<{task: string, experience: string, timestamp: string}>}
 */
export function loadMemory(agentName) {
    const all = loadAllMemories();
    return all[agentName] || [];
}

/**
 * 保存 Agent 的一条经验记忆
 * @param {string} agentName
 * @param {string} task - 任务描述
 * @param {string} experience - 经验摘要
 */
export function saveMemory(agentName, task, experience) {
    const all = loadAllMemories();
    if (!all[agentName]) all[agentName] = [];

    all[agentName].push({
        task,
        experience,
        timestamp: new Date().toISOString(),
    });

    // 只保留最近 N 条
    if (all[agentName].length > MAX_MEMORIES_PER_AGENT) {
        all[agentName] = all[agentName].slice(-MAX_MEMORIES_PER_AGENT);
    }

    saveAllMemories(all);
}

/**
 * 将 Agent 记忆格式化为 prompt 上下文
 * @param {string} agentName
 * @returns {string} 可注入 prompt 的记忆上下文
 */
export function formatMemoryContext(agentName) {
    const memories = loadMemory(agentName);
    if (memories.length === 0) return '';

    const lines = memories.map((m, i) =>
        `${i + 1}. [${new Date(m.timestamp).toLocaleDateString('zh-CN')}] 任务：${m.task}\n   经验：${m.experience}`
    );

    return `\n### 历史经验记忆\n以下是你之前执行类似任务时积累的经验，请参考：\n${lines.join('\n')}\n`;
}

/**
 * 清除指定 Agent 的记忆
 */
export function clearMemory(agentName) {
    const all = loadAllMemories();
    delete all[agentName];
    saveAllMemories(all);
}

/**
 * 获取所有 Agent 的记忆概览
 */
export function getAllMemoryStats() {
    const all = loadAllMemories();
    return Object.entries(all).map(([name, memories]) => ({
        agentName: name,
        count: memories.length,
        lastUpdated: memories.length > 0 ? memories[memories.length - 1].timestamp : null,
    }));
}

export default { loadMemory, saveMemory, formatMemoryContext, clearMemory, getAllMemoryStats };
