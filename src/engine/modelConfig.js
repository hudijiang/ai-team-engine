/**
 * 模型 API 配置管理
 * 管理各供应商的 API URL 和 API Key
 * 支持通过 API 动态获取可用模型列表
 * 使用本地 bootstrap + IndexedDB 完整持久化
 */
import { createPersistentResource } from '../utils/persistentResource.js';

/** localStorage 存储键 */
const STORAGE_KEY = 'agent-auto-provider-configs';
const MODELS_CACHE_KEY = 'agent-auto-models-cache';

/**
 * 供应商默认配置
 */
/**
 * 供应商清单
 * chatAdapter: 实际对话适配器 id（见 llmClient）
 * verified: 是否经过本仓库契约验证
 */
export const PROVIDERS = [
    {
        id: 'openai',
        name: 'OpenAI',
        icon: '🟢',
        defaultApiUrl: 'https://api.openai.com/v1',
        modelsPath: '/models',
        placeholder: 'sk-...',
        chatAdapter: 'openai',
        verified: true,
        note: '官方 OpenAI Chat Completions',
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        icon: '🟠',
        defaultApiUrl: 'https://api.anthropic.com/v1',
        modelsPath: '/models',
        placeholder: 'sk-ant-...',
        chatAdapter: 'anthropic',
        verified: true,
        note: 'Messages API 适配',
    },
    {
        id: 'deepseek',
        name: 'DeepSeek',
        icon: '🟣',
        defaultApiUrl: 'https://api.deepseek.com/v1',
        modelsPath: '/models',
        placeholder: 'sk-...',
        chatAdapter: 'openai',
        verified: true,
        note: 'OpenAI 兼容模式',
    },
    {
        id: 'alibaba',
        name: 'Alibaba (Qwen 兼容模式)',
        icon: '🔴',
        defaultApiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        modelsPath: '/models',
        placeholder: 'sk-...',
        chatAdapter: 'openai',
        verified: true,
        note: '仅兼容模式 endpoint',
    },
    {
        id: 'zhipu',
        name: '智谱AI (GLM 兼容)',
        icon: '🔶',
        defaultApiUrl: 'https://open.bigmodel.cn/api/paas/v4',
        modelsPath: '/models',
        placeholder: '...',
        chatAdapter: 'openai',
        verified: true,
        note: 'OpenAI 兼容风格',
    },
    {
        id: 'custom',
        name: '自定义 (OpenAI 兼容)',
        icon: '⚙️',
        defaultApiUrl: '',
        modelsPath: '/models',
        placeholder: 'sk-...',
        chatAdapter: 'openai',
        verified: true,
        note: '任意 OpenAI 兼容网关',
    },
    // 以下未经验证原生协议，保留为实验项（UI 会标注）
    {
        id: 'google',
        name: 'Google (实验·需兼容代理)',
        icon: '🔵',
        defaultApiUrl: 'https://generativelanguage.googleapis.com/v1beta',
        modelsPath: '/models',
        placeholder: 'AIza...',
        chatAdapter: 'openai',
        verified: false,
        note: '原生 Gemini 协议未实现；仅当你的网关提供 OpenAI 兼容层时可用',
    },
    {
        id: 'minimax',
        name: 'MiniMax (实验·需兼容代理)',
        icon: '🟡',
        defaultApiUrl: 'https://api.minimax.chat/v1',
        modelsPath: '/models',
        placeholder: 'eyJ...',
        chatAdapter: 'openai',
        verified: false,
        note: '未做原生协议验证，依赖 OpenAI 兼容',
    },
];

function buildDefaultProviderConfigs() {
    const defaults = {};
    PROVIDERS.forEach(p => {
        defaults[p.id] = {
            apiUrl: p.defaultApiUrl,
            apiKey: '',
            enabled: false,
        };
    });
    return defaults;
}

function mergeProviderConfigs(raw = {}) {
    const defaults = buildDefaultProviderConfigs();
    const merged = {};
    PROVIDERS.forEach(p => {
        merged[p.id] = {
            ...defaults[p.id],
            ...(raw[p.id] || {}),
        };
    });
    return merged;
}

function stripApiKeys(configs = {}) {
    const sanitized = {};
    PROVIDERS.forEach(p => {
        const current = configs[p.id] || {};
        sanitized[p.id] = {
            apiUrl: current.apiUrl || p.defaultApiUrl,
            apiKey: '',
            enabled: !!current.enabled,
        };
    });
    return sanitized;
}

const providerConfigResource = createPersistentResource({
    storageKey: STORAGE_KEY,
    initialValue: buildDefaultProviderConfigs,
    bootstrapSelector: stripApiKeys,
});

const modelsCacheResource = createPersistentResource({
    storageKey: MODELS_CACHE_KEY,
    initialValue: () => ({}),
});

/**
 * 从本地缓存加载供应商配置
 * @returns {Object<string, {apiUrl: string, apiKey: string}>}
 */
export function loadProviderConfigs() {
    return mergeProviderConfigs(providerConfigResource.get());
}

export async function ensureProviderConfigsHydrated() {
    const hydrated = await providerConfigResource.hydrate();
    const merged = mergeProviderConfigs(hydrated);
    providerConfigResource.set(merged);
    return merged;
}

/**
 * 保存供应商配置
 * @param {Object} configs
 */
export function saveProviderConfigs(configs) {
    providerConfigResource.set(mergeProviderConfigs(configs));
}

/**
 * 从本地缓存加载模型缓存
 */
export function loadModelsCache() {
    return modelsCacheResource.get() || {};
}

export async function ensureModelsCacheHydrated() {
    const hydrated = await modelsCacheResource.hydrate();
    modelsCacheResource.set(hydrated || {});
    return modelsCacheResource.get() || {};
}

/**
 * 保存模型缓存
 */
export function saveModelsCache(cache) {
    modelsCacheResource.set(cache || {});
}

/**
 * 通过 API 获取模型列表（OpenAI 兼容格式）
 * @param {string} apiUrl - API 基础 URL
 * @param {string} apiKey - API Key
 * @param {string} providerId - 供应商 ID
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function fetchModelsFromAPI(apiUrl, apiKey, providerId) {
    if (!apiUrl || !apiKey) return [];

    const provider = PROVIDERS.find(p => p.id === providerId);
    const modelsPath = provider?.modelsPath || '/models';
    const url = `${apiUrl.replace(/\/+$/, '')}${modelsPath}`;

    try {
        const headers = {
            'Authorization': `Bearer ${apiKey}`,
        };

        // Anthropic 使用不同的 header
        if (providerId === 'anthropic') {
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2024-01-01';
            delete headers['Authorization'];
        }

        const response = await fetch(url, {
            method: 'GET',
            headers,
        });

        if (!response.ok) {
            console.warn(`获取 ${providerId} 模型列表失败:`, response.status);
            return [];
        }

        const data = await response.json();

        // OpenAI 兼容格式: { data: [{ id: "..." }, ...] }
        if (data.data && Array.isArray(data.data)) {
            return data.data
                .map(m => ({
                    id: m.id,
                    name: m.id,
                    provider: providerId,
                }))
                .sort((a, b) => a.id.localeCompare(b.id));
        }

        // Google 格式: { models: [{ name: "models/..." }, ...] }
        if (data.models && Array.isArray(data.models)) {
            return data.models
                .map(m => ({
                    id: m.name?.replace('models/', '') || m.name,
                    name: m.displayName || m.name?.replace('models/', '') || m.name,
                    provider: providerId,
                }))
                .sort((a, b) => a.id.localeCompare(b.id));
        }

        return [];
    } catch (err) {
        console.warn(`获取 ${providerId} 模型列表异常:`, err.message);
        return [];
    }
}

/**
 * 获取所有已配置供应商的模型列表（合并）
 * @returns {Promise<Array<{id: string, name: string, provider: string, icon: string}>>}
 */
export async function fetchAllModels() {
    const configs = await ensureProviderConfigsHydrated();
    const allModels = [];

    for (const provider of PROVIDERS) {
        const config = configs[provider.id];
        if (!config?.apiUrl || !config?.apiKey) continue;

        try {
            const models = await fetchModelsFromAPI(config.apiUrl, config.apiKey, provider.id);
            models.forEach(m => {
                allModels.push({
                    ...m,
                    icon: provider.icon,
                    providerName: provider.name,
                });
            });
        } catch (e) {
            // 忽略单个供应商的错误
        }
    }

    // 缓存结果
    if (allModels.length > 0) {
        saveModelsCache({
            models: allModels,
            timestamp: Date.now(),
        });
    }

    return allModels;
}

/**
 * 获取模型列表（优先使用缓存，5分钟过期）
 * @returns {Array}
 */
export function getCachedModels() {
    const cache = loadModelsCache();
    if (cache.models && Date.now() - cache.timestamp < 5 * 60 * 1000) {
        return cache.models;
    }
    return cache.models || [];
}

export default {
    PROVIDERS,
    loadProviderConfigs,
    ensureProviderConfigsHydrated,
    saveProviderConfigs,
    loadModelsCache,
    ensureModelsCacheHydrated,
    saveModelsCache,
    fetchModelsFromAPI,
    fetchAllModels,
    getCachedModels,
};
