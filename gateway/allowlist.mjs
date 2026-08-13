import { getKnownProvider } from '../src/engine/providerCatalog.js';

/** 默认允许代发的公网模型主机（单租户 Gateway SSRF 防护） */
export const DEFAULT_ALLOW_HOSTS = new Set([
    'api.openai.com',
    'api.anthropic.com',
    'api.deepseek.com',
    'dashscope.aliyuncs.com',
    'open.bigmodel.cn',
]);

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?|\[?fe80:)/i;

export function isPrivateOrLocalHost(hostname = '') {
    const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return true;
    if (host === '::1' || host === '0.0.0.0') return true;
    return PRIVATE_HOST_RE.test(host);
}

/**
 * @param {string} rawUrl
 * @param {Set<string>|string[]} allowHosts
 */
export function assertAllowedUpstream(rawUrl, allowHosts = DEFAULT_ALLOW_HOSTS) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (_) {
        const err = new Error('invalid_upstream_url');
        err.code = 'UPSTREAM_DENIED';
        throw err;
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        const err = new Error('unsupported_upstream_protocol');
        err.code = 'UPSTREAM_DENIED';
        throw err;
    }

    const host = parsed.hostname.toLowerCase();
    if (isPrivateOrLocalHost(host)) {
        const err = new Error('private_upstream_denied');
        err.code = 'UPSTREAM_DENIED';
        throw err;
    }

    const allow = allowHosts instanceof Set ? allowHosts : new Set(allowHosts);
    if (!allow.has(host)) {
        const err = new Error(`upstream_host_not_allowlisted:${host}`);
        err.code = 'UPSTREAM_DENIED';
        throw err;
    }

    return parsed;
}

export function resolveUpstream(provider, model) {
    const known = getKnownProvider(provider);
    if (!known) {
        const err = new Error(`unknown_provider:${provider || ''}`);
        err.code = 'UNKNOWN_PROVIDER';
        throw err;
    }
    return {
        url: known.chatUrl,
        modelsUrl: known.modelsUrl,
        kind: known.kind,
        model,
        provider: known.id,
    };
}
