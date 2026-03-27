/**
 * LLM 客户端
 * 基于用户在 ModelConfigPanel 中保存的 provider 配置，调用 OpenAI/Anthropic 兼容接口
 * 仅在浏览器侧发起 fetch；不在服务端存储任何密钥。
 */
import { ensureProviderConfigsHydrated, PROVIDERS } from './modelConfig.js';
import tokenTracker from './tokenTracker.js';
import logger from '../utils/logger.js';

const REQUEST_TIMEOUT_MS = 90000;

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
    supportsStreaming: true,
    endpoint: (baseUrl) => `${trimSlash(baseUrl)}/chat/completions`,
    headers: (apiKey) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }),
    body: ({ model, messages, stream }) => ({ model, messages, stream: !!stream }),
    parse: (data) => data?.choices?.[0]?.message?.content || '',
    parseStreamEvent: (data) => data?.choices?.[0]?.delta?.content || '',
};

const PROVIDER_ADAPTERS = {
    openai: openaiAdapter,
    gptge: openaiAdapter,
    custom: openaiAdapter,
    // Anthropic 兼容模式；需要 messages endpoint
    anthropic: {
        supportsStreaming: true,
        endpoint: (baseUrl) => `${trimSlash(baseUrl)}/messages`,
        headers: (apiKey) => ({
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
        }),
        body: ({ model, messages, stream }) => {
            const system = messages.find(m => m.role === 'system')?.content || '';
            const userContent = messages
                .filter(m => m.role !== 'system')
                .map(m => ({ role: m.role, content: m.content }));
            return {
                model,
                system,
                messages: userContent,
                max_tokens: 512,
                stream: !!stream,
            };
        },
        parse: (data) => data?.content?.[0]?.text || '',
        parseStreamEvent: (data) => {
            if (data?.type === 'content_block_delta') {
                return data?.delta?.text || '';
            }
            return '';
        },
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

function createTimeoutController(timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error(`LLM 请求超时（>${timeoutMs}ms）`)), timeoutMs);
    return {
        signal: controller.signal,
        clear: () => clearTimeout(timeoutId),
    };
}

function isSSEContentType(contentType = '') {
    return contentType.toLowerCase().includes('text/event-stream');
}

async function readStreamingResponse(res, adapter, onToken) {
    if (!res.body) return '';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    while (true) { // eslint-disable-line no-constant-condition
        const { done, value } = await reader.read();
        if (value) {
            buffer += decoder.decode(value, { stream: !done });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() || '';

            for (const chunk of parts) {
                const dataLines = chunk
                    .split('\n')
                    .map(line => line.trim())
                    .filter(line => line.startsWith('data:'))
                    .map(line => line.replace(/^data:\s*/, ''));

                if (dataLines.length === 0) continue;
                const dataStr = dataLines.join('\n').trim();
                if (!dataStr || dataStr === '[DONE]') continue;

                try {
                    const json = JSON.parse(dataStr);
                    const token = adapter.parseStreamEvent?.(json) || '';
                    if (token) {
                        fullContent += token;
                        if (typeof onToken === 'function') onToken(token);
                    }
                } catch (_e) {
                    // 忽略不完整事件或非 JSON 事件
                }
            }
        }
        if (done) break;
    }

    return fullContent;
}

async function readJsonResponse(res, adapter) {
    const data = await res.json();
    return adapter.parse(data) || '';
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
export async function sendChat({ model, messages, availableModels, stream = false, onToken, agentName = '', dispatch = null }) {
    const startTime = Date.now();
    const configs = await ensureProviderConfigsHydrated();
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
    const requestStream = !!stream && !!adapter.supportsStreaming;
    const body = adapter.body({ model, messages, stream: requestStream });
    const timeout = createTimeoutController();

    let result = '';
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: timeout.signal,
        });

        if (!res.ok) {
            const text = await res.text();
            logger.error('LLM', `API 失败 ${res.status}: ${text.slice(0, 200)}`);
            throw new Error(`LLM 调用失败 ${res.status}: ${text.slice(0, 200)}`);
        }

        const contentType = res.headers.get('content-type') || '';
        if (requestStream && isSSEContentType(contentType)) {
            result = await readStreamingResponse(res, adapter, onToken);
        } else {
            if (requestStream) {
                logger.warn('LLM', `请求了流式，但响应并非 SSE，已回退为非流式解析: provider=${providerId}, content-type=${contentType || 'unknown'}`);
            }
            result = await readJsonResponse(res, adapter);
        }
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error(`LLM 请求超时（>${REQUEST_TIMEOUT_MS}ms）`);
        }
        throw err;
    } finally {
        timeout.clear();
    }

    const durationMs = Date.now() - startTime;
    const inputText = messages.map(m => m.content).join('\n');
    const logEntry = tokenTracker.record({ model, provider: providerId, agentName, inputText, outputText: result, durationMs });
    if (dispatch) {
        dispatch({ type: 'ADD_PROMPT_LOG', payload: { ...logEntry, inputText, outputText: result } });
    }
    return result;
}

export default { sendChat, resolveProviderForModel };
