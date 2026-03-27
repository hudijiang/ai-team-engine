/**
 * 执行能力层
 * 统一聚合插件角色、知识库上下文、内置工具与 MCP 工具
 */
import { ensureKnowledgeBaseHydrated, formatRAGContext } from './ragEngine.js';
import { getAllTools } from './toolRegistry.js';
import { getEnabledPlugins, getPluginRoles } from './pluginSystem.js';
import { ensureMCPConfigsHydrated, getMCPClient } from './mcpClient.js';

const MCP_DISCOVERY_TIMEOUT_MS = 3000;
const MAX_TOOL_RESULT_CHARS = 1600;
const TOOL_TRIGGER_PATTERN = /搜索|检索|查找|查询|调研|资料|信息|对比|统计|时间|日期|计算|公式|research|search|lookup|time|date|calculate|compare/i;

function withTimeout(promise, timeoutMs, fallback) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(fallback), timeoutMs)),
    ]);
}

function toIdSegment(value = '') {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'tool';
}

function ensureUniqueToolName(baseName, toolMap) {
    if (!toolMap.has(baseName)) return baseName;

    let counter = 2;
    while (toolMap.has(`${baseName}_${counter}`)) {
        counter += 1;
    }
    return `${baseName}_${counter}`;
}

function truncateToolResult(result) {
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (!text) return '';
    if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
    return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n...(工具结果已截断)`;
}

function normalizePluginRoleCategory(role, fallbackCategory = 'business') {
    const category = role?.category || fallbackCategory;
    const allowed = new Set(['business', 'tech', 'creative', 'research', 'education', 'management']);
    return allowed.has(category) ? category : fallbackCategory;
}

export function getMergedRoleLibrary(baseLibrary = {}, colorPool = []) {
    const merged = { ...baseLibrary };
    let colorIndex = 0;

    for (const role of getPluginRoles()) {
        const existing = merged[role.name] || {};
        merged[role.name] = {
            role: role.role || existing.role || `负责${role.name}相关工作`,
            color: role.color || existing.color || colorPool[colorIndex++ % Math.max(colorPool.length, 1)] || '#3B82F6',
            category: normalizePluginRoleCategory(role, existing.category || 'business'),
            defaultModel: role.defaultModel || existing.defaultModel || '',
            source: 'plugin',
        };
    }

    return merged;
}

export function buildRoleLibraryText(roleLibrary = {}) {
    return Object.entries(roleLibrary)
        .map(([name, info]) => `  - ${name}（${info.category}）：${info.role}`)
        .join('\n');
}

export function buildPluginRolePrompt(pluginRoles = getPluginRoles()) {
    if (pluginRoles.length === 0) return '';

    return [
        '## 已启用插件角色模板',
        '以下角色来自董事长启用的插件模板，若与目标匹配请优先复用：',
        ...pluginRoles.map(role => `- ${role.name}：${role.role}`),
    ].join('\n');
}

async function registerMCPTools(toolMap) {
    const configs = (await ensureMCPConfigsHydrated()).filter(config => config?.url);
    let registered = 0;

    for (let index = 0; index < configs.length; index++) {
        const config = configs[index];
        const client = await getMCPClient(config.url);
        let connectResult = { success: client.connected && client.tools.length > 0 };

        if (!connectResult.success) {
            connectResult = await withTimeout(
                client.connect(),
                MCP_DISCOVERY_TIMEOUT_MS,
                { success: false, error: 'timeout' }
            );
        }
        if (!connectResult.success) continue;

        const aliasBase = toIdSegment(config.name || client.name || `mcp_${index + 1}`);
        for (const tool of client.tools || []) {
            const toolName = ensureUniqueToolName(
                `mcp.${aliasBase}.${toIdSegment(tool.name)}`,
                toolMap
            );

            toolMap.set(toolName, {
                name: toolName,
                description: `${tool.description || tool.name}（MCP: ${config.name || client.name || config.url}）`,
                parameters: tool.inputSchema?.properties || {},
                source: 'mcp',
                execute: async (params = {}) => client.callTool(tool.name, params),
            });
            registered += 1;
        }
    }

    return registered;
}

function buildToolPrompt(tools = []) {
    if (tools.length === 0) return '';

    const lines = tools.map(tool =>
        `- ${tool.name}: ${tool.description}` +
        (Object.keys(tool.parameters || {}).length > 0
            ? `\n  参数: ${JSON.stringify(tool.parameters)}`
            : '')
    );

    return [
        '### 可用工具',
        '当且仅当你确实需要外部信息、时间、计算或系统工具结果时，再调用工具。',
        '如果需要调用工具，请只输出一个或多个如下代码块，不要附带最终答案：',
        '```tool_call',
        '{"tool": "工具名", "params": {参数}}',
        '```',
        '',
        ...lines,
    ].join('\n');
}

export async function loadExecutionCapabilities(query = '') {
    await ensureKnowledgeBaseHydrated();
    const ragContext = query ? formatRAGContext(query) : '';
    const toolMap = new Map();

    Object.values(getAllTools()).forEach(tool => {
        toolMap.set(tool.name, {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters || {},
            source: 'builtin',
            execute: tool.execute,
        });
    });

    getEnabledPlugins().forEach(plugin => {
        (plugin.tools || []).forEach(tool => {
            if (!tool?.name || typeof tool.execute !== 'function' || toolMap.has(tool.name)) return;
            toolMap.set(tool.name, {
                name: tool.name,
                description: `${tool.description || tool.name}（插件：${plugin.name}）`,
                parameters: tool.parameters || {},
                source: 'plugin',
                execute: tool.execute,
            });
        });
    });

    const mcpCount = await registerMCPTools(toolMap);

    return {
        ragContext,
        toolMap,
        toolPrompt: buildToolPrompt(Array.from(toolMap.values())),
        toolCount: toolMap.size,
        mcpCount,
    };
}

export function shouldUseToolLoop(query, capabilities) {
    if (!capabilities?.toolCount) return false;
    if (capabilities.mcpCount > 0) return true;
    return TOOL_TRIGGER_PATTERN.test(query || '');
}

export async function executeCapabilityTool(toolMap, toolName, params = {}) {
    const tool = toolMap.get(toolName);
    if (!tool) return `工具 "${toolName}" 不存在`;

    try {
        const result = await tool.execute(params);
        return truncateToolResult(result);
    } catch (e) {
        return `工具执行失败：${e.message}`;
    }
}

export function summarizeToolCall(toolName, params = {}) {
    const raw = JSON.stringify(params || {});
    return raw && raw !== '{}'
        ? `${toolName} ${raw}`
        : toolName;
}

export default {
    getMergedRoleLibrary,
    buildRoleLibraryText,
    buildPluginRolePrompt,
    loadExecutionCapabilities,
    shouldUseToolLoop,
    executeCapabilityTool,
    summarizeToolCall,
};
