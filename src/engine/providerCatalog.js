/**
 * 前后端共享的已验证 Provider 契约。
 * 未知 id 不得回退到 OpenAI。
 */
export const KNOWN_PROVIDERS = Object.freeze([
    {
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai',
        chatUrl: 'https://api.openai.com/v1/chat/completions',
        modelsUrl: 'https://api.openai.com/v1/models',
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        kind: 'anthropic',
        chatUrl: 'https://api.anthropic.com/v1/messages',
        modelsUrl: 'https://api.anthropic.com/v1/models',
    },
    {
        id: 'deepseek',
        name: 'DeepSeek',
        kind: 'openai',
        chatUrl: 'https://api.deepseek.com/v1/chat/completions',
        modelsUrl: 'https://api.deepseek.com/v1/models',
    },
    {
        id: 'alibaba',
        name: 'Alibaba (Qwen)',
        kind: 'openai',
        chatUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        modelsUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    },
    {
        id: 'zhipu',
        name: '智谱 GLM',
        kind: 'openai',
        chatUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models',
    },
]);

export function getKnownProvider(id) {
    const key = String(id || '').toLowerCase();
    return KNOWN_PROVIDERS.find(item => item.id === key) || null;
}

export function listKnownProviderIds() {
    return KNOWN_PROVIDERS.map(item => item.id);
}

export default { KNOWN_PROVIDERS, getKnownProvider, listKnownProviderIds };
