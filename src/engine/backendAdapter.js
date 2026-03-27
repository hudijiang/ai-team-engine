/**
 * 后端服务适配器
 * 统一的存储/API 抽象层，支持浏览器本地缓存和远程后端两种模式
 */
import { createPersistentResource } from '../utils/persistentResource.js';
import { loadIndexedValue, saveIndexedValue, deleteIndexedValue } from '../utils/indexedDBStorage.js';

const CONFIG_KEY = 'agent-auto-backend-config';
const DEFAULT_CONFIG = { useBackend: false, backendUrl: '', apiKey: '' };
const backendConfigResource = createPersistentResource({
    storageKey: CONFIG_KEY,
    initialValue: () => ({ ...DEFAULT_CONFIG }),
    bootstrapSelector: (config) => ({
        useBackend: !!config?.useBackend,
        backendUrl: config?.backendUrl || '',
        apiKey: '',
    }),
});

function normalizeConfig(config = {}) {
    return {
        ...DEFAULT_CONFIG,
        ...config,
        useBackend: !!config?.useBackend,
        backendUrl: config?.backendUrl || '',
        apiKey: config?.apiKey || '',
    };
}

function readLegacyLocalCache(key) {
    try {
        const saved = localStorage.getItem(key);
        if (!saved) return null;
        return JSON.parse(saved);
    } catch (_) {
        return null;
    }
}

/**
 * 加载后端配置
 */
export function loadConfig() {
    return normalizeConfig(backendConfigResource.get());
}

export async function ensureConfigHydrated() {
    const hydrated = await backendConfigResource.hydrate();
    const normalized = normalizeConfig(hydrated);
    backendConfigResource.set(normalized);
    return normalized;
}

export function saveConfig(config) {
    backendConfigResource.set(normalizeConfig(config));
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
        const config = await ensureConfigHydrated();
        if (config.useBackend) {
            try {
                const res = await fetch(`${config.backendUrl}/api/storage/${key}`, {
                    headers: { 'Authorization': `Bearer ${config.apiKey}` },
                });
                if (res.ok) return await res.json();
            } catch (e) {
                console.warn('后端读取失败，降级到本地缓存:', e.message);
            }
        }
        const cached = await loadIndexedValue(key);
        if (cached !== null && cached !== undefined) {
            return cached;
        }

        const legacy = readLegacyLocalCache(key);
        if (legacy !== null && legacy !== undefined) {
            const saved = await saveIndexedValue(key, legacy);
            if (saved) {
                try {
                    localStorage.removeItem(key);
                } catch (_) { /* ignore */ }
            }
            return legacy;
        }

        return null;
    },

    async set(key, value) {
        const config = await ensureConfigHydrated();
        await saveIndexedValue(key, value);
        try {
            localStorage.removeItem(key);
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
        await deleteIndexedValue(key);
        try {
            localStorage.removeItem(key);
        } catch (_) { /* ignore */ }

        const config = await ensureConfigHydrated();
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

export default { loadConfig, ensureConfigHydrated, saveConfig, isBackendMode, storage, BACKEND_API_SPEC };
