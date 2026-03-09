/**
 * 多人协作管理器
 * 前端抽象层：定义多工作区和角色隔离的数据结构
 * 真正的实时同步需要后端 WebSocket 支持
 */

const STORAGE_KEY = 'agent-auto-workspaces';

/**
 * 工作区定义
 * {
 *   id: string,
 *   name: string,
 *   ownerId: string,
 *   objective: string,
 *   agents: Agent[],
 *   createdAt: string
 * }
 */

/**
 * 加载所有工作区
 */
export function loadWorkspaces() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved ? JSON.parse(saved) : [];
    } catch (_) { return []; }
}

export function saveWorkspaces(workspaces) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces));
}

/**
 * 创建新工作区
 */
export function createWorkspace(name, ownerId = 'default') {
    const workspaces = loadWorkspaces();
    const workspace = {
        id: `ws-${Date.now()}`,
        name,
        ownerId,
        objective: '',
        agents: [],
        createdAt: new Date().toISOString(),
    };
    workspaces.push(workspace);
    saveWorkspaces(workspaces);
    return workspace;
}

/**
 * 删除工作区
 */
export function removeWorkspace(wsId) {
    const workspaces = loadWorkspaces().filter(w => w.id !== wsId);
    saveWorkspaces(workspaces);
}

/**
 * 更新工作区
 */
export function updateWorkspace(wsId, updates) {
    const workspaces = loadWorkspaces();
    const idx = workspaces.findIndex(w => w.id === wsId);
    if (idx >= 0) {
        workspaces[idx] = { ...workspaces[idx], ...updates };
        saveWorkspaces(workspaces);
    }
}

/**
 * 后端同步接口规范（文档用途，后端实现后调用）
 */
export const SYNC_API_SPEC = {
    /** WebSocket 连接 */
    ws: 'ws://[host]/sync',
    /** REST 接口 */
    endpoints: {
        'GET /api/workspaces': '获取用户的所有工作区',
        'POST /api/workspaces': '创建新工作区',
        'PUT /api/workspaces/:id': '更新工作区',
        'DELETE /api/workspaces/:id': '删除工作区',
        'POST /api/workspaces/:id/join': '加入工作区',
        'GET /api/workspaces/:id/agents': '获取工作区的 Agent 列表',
    },
    /** WebSocket 消息类型 */
    wsMessages: {
        'agent:update': '同步 Agent 状态变化',
        'message:new': '同步新消息',
        'workspace:objective': '同步目标变更',
        'cursor:move': '同步用户光标位置',
    },
};

export default { loadWorkspaces, saveWorkspaces, createWorkspace, removeWorkspace, updateWorkspace, SYNC_API_SPEC };
