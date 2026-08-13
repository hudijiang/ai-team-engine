/**
 * 浏览器侧：把运行记录写到单租户 Gateway。
 * 失败静默（本机 Gateway 未启动时不影响编排）。
 */
import { ensureGatewayConfigHydrated, isGatewayEnabled } from './gatewayConfig.js';

const DEFAULT_TIMEOUT_MS = 8000;

export async function gatewayFetch(
    path,
    init = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    configOverride = null
) {
    const config = configOverride || await ensureGatewayConfigHydrated();
    if (!isGatewayEnabled(config)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${config.gatewayUrl}${path}`, {
            ...init,
            headers: {
                Authorization: `Bearer ${config.accessToken}`,
                ...(init.headers || {}),
            },
            signal: controller.signal,
        });
        // 在取消定时器前消费响应体；否则只限制“收到响应头”的时间，
        // 服务端可在 headers 后无限挂起 JSON body。
        const data = await res.json();
        return {
            ok: res.ok,
            status: res.status,
            data,
            json: async () => data,
        };
    } catch (_) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export async function createGatewayRun(fields = {}, options = {}) {
    const res = await gatewayFetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            objective: fields.objective || '',
            status: fields.status || 'created',
            sessionId: fields.sessionId || null,
            checkpointType: fields.checkpointType || null,
        }),
    }, options.timeoutMs, options.config);
    if (!res?.ok) return null;
    return res.data?.record || null;
}

export async function getGatewayRun(id, options = {}) {
    if (!id) return null;
    const res = await gatewayFetch(
        `/api/runs/${encodeURIComponent(id)}`,
        {},
        options.timeoutMs,
        options.config
    );
    if (!res?.ok) return null;
    return res.data?.record || null;
}

export async function patchGatewayRun(id, fields = {}, options = {}) {
    if (!id) return null;
    const send = revision => gatewayFetch(`/api/runs/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: fields.status,
            checkpointType: fields.checkpointType,
            currentPhase: fields.currentPhase,
            completedPhases: fields.completedPhases,
            sessionId: fields.sessionId,
            lastError: fields.lastError,
            revision,
        }),
    }, options.timeoutMs, options.config);

    let res = await send(fields.revision);
    if (res?.status === 409 && res.data?.error === 'stale_revision' && options.retryStale !== false) {
        const currentRevision = Number(res.data?.record?.revision || 0);
        if (currentRevision > 0) {
            res = await send(currentRevision);
        }
    }
    return res?.ok ? (res.data?.record || null) : null;
}

export async function listGatewayRuns(options = {}) {
    const res = await gatewayFetch('/api/runs', {}, options.timeoutMs, options.config);
    if (!res?.ok) return [];
    return Array.isArray(res.data?.records) ? res.data.records : [];
}

export async function deleteGatewayRun(id, options = {}) {
    if (!id) return false;
    const res = await gatewayFetch(
        `/api/runs/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
        options.timeoutMs,
        options.config
    );
    return !!res?.ok;
}

export function exportGatewayRuns(records = []) {
    return JSON.stringify({
        exportedAt: new Date().toISOString(),
        records,
    }, null, 2);
}

export async function probeGateway(configOverride = null) {
    const config = configOverride || await ensureGatewayConfigHydrated();
    if (!config.useGateway) {
        return { mode: 'direct', ok: true, reason: null, configuredCount: 0, providers: [] };
    }
    if (!config.gatewayUrl || !config.accessToken) {
        return { mode: 'gateway', ok: false, reason: 'missing_config', configuredCount: 0, providers: [] };
    }
    const health = await gatewayFetch('/health', {}, 3000, config);
    if (!health) {
        return { mode: 'gateway', ok: false, reason: 'unreachable', configuredCount: 0, providers: [] };
    }
    const providersRes = await gatewayFetch('/api/providers', {}, 3000, config);
    if (!providersRes) {
        return { mode: 'gateway', ok: false, reason: 'unreachable', configuredCount: 0, providers: [] };
    }
    if (!providersRes.ok) {
        return { mode: 'gateway', ok: false, reason: 'unauthorized', configuredCount: 0, providers: [] };
    }
    const providers = Array.isArray(providersRes.data?.providers) ? providersRes.data.providers : [];
    const configuredCount = providers.filter(item => item.configured).length;
    if (configuredCount === 0) {
        return { mode: 'gateway', ok: true, reason: 'no_provider_key', configuredCount, providers };
    }
    return { mode: 'gateway', ok: true, reason: null, configuredCount, providers };
}

export async function listGatewayProviders(config = null, options = {}) {
    const res = await gatewayFetch('/api/providers', {}, options.timeoutMs, config);
    if (!res?.ok) return [];
    return Array.isArray(res.data?.providers) ? res.data.providers : [];
}

export async function listGatewayModels(providerId, config = null, options = {}) {
    const res = await gatewayFetch(
        `/api/models?provider=${encodeURIComponent(providerId || '')}`,
        {},
        options.timeoutMs,
        config
    );
    if (!res) throw new Error('Gateway 请求超时或不可达');
    if (!res.ok) {
        throw new Error(res.data?.error || `Gateway 获取模型失败 ${res.status}`);
    }
    return Array.isArray(res.data?.models) ? res.data.models : [];
}

export default {
    createGatewayRun,
    getGatewayRun,
    patchGatewayRun,
    listGatewayRuns,
    listGatewayProviders,
    listGatewayModels,
    deleteGatewayRun,
    exportGatewayRuns,
    probeGateway,
    gatewayFetch,
};
