/**
 * Agent 引擎 - Agent 创建、状态管理和生命周期控制
 * 模拟 Agent 思考与执行过程
 */
import { v4 as uuidv4 } from 'uuid';

/**
 * 状态枚举
 * @type {Object<string, string>}
 */
export const AGENT_STATES = {
    IDLE: 'idle',
    PLANNING: 'planning',
    EXECUTING: 'executing',
    WAITING: 'waiting',
    BLOCKED: 'blocked',
    REVIEWING: 'reviewing',
    COMPLETED: 'completed',
};

/**
 * 状态对应的中文标签
 */
export const STATE_LABELS = {
    idle: '空闲',
    planning: '规划中',
    executing: '执行中',
    waiting: '等待中',
    blocked: '阻塞',
    reviewing: '审核中',
    completed: '已完成',
};

/**
 * 状态对应的颜色
 */
export const STATE_COLORS = {
    idle: '#6B7280',
    planning: '#8B5CF6',
    executing: '#3B82F6',
    waiting: '#F59E0B',
    blocked: '#EF4444',
    reviewing: '#EC4899',
    completed: '#10B981',
};

/** 默认模型（空表示由用户自选） */
export const DEFAULT_MODEL = '';

/**
 * 创建 Agent 实例
 * @param {object} config
 * @returns {object} Agent 实例
 */
export function createAgent({ name, role, color = '#3B82F6', parentId = null, model = DEFAULT_MODEL }) {
    const agent = {
        id: uuidv4(),
        name,
        role,
        color,
        parentId,
        state: AGENT_STATES.IDLE,
        currentTask: '',
        currentSubtaskIndex: 0,
        subtasks: [],
        progress: 0,
        collaborators: [],
        messages: [],
        phase: '',
        dependencies: [],
        model,
        outputs: [],              // 各子任务的实质产出 [{subtask, content, source}]
        conversationHistory: [],   // 多轮对话上下文 [{role, content}]
        createdAt: new Date().toISOString(),
    };

    return agent;
}

/**
 * 生成 Agent 结构化输出消息
 * @param {object} agent - Agent 实例
 * @param {string[]} dialogue - 对话内容
 * @param {string[]} nextStep - 下一步计划
 * @returns {object} 结构化消息
 */
export function createStructuredMessage(agent, dialogue = [], nextStep = [], outputContent = null) {
    const msg = {
        role: agent.name,
        state: agent.state,
        current_task: agent.currentTask,
        progress: parseFloat(agent.progress.toFixed(2)),
        collaborators: [...agent.collaborators],
        dialogue,
        next_step: nextStep,
    };
    if (outputContent) {
        msg.outputContent = outputContent;  // 实质产出内容（Markdown）
    }
    return msg;
}

/**
 * Agent 对话生成器 - 模拟不同阶段的对话内容
 */
export const DIALOGUE_TEMPLATES = {
    taskReceived: (agentName, task) => [
        `【${agentName}】收到任务指派：${task}`,
        `正在分析任务要求，准备制定执行计划。`,
    ],
    planning: (agentName, subtasks) => [
        `【${agentName}】开始规划任务执行方案：`,
        ...subtasks.map((st, i) => `  ${i + 1}. ${st}`),
        `计划已制定完毕，准备启动执行。`,
    ],
    executing: (agentName, subtask, progress) => [
        `【${agentName}】正在执行：${subtask}`,
        `当前进度：${(progress * 100).toFixed(0)}%`,
    ],
    subtaskComplete: (agentName, subtask) => [
        `【${agentName}】✅ 子任务完成：${subtask}`,
    ],
    collaborating: (agentName, collaborator, topic) => [
        `【${agentName}】→ @${collaborator}：关于 ${topic}，需要协调配合。`,
    ],
    waiting: (agentName, dependency) => [
        `【${agentName}】⏳ 等待依赖：${dependency} 完成后继续推进。`,
    ],
    reviewing: (agentName) => [
        `【${agentName}】🔍 进入审核阶段，检查产出质量...`,
    ],
    completed: (agentName, task) => [
        `【${agentName}】🎉 任务完成：${task}`,
        `所有交付物已就绪，等待汇总。`,
    ],
};

export default {
    createAgent,
    createStructuredMessage,
    AGENT_STATES,
    STATE_LABELS,
    STATE_COLORS,
    DIALOGUE_TEMPLATES,
    DEFAULT_MODEL,
};
