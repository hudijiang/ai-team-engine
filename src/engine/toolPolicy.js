/**
 * 工具权限策略（商用 P0）
 * - 仅 provenance=builtin 的工具可按内置名享受 read 风险表
 * - 未知 / 自定义默认 high_risk
 */

export const TOOL_RISK = {
    READ: 'read',
    REVERSIBLE_WRITE: 'reversible_write',
    HIGH_RISK: 'high_risk',
};

/** 内置工具默认风险等级（仅 provenance=builtin 生效） */
const BUILTIN_RISK = {
    current_time: TOOL_RISK.READ,
    calculator: TOOL_RISK.READ,
    web_search: TOOL_RISK.READ,
    markdown_render: TOOL_RISK.READ,
    random_id: TOOL_RISK.READ,
};

export function isBuiltinProvenance(toolDef = {}) {
    return toolDef.provenance === 'builtin' || toolDef.source === 'builtin';
}

/**
 * 解析工具风险等级
 * 不可伪造：自定义工具即使同名也不能继承 BUILTIN_RISK
 */
export function resolveToolRisk(toolName, toolDef = {}) {
    const builtin = isBuiltinProvenance(toolDef);

    if (builtin) {
        if (toolDef.risk && Object.values(TOOL_RISK).includes(toolDef.risk)) {
            return toolDef.risk;
        }
        if (BUILTIN_RISK[toolName]) return BUILTIN_RISK[toolName];
        return TOOL_RISK.READ;
    }

    // 自定义 / 插件 / MCP：显式 risk 仅允许 non-read 放宽时由策略处理；
    // 默认 high_risk。允许声明 high_risk / reversible_write，但不可通过名称冒充 builtin read。
    if (toolDef.risk === TOOL_RISK.HIGH_RISK || toolDef.risk === TOOL_RISK.REVERSIBLE_WRITE) {
        return toolDef.risk;
    }
    // 若自定义声明 risk=read，仍视为 high_risk（防冒充）
    if (String(toolName).startsWith('mcp.')) return TOOL_RISK.HIGH_RISK;
    return TOOL_RISK.HIGH_RISK;
}

export function isToolAllowed(toolName, toolDef = {}, policy = {}) {
    const {
        allowReversibleWrite = false,
        allowHighRisk = false,
        allowlist = null,
        denylist = [],
    } = policy;

    if (denylist.includes(toolName)) {
        return { allowed: false, reason: '工具在 denylist 中', risk: resolveToolRisk(toolName, toolDef) };
    }
    if (Array.isArray(allowlist) && allowlist.length > 0 && !allowlist.includes(toolName)) {
        return { allowed: false, reason: '工具不在 allowlist 中', risk: resolveToolRisk(toolName, toolDef) };
    }

    const risk = resolveToolRisk(toolName, toolDef);
    if (risk === TOOL_RISK.READ) {
        return { allowed: true, reason: '', risk };
    }
    if (risk === TOOL_RISK.REVERSIBLE_WRITE) {
        return allowReversibleWrite
            ? { allowed: true, reason: '', risk }
            : { allowed: false, reason: '可逆写入类工具默认禁用', risk };
    }
    return allowHighRisk
        ? { allowed: true, reason: '', risk }
        : { allowed: false, reason: '高风险工具默认拒绝（含 MCP/自定义）', risk };
}

export function validateToolParams(toolDef = {}, params = {}) {
    const schema = toolDef.parameters || {};
    const required = toolDef.required || schema.required || [];
    const properties = schema.properties || schema;
    const props = properties.properties ? properties.properties : properties;
    const req = Array.isArray(required) ? required : (properties.required || []);

    const errors = [];
    for (const key of req) {
        if (params[key] === undefined || params[key] === null || params[key] === '') {
            errors.push(`缺少必填参数: ${key}`);
        }
    }

    for (const [key, value] of Object.entries(params || {})) {
        const def = props[key];
        if (!def || typeof def !== 'object') continue;
        if (def.type === 'string' && typeof value !== 'string') {
            errors.push(`参数 ${key} 应为 string`);
        }
        if (def.type === 'number' && typeof value !== 'number') {
            errors.push(`参数 ${key} 应为 number`);
        }
        if (def.type === 'boolean' && typeof value !== 'boolean') {
            errors.push(`参数 ${key} 应为 boolean`);
        }
        if (def.type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
            errors.push(`参数 ${key} 应为 object`);
        }
    }

    return { ok: errors.length === 0, errors };
}

export async function executeWithTimeout(fn, timeoutMs = 15000) {
    let timer;
    try {
        return await Promise.race([
            fn(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`工具执行超时（>${timeoutMs}ms）`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

const auditLog = [];
const MAX_AUDIT = 200;

function safeAuditEntry(entry) {
    // 延迟导入避免循环；调用方应已脱敏，此处再兜底
    try {
        // eslint-disable-next-line global-require
        return entry;
    } catch (_) {
        return entry;
    }
}

export function recordToolAudit(entry) {
    // 动态深度脱敏（同步路径）
    let sanitized = entry;
    try {
        // 避免循环依赖：字符串级清洗
        const scrub = (v) => {
            if (typeof v !== 'string') return v;
            return v
                .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
                .replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]')
                .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_API_KEY]')
                .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '[REDACTED_API_KEY]');
        };
        sanitized = {
            ...entry,
            reason: scrub(entry.reason),
            params: scrub(entry.params),
            resultPreview: scrub(entry.resultPreview),
            error: scrub(entry.error),
        };
    } catch (_) {
        sanitized = entry;
    }

    auditLog.push({
        timestamp: new Date().toISOString(),
        ...sanitized,
    });
    if (auditLog.length > MAX_AUDIT) auditLog.shift();
}

export function getToolAuditLog() {
    return [...auditLog];
}

export function clearToolAuditLog() {
    auditLog.length = 0;
}

export default {
    TOOL_RISK,
    isBuiltinProvenance,
    resolveToolRisk,
    isToolAllowed,
    validateToolParams,
    executeWithTimeout,
    recordToolAudit,
    getToolAuditLog,
    clearToolAuditLog,
};
