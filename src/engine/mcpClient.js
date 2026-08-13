/**
 * 外部工具桥（名义上的「MCP」配置项）
 *
 * 当前**不是**官方 Model Context Protocol：
 * - 仅约定两个 HTTP JSON 接口：GET `/tools/list`、POST `/tools/call`
 * - 没有 JSON-RPC、没有 MCP SSE/stdio transport、没有 initialize 握手
 * - 发现到的工具 provenance=mcp，默认 high_risk，策略未放行则不会执行
 *
 * 用于本地 PoC 对接自建 HTTP 工具网关；勿当作完整 MCP Client。
 */
import { createPersistentResource } from '../utils/persistentResource.js';

const STORAGE_KEY = 'agent-auto-mcp-servers';

const mcpConfigResource = createPersistentResource({
    storageKey: STORAGE_KEY,
    initialValue: () => ([]),
    bootstrapSelector: (configs) => (configs || []).map(config => ({
        ...config,
        authToken: '',
    })),
});

function normalizeMCPConfigs(configs = []) {
    return Array.isArray(configs)
        ? configs.map(config => ({
            ...config,
            name: config?.name || config?.url || '',
            url: config?.url || '',
            authToken: config?.authToken || '',
        }))
        : [];
}

/**
 * MCP Server 连接配置
 */
export function loadMCPConfigs() {
    return normalizeMCPConfigs(mcpConfigResource.get());
}

export async function ensureMCPConfigsHydrated() {
    const hydrated = await mcpConfigResource.hydrate();
    const normalized = normalizeMCPConfigs(hydrated);
    mcpConfigResource.set(normalized);
    return normalized;
}

export function saveMCPConfigs(configs) {
    const normalized = normalizeMCPConfigs(configs);
    mcpConfigResource.set(normalized);

    const activeUrls = new Set(normalized.map(config => config.url));
    for (const [serverUrl, client] of mcpClients.entries()) {
        if (!activeUrls.has(serverUrl)) {
            client.disconnect();
            mcpClients.delete(serverUrl);
        }
    }

    normalized.forEach(config => {
        const client = mcpClients.get(config.url);
        if (client) {
            client.authToken = config.authToken || '';
            client.name = config.name || config.url;
        }
    });
}

/**
 * MCP 客户端类
 */
export class MCPClient {
    constructor(serverUrl, options = {}) {
        this.serverUrl = serverUrl.replace(/\/$/, '');
        this.authToken = options.authToken || '';
        this.name = options.name || serverUrl;
        this.tools = [];
        this.connected = false;
    }

    /**
     * 连接并发现工具
     */
    async connect() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;

            const res = await fetch(`${this.serverUrl}/tools/list`, {
                headers,
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this.tools = data.tools || [];
            this.connected = true;
            return { success: true, tools: this.tools };
        } catch (e) {
            this.connected = false;
            return { success: false, error: e.name === 'AbortError' ? '连接超时' : e.message };
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 调用 MCP 工具（高风险；默认策略拒绝，需显式 allowHighRisk）
     */
    async callTool(toolName, params = {}) {
        if (!this.connected) throw new Error('MCP Server 未连接');

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;

            const res = await fetch(`${this.serverUrl}/tools/call`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: toolName, arguments: params }),
                signal: controller.signal,
            });

            if (!res.ok) throw new Error(`工具调用失败: HTTP ${res.status}`);
            const data = await res.json();
            return data.content?.[0]?.text || JSON.stringify(data);
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('MCP 工具调用超时');
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 获取工具 schema
     */
    getToolSchemas() {
        return this.tools.map(t => ({
            name: `mcp:${this.name}:${t.name}`,
            description: t.description || t.name,
            parameters: t.inputSchema?.properties || {},
        }));
    }

    disconnect() {
        this.connected = false;
        this.tools = [];
    }
}

/** 全局 MCP 客户端管理 */
const mcpClients = new Map();

export async function getMCPClient(serverUrl) {
    const configs = await ensureMCPConfigsHydrated();
    const config = configs.find(c => c.url === serverUrl) || {};
    if (!mcpClients.has(serverUrl)) {
        mcpClients.set(serverUrl, new MCPClient(serverUrl, config));
    } else {
        const client = mcpClients.get(serverUrl);
        client.authToken = config.authToken || '';
        client.name = config.name || serverUrl;
    }
    return mcpClients.get(serverUrl);
}

export function getAllMCPClients() {
    return Array.from(mcpClients.values());
}

export default { MCPClient, loadMCPConfigs, ensureMCPConfigsHydrated, saveMCPConfigs, getMCPClient, getAllMCPClients };
