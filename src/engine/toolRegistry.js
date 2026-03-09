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
        parameters: {},
        execute: async () => {
            const now = new Date();
            return `当前时间：${now.toLocaleString('zh-CN', { hour12: false })}，星期${['日', '一', '二', '三', '四', '五', '六'][now.getDay()]}`;
        },
    },

    calculator: {
        name: 'calculator',
        description: '计算数学表达式',
        parameters: { expression: { type: 'string', description: '数学表达式' } },
        execute: async (params) => {
            try {
                // 安全计算：仅允许数字和基本运算符
                const expr = params.expression.replace(/[^0-9+\-*/().%\s]/g, '');
                const result = Function('"use strict"; return (' + expr + ')')();
                return `${params.expression} = ${result}`;
            } catch (e) {
                return `计算错误：${e.message}`;
            }
        },
    },

    web_search: {
        name: 'web_search',
        description: '搜索互联网获取信息（模拟）',
        parameters: { query: { type: 'string', description: '搜索关键词' } },
        execute: async (params) => {
            // 前端环境下无法直接调用搜索 API，返回提示
            return `[搜索] 已搜索「${params.query}」- 这是前端模拟结果。实际部署需要后端搜索 API 支持。`;
        },
    },

    markdown_render: {
        name: 'markdown_render',
        description: '渲染 Markdown 文本为格式化预览',
        parameters: { content: { type: 'string', description: 'Markdown 内容' } },
        execute: async (params) => {
            return `[Markdown 预览]\n${params.content}`;
        },
    },

    random_id: {
        name: 'random_id',
        description: '生成随机唯一标识符',
        parameters: {},
        execute: async () => {
            return `生成的 ID：${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
        },
    },
};

/** 自定义工具注册表 */
const customTools = {};

/**
 * 注册自定义工具
 */
export function registerTool(name, definition) {
    customTools[name] = { ...definition, name };
}

/**
 * 获取所有可用工具
 */
export function getAllTools() {
    return { ...BUILTIN_TOOLS, ...customTools };
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
