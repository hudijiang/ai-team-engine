/**
 * 后端服务适配器
 * 统一的存储/API 抽象层，支持 localStorage（前端模式）和远程后端两种模式
 */

const CONFIG_KEY = 'agent-auto-backend-config';

/**
 * 加载后端配置
 */
function loadConfig() {
    try {
        const saved = localStorage.getItem(CONFIG_KEY);
        if (saved) return JSON.parse(saved);
    } catch (_) { /* ignore */ }
    return { useBackend: false, backendUrl: '', apiKey: '' };
}

export function saveConfig(config) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

/**
 * 判断是否使用后端模式
 */
export function isBackendMode() {
    return loadConfig().useBackend;
}

/**
 * 统一的存储接口
 */
export const storage = {
    async get(key) {
        const config = loadConfig();
        if (config.useBackend) {
            try {
                const res = await fetch(`${config.backendUrl}/api/storage/${key}`, {
                    headers: { 'Authorization': `Bearer ${config.apiKey}` },
                });
                if (res.ok) return await res.json();
            } catch (e) {
                console.warn('后端读取失败，降级到 localStorage:', e.message);
            }
        }
        // 降级到 localStorage
        try {
            const data = localStorage.getItem(key);
            return data ? JSON.parse(data) : null;
        } catch (_) { return null; }
    },

    async set(key, value) {
        const config = loadConfig();
        // 始终写入 localStorage（作为缓存）
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (_) { /* ignore */ }

        if (config.useBackend) {
            try {
                await fetch(`${config.backendUrl}/api/storage/${key}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${config.apiKey}`,
                    },
                    body: JSON.stringify(value),
                });
            } catch (e) {
                console.warn('后端写入失败:', e.message);
            }
        }
    },

    async delete(key) {
        localStorage.removeItem(key);
        const config = loadConfig();
        if (config.useBackend) {
            try {
                await fetch(`${config.backendUrl}/api/storage/${key}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${config.apiKey}` },
                });
            } catch (_) { /* ignore */ }
        }
    },
};

/**
 * 后端 API 接口规范
 */
export const BACKEND_API_SPEC = {
    storage: {
        'GET /api/storage/:key': '读取键值存储',
        'PUT /api/storage/:key': '写入键值存储',
        'DELETE /api/storage/:key': '删除键值存储',
    },
    tasks: {
        'GET /api/tasks': '获取任务列表',
        'POST /api/tasks': '创建任务',
        'PUT /api/tasks/:id': '更新任务状态',
    },
    webhook: {
        'POST /api/webhooks': '注册 Webhook',
        'POST /api/webhooks/:id/trigger': '触发 Webhook 通知',
    },
    schedule: {
        'POST /api/schedules': '创建定时任务',
        'DELETE /api/schedules/:id': '删除定时任务',
    },
};

export default { loadConfig: () => loadConfig(), saveConfig, isBackendMode, storage, BACKEND_API_SPEC };
