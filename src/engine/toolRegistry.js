/**
 * 工具注册中心
 * 定义 Agent 可调用的外部工具 schema 和执行函数
 */

/**
 * 内置工具定义
 */
const BUILTIN_TOOLS = {
    current_time: {
        name: 'current_time',
        description: '获取当前日期和时间',
        risk: 'read',
        parameters: {},
        required: [],
        execute: async () => {
            const now = new Date();
            return `当前时间：${now.toLocaleString('zh-CN', { hour12: false })}，星期${['日', '一', '二', '三', '四', '五', '六'][now.getDay()]}`;
        },
    },

    calculator: {
        name: 'calculator',
        description: '计算数学表达式',
        risk: 'read',
        parameters: { expression: { type: 'string', description: '数学表达式' } },
        required: ['expression'],
        execute: async (params) => {
            try {
                const raw = String(params.expression ?? '');
                // 拒绝任何非数学字符，收窄 Function 攻击面
                if (!/^[\d+\-*/().%\s]+$/.test(raw)) {
                    return '计算错误：仅支持数字与 + - * / % ( ) 运算符';
                }
                const expr = raw.replace(/\s+/g, '');
                if (!expr || expr.length > 200) {
                    return '计算错误：表达式为空或过长';
                }
                if (/\*\*|\/\//.test(expr)) {
                    return '计算错误：不支持 ** 或 //';
                }
                // eslint-disable-next-line no-new-func
                const result = Function(`"use strict"; return (${expr});`)();
                if (typeof result !== 'number' || !Number.isFinite(result)) {
                    return '计算错误：结果不是有效数字';
                }
                return `${raw} = ${result}`;
            } catch (e) {
                return `计算错误：${e.message}`;
            }
        },
    },

    // 模拟搜索默认不注册到可调用列表（simulated: true，policy.allowSimulated 才暴露）
    web_search: {
        name: 'web_search',
        description: '搜索互联网（模拟·默认禁用）',
        risk: 'read',
        simulated: true,
        parameters: { query: { type: 'string', description: '搜索关键词' } },
        required: ['query'],
        execute: async () => {
            throw new Error('模拟搜索已禁用：不得计入成功交付。请接入真实后端检索。');
        },
    },

    markdown_render: {
        name: 'markdown_render',
        description: '渲染 Markdown 文本为格式化预览',
        risk: 'read',
        parameters: { content: { type: 'string', description: 'Markdown 内容' } },
        required: ['content'],
        execute: async (params) => {
            return `[Markdown 预览]\n${params.content}`;
        },
    },

    random_id: {
        name: 'random_id',
        description: '生成随机唯一标识符',
        risk: 'read',
        parameters: {},
        required: [],
        execute: async () => {
            return `生成的 ID：${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
        },
    },
};

/** 自定义工具注册表（禁止覆盖内置名） */
const customTools = {};

/**
 * 注册自定义工具
 * @throws 若 name 与内置冲突
 */
export function registerTool(name, definition) {
    if (BUILTIN_TOOLS[name]) {
        throw new Error(`禁止覆盖内置工具命名空间: ${name}`);
    }
    customTools[name] = {
        ...definition,
        name,
        provenance: 'custom',
        source: 'custom',
    };
}

/**
 * 注销自定义工具（测试用）
 */
export function unregisterTool(name) {
    delete customTools[name];
}

/**
 * 获取所有可用工具
 * 内置优先且不可被 custom 覆盖；内置带 provenance=builtin
 */
export function getAllTools() {
    const result = {};
    for (const [key, def] of Object.entries(BUILTIN_TOOLS)) {
        result[key] = { ...def, name: key, provenance: 'builtin', source: 'builtin' };
    }
    for (const [key, def] of Object.entries(customTools)) {
        if (result[key]) continue; // 永不覆盖内置
        result[key] = { ...def, name: key, provenance: def.provenance || 'custom', source: def.source || 'custom' };
    }
    return result;
}

export function getBuiltinToolNames() {
    return Object.keys(BUILTIN_TOOLS);
}

/**
 * 获取工具 schema（用于注入 LLM prompt）
 */
export function getToolSchemaForPrompt() {
    const tools = getAllTools();
    const lines = Object.values(tools).map(t =>
        `- ${t.name}: ${t.description}` +
        (Object.keys(t.parameters).length > 0
            ? `\n  参数: ${JSON.stringify(t.parameters)}`
            : '')
    );
    return `\n### 可用工具\n你可以调用以下工具。若需调用工具，在回复中包含如下 JSON：\n\`\`\`tool_call\n{"tool": "工具名", "params": {参数}}\n\`\`\`\n\n${lines.join('\n')}\n`;
}

/**
 * 解析 LLM 响应中的工具调用
 */
export function parseToolCalls(responseText) {
    const calls = [];
    const regex = /```tool_call\s*\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(responseText)) !== null) {
        try {
            const parsed = JSON.parse(match[1].trim());
            if (parsed.tool) calls.push(parsed);
        } catch (_) { /* skip invalid JSON */ }
    }
    return calls;
}

/**
 * 执行工具调用
 */
export async function executeTool(toolName, params = {}) {
    const tools = getAllTools();
    const tool = tools[toolName];
    if (!tool) return `工具 "${toolName}" 不存在`;
    try {
        return await tool.execute(params);
    } catch (e) {
        return `工具执行失败：${e.message}`;
    }
}

export default { registerTool, getAllTools, getToolSchemaForPrompt, parseToolCalls, executeTool };
