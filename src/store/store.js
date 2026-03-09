/**
 * Zustand 全局状态管理
 * 管理 Agents、消息、系统状态
 */
import { create } from 'zustand';
import { createAgent, AGENT_STATES } from '../engine/agentEngine';
import logger from '../utils/logger';

const STORAGE_KEY = 'agent-auto-state';

/**
 * 状态 Reducer
 */
function agentReducer(state, action) {
    switch (action.type) {
        case 'ADD_AGENT':
            return { ...state, agents: [...state.agents, action.payload] };

        case 'UPDATE_AGENT': {
            const { id, ...updates } = action.payload;
            return {
                ...state,
                agents: state.agents.map(agent =>
                    agent.id === id ? { ...agent, ...updates } : agent
                ),
            };
        }

        case 'UPDATE_AGENT_MODEL': {
            const { id, model } = action.payload;
            return {
                ...state,
                agents: state.agents.map(agent =>
                    agent.id === id ? { ...agent, model } : agent
                ),
            };
        }

        case 'REMOVE_AGENT':
            return {
                ...state,
                agents: state.agents.filter(a => a.id !== action.payload),
            };

        case 'ADD_MESSAGE':
            return {
                ...state,
                messages: [...state.messages, action.payload],
            };

        case 'UPSERT_MESSAGE': {
            const { clientId } = action.payload || {};
            if (!clientId) {
                return { ...state, messages: [...state.messages, action.payload] };
            }
            const idx = state.messages.findIndex(m => m.clientId === clientId);
            if (idx === -1) {
                return { ...state, messages: [...state.messages, action.payload] };
            }
            const next = [...state.messages];
            next[idx] = { ...next[idx], ...action.payload };
            return { ...state, messages: next };
        }

        case 'SET_OBJECTIVE': {
            const dateStr = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15); // 20260303T093601
            const prefix = action.payload.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '').slice(0, 20);
            const sessionId = `${prefix}_${dateStr}`;
            return {
                ...state,
                currentObjective: action.payload,
                systemStatus: 'running',
                currentSessionId: sessionId,
            };
        }

        case 'SET_STATUS':
            return { ...state, systemStatus: action.payload };

        case 'SET_DECOMPOSITION':
            return { ...state, decomposition: action.payload };

        case 'ADD_LOG':
            return {
                ...state,
                systemLog: [...state.systemLog, {
                    timestamp: new Date().toISOString(),
                    ...action.payload,
                }],
            };

        case 'SET_PROVIDER_MODELS': {
            const { providerId, models } = action.payload;
            const newModels = { ...state.availableModels };
            newModels[providerId] = models;
            return { ...state, availableModels: newModels };
        }

        case 'ADD_DELIVERABLE': {
            return {
                ...state,
                deliverables: [...state.deliverables, action.payload],
            };
        }

        case 'CLEAR_DELIVERABLES': {
            return { ...state, deliverables: [] };
        }

        case 'SET_PENDING_DECISION': {
            return { ...state, pendingDecision: action.payload };
        }

        case 'RESOLVE_DECISION': {
            return { ...state, pendingDecision: null };
        }

        case 'UPDATE_AGENT_OUTPUTS': {
            const { id, output } = action.payload;
            return {
                ...state,
                agents: state.agents.map(a =>
                    a.id === id
                        ? { ...a, outputs: [...a.outputs, output] }
                        : a
                ),
            };
        }

        case 'UPDATE_AGENT_HISTORY': {
            const { id: agentId, entry } = action.payload;
            return {
                ...state,
                agents: state.agents.map(a =>
                    a.id === agentId
                        ? { ...a, conversationHistory: [...a.conversationHistory, entry] }
                        : a
                ),
            };
        }

        case 'ADD_INBOX': {
            return {
                ...state,
                inbox: [...state.inbox, action.payload],
            };
        }

        case 'CLEAR_INBOX': {
            return { ...state, inbox: [] };
        }

        case 'MARK_INBOX_READ': {
            const { index } = action.payload;
            const next = state.inbox.map((item, i) => i === index ? { ...item, read: true } : item);
            return { ...state, inbox: next };
        }

        case 'RESET': {
            // 归档当前会话的完整快照（消息+Agent+分解+交付物）
            const archived = state.messages.length > 0
                ? [{
                    sessionId: state.currentSessionId || 'unknown',
                    objective: state.currentObjective || '',
                    timestamp: new Date().toISOString(),
                    messages: state.messages,
                    agents: state.agents,
                    decomposition: state.decomposition,
                    deliverables: state.deliverables,
                }]
                : [];
            const init = getInitialState();
            init.sessionHistory = [...(state.sessionHistory || []), ...archived];
            init.availableModels = state.availableModels;
            return init;
        }

        case 'RESTORE_SESSION': {
            const targetId = action.payload; // sessionId
            const history = state.sessionHistory || [];
            const target = history.find(s => s.sessionId === targetId);
            if (!target) return state;

            // 先归档当前会话（如果有消息）
            const currentArchive = state.messages.length > 0
                ? [{
                    sessionId: state.currentSessionId || 'unknown',
                    objective: state.currentObjective || '',
                    timestamp: new Date().toISOString(),
                    messages: state.messages,
                    agents: state.agents,
                    decomposition: state.decomposition,
                    deliverables: state.deliverables,
                }]
                : [];

            // 从历史中移除被恢复的会话（避免重复）
            const remainingHistory = history.filter(s => s.sessionId !== targetId);

            return {
                ...state,
                messages: target.messages || [],
                agents: target.agents || state.agents,
                decomposition: target.decomposition || null,
                deliverables: target.deliverables || [],
                currentObjective: target.objective || '',
                currentSessionId: target.sessionId,
                systemStatus: 'completed',
                pendingDecision: null,
                systemLog: [],
                sessionHistory: [...remainingHistory, ...currentArchive],
            };
        }

        case 'CLEAR_HISTORY': {
            return { ...state, sessionHistory: [] };
        }

        case 'ADD_PROMPT_LOG': {
            // 保留最近 200 条
            const logs = [...state.promptLogs, action.payload].slice(-200);
            return { ...state, promptLogs: logs };
        }

        case 'CLEAR_PROMPT_LOGS': {
            return { ...state, promptLogs: [] };
        }

        default:
            return state;
    }
}

/**
 * 序列化可持久化的状态片段
 */
function pickPersistable(state) {
    return {
        agents: state.agents,
        messages: state.messages,
        inbox: state.inbox,
        deliverables: state.deliverables,
        pendingDecision: state.pendingDecision,
        currentObjective: state.currentObjective,
        currentSessionId: state.currentSessionId,
        sessionHistory: state.sessionHistory,
        systemStatus: state.systemStatus,
        decomposition: state.decomposition,
        systemLog: state.systemLog,
        selectedAgentId: state.selectedAgentId,
        availableModels: state.availableModels,
        promptLogs: (state.promptLogs || []).slice(-50),
    };
}

function saveState(state) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(pickPersistable(state)));
    } catch (e) {
        console.warn('保存状态失败:', e);
    }
}

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) {
        console.warn('加载状态失败:', e);
    }
    return null;
}

function getInitialState() {
    // 创建默认 CEO Agent
    const ceoAgent = createAgent({
        name: 'CEO',
        role: '首席执行官 - 负责分析董事长需求、拆解任务、创建团队、协调执行',
        color: '#F59E0B',
        model: 'claude-ops-4.6-thinking',
    });
    ceoAgent.state = AGENT_STATES.IDLE;
    ceoAgent.currentTask = '等待董事长指令';

    return {
        agents: [ceoAgent],
        messages: [],
        inbox: [],
        deliverables: [],
        pendingDecision: null,
        currentObjective: '',
        currentSessionId: null,
        sessionHistory: [],
        systemStatus: 'idle',
        decomposition: null,
        systemLog: [],
        selectedAgentId: null,
        availableModels: {},
        promptLogs: [],
    };
}

export const useStore = create((set, get) => ({
    ...(loadState() || getInitialState()),

    /**
     * 分发 action
     */
    dispatch: (action) => {
        set(state => {
            const next = agentReducer(state, action);
            saveState(next);
            // 关键 action 写入日志
            if (['SET_OBJECTIVE', 'SET_STATUS', 'SET_PENDING_DECISION', 'RESOLVE_DECISION', 'ADD_DELIVERABLE', 'RESET'].includes(action.type)) {
                logger.info('Store', `${action.type}${action.payload ? ': ' + (typeof action.payload === 'string' ? action.payload : JSON.stringify(action.payload).slice(0, 200)) : ''}`);
            }
            return next;
        });
    },

    /**
     * 获取当前状态（用于 CEOAgentRunner）
     */
    getSnapshot: () => get(),

    /**
     * 选中某个 Agent 查看详情
     */
    selectAgent: (agentId) => set({ selectedAgentId: agentId }),

    /**
     * 重置系统
     */
    reset: () => set(() => {
        const init = getInitialState();
        saveState(init);
        return init;
    }),
}));

export default useStore;
