/**
 * 模型 API 配置管理
 * 管理各供应商的 API URL 和 API Key
 * 支持通过 API 动态获取可用模型列表
 * 使用 localStorage 持久化存储
 */

/** localStorage 存储键 */
const STORAGE_KEY = 'agent-auto-provider-configs';
const MODELS_CACHE_KEY = 'agent-auto-models-cache';

/**
 * 供应商默认配置
 */
export const PROVIDERS = [
    {
        id: 'gptge',
        name: 'GPT.GE (OpenAI 兼容代理)',
        icon: '⭐',
        defaultApiUrl: 'https://api.gpt.ge/v1',
        modelsPath: '/models',
        placeholder: 'sk-...',
    },
    {
        id: 'openai',
        name: 'OpenAI',
        icon: '🟢',
        defaultApiUrl: 'https://api.openai.com/v1',
        modelsPath: '/models',
        placeholder: 'sk-...',
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        icon: '🟠',
        defaultApiUrl: 'https://api.anthropic.com/v1',
        modelsPath: '/models',
        placeholder: 'sk-ant-...',
    },
    {
        id: 'google',
        name: 'Google',
        icon: '🔵',
        defaultApiUrl: 'https://generativelanguage.googleapis.com/v1beta',
        modelsPath: '/models',
        placeholder: 'AIza...',
    },
    {
        id: 'deepseek',
        name: 'DeepSeek',
        icon: '🟣',
        defaultApiUrl: 'https://api.deepseek.com/v1',
        modelsPath: '/models',
        placeholder: 'sk-...',
    },
    {
        id: 'alibaba',
        name: 'Alibaba (Qwen)',
        icon: '🔴',
        defaultApiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        modelsPath: '/models',
        placeholder: 'sk-...',
    },
    {
        id: 'minimax',
        name: 'MiniMax',
        icon: '🟡',
        defaultApiUrl: 'https://api.minimax.chat/v1',
        modelsPath: '/models',
        placeholder: 'eyJ...',
    },
    {
        id: 'zhipu',
        name: '智谱AI (GLM)',
        icon: '🔶',
        defaultApiUrl: 'https://open.bigmodel.cn/api/paas/v4',
        modelsPath: '/models',
        placeholder: '...',
    },
    {
        id: 'custom',
        name: '自定义 (OpenAI 兼容)',
        icon: '⚙️',
        defaultApiUrl: '',
        modelsPath: '/models',
        placeholder: 'sk-...',
    },
];

/**
 * 从 localStorage 加载供应商配置
 * @returns {Object<string, {apiUrl: string, apiKey: string}>}
 */
export function loadProviderConfigs() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);

            // 与最新 PROVIDERS 合并，确保新增供应商拥有默认配置
            const merged = {};
            PROVIDERS.forEach(p => {
                merged[p.id] = {
                    apiUrl: p.defaultApiUrl,
                    apiKey: '',
                    enabled: false,
                    ...(parsed[p.id] || {}),
                };
            });

            return merged;
        }
    } catch (e) {
        console.warn('加载供应商配置失败:', e);
    }

    // 返回默认配置（无 API Key）
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

/**
 * 保存供应商配置到 localStorage
 * @param {Object} configs
 */
export function saveProviderConfigs(configs) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
    } catch (e) {
        console.warn('保存供应商配置失败:', e);
    }
}

/**
 * 从 localStorage 加载模型缓存
 */
export function loadModelsCache() {
    try {
        const saved = localStorage.getItem(MODELS_CACHE_KEY);
        if (saved) return JSON.parse(saved);
    } catch (e) { /* ignore */ }
    return {};
}

/**
 * 保存模型缓存到 localStorage
 */
export function saveModelsCache(cache) {
    try {
        localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(cache));
    } catch (e) { /* ignore */ }
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
    const configs = loadProviderConfigs();
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
    saveProviderConfigs,
    fetchModelsFromAPI,
    fetchAllModels,
    getCachedModels,
};
