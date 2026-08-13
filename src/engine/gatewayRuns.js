/**
 * 浏览器侧：把运行记录写到单租户 Gateway。
 * 失败静默（本机 Gateway 未启动时不影响编排）。
 */
import { ensureGatewayConfigHydrated, isGatewayEnabled } from './gatewayConfig.js';

export async function createGatewayRun(fields = {}) {
    const config = await ensureGatewayConfigHydrated();
    if (!isGatewayEnabled(config)) return null;
    const res = await fetch(`${config.gatewayUrl}/api/runs`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.accessToken}`,
        },
        body: JSON.stringify({
            objective: fields.objective || '',
            status: fields.status || 'created',
            sessionId: fields.sessionId || null,
            checkpointType: fields.checkpointType || null,
        }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.record || null;
}

export async function getGatewayRun(id) {
    const config = await ensureGatewayConfigHydrated();
    if (!isGatewayEnabled(config) || !id) return null;
    const res = await fetch(`${config.gatewayUrl}/api/runs/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.record || null;
}

export default { createGatewayRun, getGatewayRun };
