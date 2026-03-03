/**
 * LLM 客户端
 * 基于用户在 ModelConfigPanel 中保存的 provider 配置，调用 OpenAI/Anthropic 兼容接口
 * 仅在浏览器侧发起 fetch；不在服务端存储任何密钥。
 */
import { loadProviderConfigs, PROVIDERS } from './modelConfig';
import logger from '../utils/logger';

// 简单节流：按 provider 限制 ~3 rps
const providerBuckets = new Map(); // providerId -> timestamps[]
async function throttle(providerId) {
    const bucket = providerBuckets.get(providerId) || [];
    const now = Date.now();
    bucket.push(now);
    while (bucket.length > 3) bucket.shift();
    providerBuckets.set(providerId, bucket);
    if (bucket.length === 3) {
        const delta = now - bucket[0];
        if (delta < 1000) {
            await new Promise(res => setTimeout(res, 1000 - delta));
        }
    }
}

// providerId -> { endpointBuilder, headersBuilder, bodyBuilder }
/** Anthropic API 版本号（统一常量） */
const ANTHROPIC_VERSION = '2024-01-01';

const openaiAdapter = {
    endpoint: (baseUrl) => `${trimSlash(baseUrl)}/chat/completions`,
    headers: (apiKey) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }),
    body: ({ model, messages, stream }) => ({ model, messages, stream: !!stream }),
    parse: (data) => data?.choices?.[0]?.message?.content || '',
};

const PROVIDER_ADAPTERS = {
    openai: openaiAdapter,
    gptge: openaiAdapter,
    custom: openaiAdapter,
    // Anthropic 兼容模式；需要 messages endpoint
    anthropic: {
        endpoint: (baseUrl) => `${trimSlash(baseUrl)}/messages`,
        headers: (apiKey) => ({
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
        }),
        body: ({ model, messages }) => {
            const system = messages.find(m => m.role === 'system')?.content || '';
            const userContent = messages
                .filter(m => m.role !== 'system')
                .map(m => ({ role: m.role, content: m.content }));
            return {
                model,
                system,
                messages: userContent,
                max_tokens: 512,
            };
        },
        parse: (data) => data?.content?.[0]?.text || '',
    },
};

function trimSlash(url) {
    return url ? url.replace(/\/+$/, '') : '';
}

function normalizeProviderId(providerNameOrId) {
    if (!providerNameOrId) return 'custom';
    const lower = providerNameOrId.toLowerCase();
    if (lower.includes('openai')) return 'openai';
    if (lower.includes('anthropic')) return 'anthropic';
    if (lower.includes('gpt.ge')) return 'gptge';
    if (lower.includes('deepseek')) return 'custom';
    if (lower.includes('google')) return 'custom';
    if (lower.includes('minimax')) return 'custom';
    if (lower.includes('qwen') || lower.includes('alibaba')) return 'custom';
    if (lower.includes('glm') || lower.includes('zhipu')) return 'custom';
    return lower;
}

/**
 * 根据模型 ID/元数据选择 provider 配置
 */
export function resolveProviderForModel(modelId, availableModels = {}) {
    // 先看 availableModels 中的 provider 字段
    for (const [pid, models] of Object.entries(availableModels)) {
        if (models?.some(m => m.id === modelId)) return pid;
    }
    // 内置模型带 provider 名称
    const providerByName = normalizeProviderId(modelId);
    const providerExists = PROVIDERS.some(p => p.id === providerByName);
    return providerExists ? providerByName : 'custom';
}

/**
 * 发送一次对话请求
 * @param {Object} params
 * @param {string} params.model - 模型 ID
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} params.messages
 * @param {Object} params.availableModels - 状态中的可用模型字典
 * @param {boolean} [params.stream=false] - 是否使用 SSE 流式
 * @param {(token:string)=>void} [params.onToken] - 流式回调
 * @returns {Promise<string>} LLM 回复内容
 */
export async function sendChat({ model, messages, availableModels, stream = false, onToken }) {
    const configs = loadProviderConfigs();
    const providerId = resolveProviderForModel(model, availableModels);
    await throttle(providerId);
    logger.debug('LLM', `sendChat: provider=${providerId}, model=${model}, stream=${stream}`);
    const config = configs[providerId] || configs.custom || {};

    if (!config.apiUrl || !config.apiKey) {
        throw new Error(`Provider ${providerId} 未配置 API URL/Key`);
    }

    const adapter = PROVIDER_ADAPTERS[normalizeProviderId(providerId)] || PROVIDER_ADAPTERS.openai;
    const url = adapter.endpoint(config.apiUrl);
    const headers = adapter.headers(config.apiKey);
    const body = adapter.body({ model, messages, stream });

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text();
        logger.error('LLM', `API 失败 ${res.status}: ${text.slice(0, 200)}`);
        throw new Error(`LLM 调用失败 ${res.status}: ${text.slice(0, 200)}`);
    }

    if (stream && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let done, value;
        let buffer = '';
        let fullContent = '';

        while (true) { // eslint-disable-line no-constant-condition
            ({ done, value } = await reader.read());
            if (value) {
                buffer += decoder.decode(value, { stream: !done });
                // OpenAI SSE: 每个事件以两个换行分隔
                const parts = buffer.split('\n\n');
                buffer = parts.pop(); // 保留最后一个可能不完整的片段
                for (const chunk of parts) {
                    const line = chunk.trim();
                    if (!line.startsWith('data:')) continue;
                    const dataStr = line.replace(/^data:\s*/, '');
                    if (dataStr === '[DONE]') continue;
                    try {
                        const json = JSON.parse(dataStr);
                        const token = json.choices?.[0]?.delta?.content || '';
                        if (token) {
                            fullContent += token;
                            if (typeof onToken === 'function') onToken(token);
                        }
                    } catch (_e) { /* 忽略不完整 JSON 的解析错误 */ }
                }
            }
            if (done) break;
        }

        // 流式模式下 body 已被消费，直接返回累积内容
        return fullContent;
    }

    const data = await res.json();
    return adapter.parse(data) || '';
}

export default { sendChat, resolveProviderForModel };
