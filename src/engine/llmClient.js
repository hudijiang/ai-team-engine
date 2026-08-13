/**
 * LLM 客户端
 * 基于用户在 ModelConfigPanel 中保存的 provider 配置，调用 OpenAI/Anthropic 兼容接口
 * 默认浏览器直连供应商；若开启单租户 Gateway，则只带 Gateway Token，raw key 留在 Gateway 进程。
 *
 * 支持：
 * - 外部 AbortSignal（runner stop / 重置）
 * - 请求级超时
 * - SSE 流式读取可中断
 */
import { ensureProviderConfigsHydrated, PROVIDERS } from './modelConfig.js';
import { ensureGatewayConfigHydrated, isGatewayEnabled } from './gatewayConfig.js';
import tokenTracker from './tokenTracker.js';
import logger from '../utils/logger.js';
import { redactSensitive, redactSensitiveDeep } from '../utils/sensitiveData.js';

const REQUEST_TIMEOUT_MS = 90000;

export const LLM_ERROR = {
    TIMEOUT: 'LLM_TIMEOUT',
    CANCELLED: 'LLM_CANCELLED',
    CONFIG: 'LLM_CONFIG',
    HTTP: 'LLM_HTTP',
};

// 简单节流：按 provider 限制 ~3 rps
const providerBuckets = new Map(); // providerId -> timestamps[]
async function throttle(providerId, signal) {
    const bucket = providerBuckets.get(providerId) || [];
    const now = Date.now();
    bucket.push(now);
    while (bucket.length > 3) bucket.shift();
    providerBuckets.set(providerId, bucket);
    if (bucket.length === 3) {
        const delta = now - bucket[0];
        if (delta < 1000) {
            await sleep(1000 - delta, signal);
        }
    }
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError(signal, true));
            return;
        }
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            cleanup();
            reject(createAbortError(signal, true));
        };
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
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
                max_tokens: 8192,
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
    for (const [pid, models] of Object.entries(availableModels)) {
        if (models?.some(m => m.id === modelId)) return pid;
    }
    const providerByName = normalizeProviderId(modelId);
    const providerExists = PROVIDERS.some(p => p.id === providerByName);
    return providerExists ? providerByName : 'custom';
}

function createAbortError(signal, cancelled = false) {
    const err = new Error(cancelled ? 'LLM 请求已取消' : `LLM 请求超时（>${REQUEST_TIMEOUT_MS}ms）`);
    err.name = cancelled ? 'AbortError' : 'TimeoutError';
    err.code = cancelled ? LLM_ERROR.CANCELLED : LLM_ERROR.TIMEOUT;
    err.cause = signal?.reason;
    return err;
}

/**
 * 合并外部 signal + 超时，任一触发即 abort
 */
export function createLinkedAbortController(externalSignal = null, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;

    const timeoutId = setTimeout(() => {
        timedOut = true;
        try {
            controller.abort(createAbortError(null, false));
        } catch (_) { /* ignore */ }
    }, timeoutMs);

    const onExternalAbort = () => {
        cancelled = true;
        try {
            controller.abort(externalSignal?.reason || createAbortError(externalSignal, true));
        } catch (_) { /* ignore */ }
    };

    if (externalSignal) {
        if (externalSignal.aborted) {
            cancelled = true;
            try {
                controller.abort(externalSignal.reason || createAbortError(externalSignal, true));
            } catch (_) { /* ignore */ }
        } else {
            externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
    }

    return {
        signal: controller.signal,
        clear() {
            clearTimeout(timeoutId);
            if (externalSignal) {
                externalSignal.removeEventListener('abort', onExternalAbort);
            }
        },
        wasCancelled: () => cancelled || !!(externalSignal && externalSignal.aborted && !timedOut),
        wasTimedOut: () => timedOut,
    };
}

function isSSEContentType(contentType = '') {
    return contentType.toLowerCase().includes('text/event-stream');
}

/** @internal 导出供测试验证 partial abort */
export async function readStreamingResponse(res, adapter, onToken, signal) {
    if (!res.body) return '';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    const onAbort = () => {
        try { reader.cancel(); } catch (_) { /* ignore */ }
    };
    if (signal) {
        if (signal.aborted) {
            onAbort();
            throw createAbortError(signal, true);
        }
        signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
        while (true) { // eslint-disable-line no-constant-condition
            if (signal?.aborted) {
                throw createAbortError(signal, true);
            }
            const { done, value } = await reader.read();
            // cancel() 可能导致 read 以 done=true 正常返回；必须再次检查 abort
            if (signal?.aborted) {
                throw createAbortError(signal, true);
            }
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
            if (done) {
                if (signal?.aborted) {
                    throw createAbortError(signal, true);
                }
                break;
            }
        }
    } finally {
        signal?.removeEventListener?.('abort', onAbort);
    }

    if (signal?.aborted) {
        throw createAbortError(signal, true);
    }
    return fullContent;
}

async function readJsonResponse(res, adapter) {
    const data = await res.json();
    return adapter.parse(data) || '';
}

async function sendChatViaGateway({
    gateway,
    model,
    messages,
    availableModels,
    onToken,
    agentName,
    dispatch,
    signal,
    startTime,
}) {
    const providerId = resolveProviderForModel(model, availableModels);
    await throttle(providerId, signal);
    logger.debug('LLM', `sendChat via gateway: provider=${providerId}, model=${model}`);

    const linked = createLinkedAbortController(signal, REQUEST_TIMEOUT_MS);
    let result = '';
    try {
        const res = await fetch(`${gateway.gatewayUrl}/api/llm/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${gateway.accessToken}`,
            },
            body: JSON.stringify({
                provider: providerId,
                model,
                messages,
                stream: false,
            }),
            signal: linked.signal,
        });

        if (!res.ok) {
            const text = await res.text();
            const safeSnippet = redactSensitive(String(text).slice(0, 120));
            logger.error('LLM', `Gateway 失败 ${res.status}: ${safeSnippet}`);
            const err = new Error(`LLM Gateway 调用失败 ${res.status}`);
            err.code = LLM_ERROR.HTTP;
            err.status = res.status;
            err.retryable = res.status >= 500 || res.status === 429;
            throw err;
        }

        const data = await res.json();
        result = data?.content || '';
        if (result && typeof onToken === 'function') {
            onToken(result);
        }
    } catch (err) {
        if (err?.code === LLM_ERROR.CANCELLED || err?.code === LLM_ERROR.TIMEOUT) {
            throw err;
        }
        if (err?.name === 'AbortError' || linked.signal.aborted) {
            if (linked.wasCancelled() || signal?.aborted) {
                throw createAbortError(signal, true);
            }
            throw createAbortError(null, false);
        }
        throw err;
    } finally {
        linked.clear();
    }

    return finalizeChatLog({
        model,
        providerId,
        agentName,
        dispatch,
        messages,
        result,
        startTime,
    });
}

function finalizeChatLog({ model, providerId, agentName, dispatch, messages, result, startTime }) {
    const durationMs = Date.now() - startTime;
    const inputText = redactSensitive(messages.map(m => m.content).join('\n'));
    const outputText = redactSensitive(result);
    const logEntry = tokenTracker.record({
        model,
        provider: providerId,
        agentName,
        inputText,
        outputText,
        durationMs,
    });
    if (dispatch) {
        dispatch({
            type: 'ADD_PROMPT_LOG',
            payload: redactSensitiveDeep({ ...logEntry, inputText, outputText }),
        });
    }
    return result;
}

/**
 * 发送一次对话请求
 * @param {Object} params
 * @param {string} params.model - 模型 ID
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} params.messages
 * @param {Object} params.availableModels - 状态中的可用模型字典
 * @param {boolean} [params.stream=false] - 是否使用 SSE 流式
 * @param {(token:string)=>void} [params.onToken] - 流式回调
 * @param {AbortSignal} [params.signal] - 外部取消信号（runner stop）
 * @returns {Promise<string>} LLM 回复内容
 */
export async function sendChat({
    model,
    messages,
    availableModels,
    stream = false,
    onToken,
    agentName = '',
    dispatch = null,
    signal = null,
}) {
    const startTime = Date.now();
    if (signal?.aborted) {
        throw createAbortError(signal, true);
    }

    const gateway = await ensureGatewayConfigHydrated();
    if (isGatewayEnabled(gateway)) {
        return sendChatViaGateway({
            gateway,
            model,
            messages,
            availableModels,
            onToken,
            agentName,
            dispatch,
            signal,
            startTime,
        });
    }

    const configs = await ensureProviderConfigsHydrated();
    const providerId = resolveProviderForModel(model, availableModels);
    await throttle(providerId, signal);
    logger.debug('LLM', `sendChat: provider=${providerId}, model=${model}, stream=${stream}`);
    const config = configs[providerId] || configs.custom || {};

    if (!config.apiUrl || !config.apiKey) {
        const err = new Error(`Provider ${providerId} 未配置 API URL/Key`);
        err.code = LLM_ERROR.CONFIG;
        throw err;
    }

    const adapter = PROVIDER_ADAPTERS[normalizeProviderId(providerId)] || PROVIDER_ADAPTERS.openai;
    const url = adapter.endpoint(config.apiUrl);
    const headers = adapter.headers(config.apiKey);
    const requestStream = !!stream && !!adapter.supportsStreaming;
    const body = adapter.body({ model, messages, stream: requestStream });
    const linked = createLinkedAbortController(signal, REQUEST_TIMEOUT_MS);

    let result = '';
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: linked.signal,
        });

        if (!res.ok) {
            const text = await res.text();
            // 错误体可能含供应商回显的密钥片段 — 仅记录状态码与脱敏摘要
            const safeSnippet = redactSensitive(String(text).slice(0, 120));
            logger.error('LLM', `API 失败 ${res.status}: ${safeSnippet}`);
            const err = new Error(`LLM 调用失败 ${res.status}`);
            err.code = LLM_ERROR.HTTP;
            err.status = res.status;
            err.retryable = res.status >= 500 || res.status === 429;
            throw err;
        }

        const contentType = res.headers.get('content-type') || '';
        if (requestStream && isSSEContentType(contentType)) {
            result = await readStreamingResponse(res, adapter, onToken, linked.signal);
        } else {
            if (requestStream) {
                logger.warn('LLM', `请求了流式，但响应并非 SSE，已回退为非流式解析: provider=${providerId}, content-type=${contentType || 'unknown'}`);
            }
            result = await readJsonResponse(res, adapter);
        }
    } catch (err) {
        if (err?.code === LLM_ERROR.CANCELLED || err?.code === LLM_ERROR.TIMEOUT) {
            throw err;
        }
        if (err?.name === 'AbortError' || linked.signal.aborted) {
            if (linked.wasCancelled() || signal?.aborted) {
                throw createAbortError(signal, true);
            }
            throw createAbortError(null, false);
        }
        throw err;
    } finally {
        linked.clear();
    }

    return finalizeChatLog({
        model,
        providerId,
        agentName,
        dispatch,
        messages,
        result,
        startTime,
    });
}

export function isCancelError(err) {
    return !!(err && (
        err.code === LLM_ERROR.CANCELLED
        || err.name === 'AbortError'
        || /已取消|aborted|Abort/i.test(err.message || '')
    ));
}

export function isTimeoutError(err) {
    return !!(err && (
        err.code === LLM_ERROR.TIMEOUT
        || err.name === 'TimeoutError'
        || /超时|timeout/i.test(err.message || '')
    ));
}

export default { sendChat, resolveProviderForModel, createLinkedAbortController, isCancelError, isTimeoutError, LLM_ERROR };
