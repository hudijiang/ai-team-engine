/**
 * 执行能力层
 * 统一聚合插件角色、知识库上下文、内置工具与 MCP 工具
 */
import { ensureKnowledgeBaseHydrated, formatRAGContext } from './ragEngine.js';
import { getAllTools } from './toolRegistry.js';
import { getEnabledPlugins, getPluginRoles } from './pluginSystem.js';
import { ensureMCPConfigsHydrated, getMCPClient } from './mcpClient.js';
import {
    executeWithTimeout,
    isToolAllowed,
    recordToolAudit,
    resolveToolRisk,
    validateToolParams,
} from './toolPolicy.js';
import { redactSensitive } from '../utils/sensitiveData.js';

const MCP_DISCOVERY_TIMEOUT_MS = 3000;
const TOOL_EXEC_TIMEOUT_MS = 15000;
const MAX_TOOL_RESULT_CHARS = 1600;
const TOOL_TRIGGER_PATTERN = /搜索|检索|查找|查询|调研|资料|信息|对比|统计|时间|日期|计算|公式|research|search|lookup|time|date|calculate|compare/i;

/** 默认工具策略：仅只读；MCP 高风险默认拒绝；禁用模拟工具 */
export const DEFAULT_TOOL_POLICY = {
    allowReversibleWrite: false,
    allowHighRisk: false,
    allowSimulated: false,
    denylist: [],
};

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
                required: tool.inputSchema?.required || [],
                risk: 'high_risk',
                provenance: 'mcp',
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
        // 模拟工具默认不进入 map，避免被误调用
        if (tool.simulated && !DEFAULT_TOOL_POLICY.allowSimulated) return;
        const withProv = {
            ...tool,
            provenance: tool.provenance || tool.source || 'builtin',
            source: tool.source || tool.provenance || 'builtin',
        };
        const risk = resolveToolRisk(tool.name, withProv);
        toolMap.set(tool.name, {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters || {},
            required: tool.required || [],
            risk,
            simulated: !!tool.simulated,
            provenance: withProv.provenance,
            source: withProv.source,
            execute: tool.execute,
        });
    });

    getEnabledPlugins().forEach(plugin => {
        (plugin.tools || []).forEach(tool => {
            if (!tool?.name || typeof tool.execute !== 'function' || toolMap.has(tool.name)) return;
            const withProv = {
                ...tool,
                provenance: 'plugin',
                source: 'plugin',
            };
            const risk = resolveToolRisk(tool.name, withProv);
            toolMap.set(tool.name, {
                name: tool.name,
                description: `${tool.description || tool.name}（插件：${plugin.name}）`,
                parameters: tool.parameters || {},
                required: tool.required || [],
                risk,
                provenance: 'plugin',
                source: 'plugin',
                execute: tool.execute,
            });
        });
    });

    // 仍注册 MCP 以便发现，但默认策略拒绝执行
    const mcpCount = await registerMCPTools(toolMap);

    // Prompt 中只暴露策略允许的工具，避免模型发起必然失败的高风险调用
    const visibleTools = Array.from(toolMap.values()).filter(tool =>
        isToolAllowed(tool.name, tool, DEFAULT_TOOL_POLICY).allowed
    );

    return {
        ragContext,
        toolMap,
        toolPrompt: buildToolPrompt(visibleTools),
        toolCount: toolMap.size,
        allowedToolCount: visibleTools.length,
        mcpCount,
        policy: { ...DEFAULT_TOOL_POLICY },
    };
}

export function shouldUseToolLoop(query, capabilities) {
    if (!capabilities?.allowedToolCount && !capabilities?.toolCount) return false;
    // 商用：仅当有**允许执行**的工具且 query 触发时开启；MCP 存在不再自动开启
    if (!(capabilities.allowedToolCount > 0)) return false;
    return TOOL_TRIGGER_PATTERN.test(query || '');
}

/**
 * 类型化工具执行结果
 * @returns {Promise<{ok: boolean, status: string, data: string, error: string, risk?: string}>}
 */
export async function executeCapabilityTool(toolMap, toolName, params = {}, policy = DEFAULT_TOOL_POLICY) {
    const fail = (status, error, risk = '') => ({
        ok: false,
        status,
        data: '',
        error: String(error || status),
        risk,
    });

    const tool = toolMap.get(toolName);
    if (!tool) {
        recordToolAudit({ tool: toolName, status: 'missing', params: redactSensitive(JSON.stringify(params || {})) });
        return fail('missing', `工具 "${toolName}" 不存在`);
    }

    if (tool.simulated && !policy.allowSimulated) {
        recordToolAudit({
            tool: toolName,
            status: 'denied',
            reason: '模拟工具默认禁用',
            params: redactSensitive(JSON.stringify(params || {})),
        });
        return fail('denied', '模拟工具默认禁用，不得计入成功交付');
    }

    const gate = isToolAllowed(toolName, tool, policy);
    if (!gate.allowed) {
        recordToolAudit({
            tool: toolName,
            status: 'denied',
            risk: gate.risk,
            reason: gate.reason,
            params: redactSensitive(JSON.stringify(params || {})),
        });
        return fail('denied', `工具调用被拒绝：${gate.reason}`, gate.risk);
    }

    const validation = validateToolParams(tool, params || {});
    if (!validation.ok) {
        recordToolAudit({
            tool: toolName,
            status: 'invalid_params',
            reason: validation.errors.join('; '),
            params: redactSensitive(JSON.stringify(params || {})),
        });
        return fail('invalid_params', `工具参数无效：${validation.errors.join('；')}`, gate.risk);
    }

    try {
        const result = await executeWithTimeout(
            () => tool.execute(params),
            TOOL_EXEC_TIMEOUT_MS
        );
        const text = redactSensitive(truncateToolResult(result));
        recordToolAudit({
            tool: toolName,
            status: 'ok',
            risk: gate.risk,
            params: redactSensitive(JSON.stringify(params || {})),
            resultPreview: String(text).slice(0, 200),
        });
        return { ok: true, status: 'ok', data: text, error: '', risk: gate.risk };
    } catch (e) {
        const safeError = redactSensitive(e?.message || 'unknown error');
        recordToolAudit({
            tool: toolName,
            status: 'error',
            risk: gate.risk,
            reason: safeError,
            error: safeError,
            params: redactSensitive(JSON.stringify(params || {})),
        });
        return fail('error', `工具执行失败：${safeError}`, gate.risk);
    }
}

/** 兼容旧调用方：仅取文本（失败时返回错误串） */
export async function executeCapabilityToolText(toolMap, toolName, params = {}, policy = DEFAULT_TOOL_POLICY) {
    const r = await executeCapabilityTool(toolMap, toolName, params, policy);
    return r.ok ? r.data : r.error;
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
