/**
 * 可选单租户 LLM Gateway 配置。
 * 开启后浏览器只带 Gateway access token，不再把供应商 raw key 发往模型厂商。
 */
import { createPersistentResource } from '../utils/persistentResource.js';

const STORAGE_KEY = 'agent-auto-gateway-config';
const DEFAULT_CONFIG = {
    useGateway: false,
    gatewayUrl: '',
    accessToken: '',
};

const gatewayConfigResource = createPersistentResource({
    storageKey: STORAGE_KEY,
    initialValue: () => ({ ...DEFAULT_CONFIG }),
    bootstrapSelector: (config) => ({
        useGateway: !!config?.useGateway,
        gatewayUrl: config?.gatewayUrl || '',
        accessToken: '',
    }),
});

export function normalizeGatewayConfig(config = {}) {
    return {
        ...DEFAULT_CONFIG,
        ...config,
        useGateway: !!config?.useGateway,
        gatewayUrl: String(config?.gatewayUrl || '').replace(/\/$/, ''),
        accessToken: config?.accessToken || '',
    };
}

export function loadGatewayConfig() {
    return normalizeGatewayConfig(gatewayConfigResource.get());
}

export async function ensureGatewayConfigHydrated() {
    const hydrated = await gatewayConfigResource.hydrate();
    const normalized = normalizeGatewayConfig(hydrated);
    gatewayConfigResource.set(normalized);
    return normalized;
}

export function saveGatewayConfig(config) {
    const normalized = normalizeGatewayConfig(config);
    gatewayConfigResource.set(normalized);
    return normalized;
}

export function isGatewayEnabled(config = loadGatewayConfig()) {
    return !!(config.useGateway && config.gatewayUrl && config.accessToken);
}

export default {
    loadGatewayConfig,
    ensureGatewayConfigHydrated,
    saveGatewayConfig,
    isGatewayEnabled,
    normalizeGatewayConfig,
};
