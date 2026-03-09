/**
 * MCP (Model Context Protocol) 客户端
 * 前端抽象层 — 通过 SSE/HTTP 连接 MCP Server
 */

const STORAGE_KEY = 'agent-auto-mcp-servers';

/**
 * MCP Server 连接配置
 */
export function loadMCPConfigs() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved ? JSON.parse(saved) : [];
    } catch (_) { return []; }
}

export function saveMCPConfigs(configs) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
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
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;

            const res = await fetch(`${this.serverUrl}/tools/list`, { headers });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this.tools = data.tools || [];
            this.connected = true;
            return { success: true, tools: this.tools };
        } catch (e) {
            this.connected = false;
            return { success: false, error: e.message };
        }
    }

    /**
     * 调用 MCP 工具
     */
    async callTool(toolName, params = {}) {
        if (!this.connected) throw new Error('MCP Server 未连接');

        const headers = { 'Content-Type': 'application/json' };
        if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;

        const res = await fetch(`${this.serverUrl}/tools/call`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: toolName, arguments: params }),
        });

        if (!res.ok) throw new Error(`工具调用失败: HTTP ${res.status}`);
        const data = await res.json();
        return data.content?.[0]?.text || JSON.stringify(data);
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

export function getMCPClient(serverUrl) {
    if (!mcpClients.has(serverUrl)) {
        const configs = loadMCPConfigs();
        const config = configs.find(c => c.url === serverUrl) || {};
        mcpClients.set(serverUrl, new MCPClient(serverUrl, config));
    }
    return mcpClients.get(serverUrl);
}

export function getAllMCPClients() {
    return Array.from(mcpClients.values());
}

export default { MCPClient, loadMCPConfigs, saveMCPConfigs, getMCPClient, getAllMCPClients };
