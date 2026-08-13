import { redactSensitive, redactSensitiveDeep } from '../src/utils/sensitiveData.js';
import {
    DEFAULT_ALLOW_HOSTS,
    assertAllowedUpstream,
    resolveUpstream,
} from './allowlist.mjs';
import { createTokenBucket } from './rateLimit.mjs';
import { createRunStore } from './runStore.mjs';

function corsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    };
}

function json(status, payload, extraHeaders = {}, origin = '*') {
    return {
        status,
        contentType: 'application/json; charset=utf-8',
        headers: { ...corsHeaders(origin), ...extraHeaders },
        body: JSON.stringify(payload),
    };
}

function withCors(result, origin) {
    return {
        ...result,
        headers: { ...corsHeaders(origin), ...(result.headers || {}) },
    };
}

function readBearer(headers = {}) {
    const raw = headers.authorization || headers.Authorization || '';
    const match = String(raw).match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function safeParseJson(raw) {
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function buildUpstreamPayload(kind, { model, messages, stream }) {
    if (kind === 'anthropic') {
        const system = (messages || []).find(m => m.role === 'system')?.content || '';
        return {
            model,
            system,
            messages: (messages || []).filter(m => m.role !== 'system'),
            max_tokens: 8192,
            stream: !!stream,
        };
    }
    return { model, messages: messages || [], stream: !!stream };
}

function buildUpstreamHeaders(kind, apiKey) {
    if (kind === 'anthropic') {
        return {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2024-01-01',
        };
    }
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
    };
}

export function createGatewayHandler(options = {}) {
    const token = String(options.token || '');
    const providerKeys = options.providerKeys || {};
    const allowHosts = new Set([
        ...DEFAULT_ALLOW_HOSTS,
        ...(options.extraAllowHosts || []),
    ]);
    const bucket = options.bucket || createTokenBucket({ rpm: options.rpm || 30 });
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const corsOrigin = options.corsOrigin || '*';
    const runStore = options.runStore || createRunStore({ filePath: options.runStoreFilePath || null });
    const audit = options.audit || ((entry) => {
        try {
            process.stderr.write(`${JSON.stringify(entry)}\n`);
        } catch (_) { /* ignore */ }
    });

    function handleRunRoute(method, runId, rawBody) {
        if (method === 'POST' && !runId) {
            const payload = safeParseJson(rawBody);
            if (!payload) return json(400, { error: 'invalid_json' });
            if (payload.apiKey || payload.api_key || payload.secret || payload.accessToken) {
                return json(400, { error: 'provider_key_not_accepted' });
            }
            try {
                const record = runStore.create(payload);
                return json(201, { record });
            } catch (err) {
                if (err?.code === 'SECRET_REJECTED') {
                    return json(400, { error: 'provider_key_not_accepted' });
                }
                throw err;
            }
        }
        if (method === 'PATCH' && runId) {
            const payload = safeParseJson(rawBody);
            if (!payload) return json(400, { error: 'invalid_json' });
            if (payload.apiKey || payload.api_key || payload.secret || payload.accessToken) {
                return json(400, { error: 'provider_key_not_accepted' });
            }
            try {
                const record = runStore.update(runId, payload);
                return json(200, { record });
            } catch (err) {
                if (err?.code === 'SECRET_REJECTED') {
                    return json(400, { error: 'provider_key_not_accepted' });
                }
                if (err?.code === 'NOT_FOUND') {
                    return json(404, { error: 'run_not_found' });
                }
                if (err?.code === 'INVALID_TRANSITION') {
                    return json(409, { error: 'invalid_status_transition', reason: err.message });
                }
                throw err;
            }
        }
        if (method === 'GET' && runId) {
            const record = runStore.get(runId);
            if (!record) return json(404, { error: 'run_not_found' });
            return json(200, { record });
        }
        if (method === 'GET' && !runId) {
            return json(200, { records: runStore.list() });
        }
        return json(405, { error: 'method_not_allowed' });
    }

    return async function handle(request = {}) {
        const result = await handleInner(request);
        return withCors(result, corsOrigin);
    };

    async function handleInner(request = {}) {
        const method = (request.method || 'GET').toUpperCase();
        const url = new URL(request.url || '/', 'http://gateway.local');

        if (method === 'OPTIONS') {
            return { status: 204, contentType: 'text/plain', headers: corsHeaders(corsOrigin), body: '' };
        }

        if (method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
            return json(200, {
                ok: true,
                role: 'single-tenant-llm-gateway',
                persist: true,
            }, {}, corsOrigin);
        }

        const runMatch = url.pathname.match(/^\/api\/runs(?:\/([^/]+))?$/);
        if (runMatch) {
            if (!token || readBearer(request.headers) !== token) {
                return json(401, { error: 'unauthorized' });
            }
            return handleRunRoute(method, runMatch[1], request.body);
        }

        if (url.pathname !== '/api/llm/chat') {
            return json(404, { error: 'not_found' });
        }
        if (method !== 'POST') {
            return json(405, { error: 'method_not_allowed' });
        }

        if (!token || readBearer(request.headers) !== token) {
            return json(401, { error: 'unauthorized' });
        }

        const limited = bucket.take(1);
        if (!limited.ok) {
            return json(429, { error: 'rate_limited' }, {
                'Retry-After': String(Math.ceil((limited.retryAfterMs || 1000) / 1000)),
            });
        }

        const payload = safeParseJson(request.body);
        if (!payload) {
            return json(400, { error: 'invalid_json' });
        }

        // 客户端不得上传供应商 raw key
        if (payload.apiKey || payload.api_key || payload.secret) {
            return json(400, { error: 'provider_key_not_accepted' });
        }

        const provider = String(payload.provider || 'openai').toLowerCase();
        const model = payload.model || '';
        const messages = Array.isArray(payload.messages) ? payload.messages : [];
        if (!model || messages.length === 0) {
            return json(400, { error: 'model_and_messages_required' });
        }

        const apiKey = providerKeys[provider] || providerKeys.custom || '';
        if (!apiKey) {
            return json(503, { error: 'provider_key_not_configured', provider });
        }

        const upstream = resolveUpstream(provider, model);
        try {
            assertAllowedUpstream(upstream.url, allowHosts);
        } catch (err) {
            return json(403, { error: 'upstream_denied', reason: err.message });
        }

        const started = Date.now();
        try {
            const res = await fetchImpl(upstream.url, {
                method: 'POST',
                headers: buildUpstreamHeaders(upstream.kind, apiKey),
                body: JSON.stringify(buildUpstreamPayload(upstream.kind, {
                    model,
                    messages,
                    stream: false,
                })),
            });
            const text = await res.text();
            let parsed = text;
            try {
                parsed = JSON.parse(text);
            } catch (_) { /* keep text */ }

            audit(redactSensitiveDeep({
                type: 'llm_proxy',
                provider,
                model,
                status: res.status,
                durationMs: Date.now() - started,
                ok: res.ok,
            }));

            if (!res.ok) {
                return json(res.status, {
                    error: 'upstream_error',
                    status: res.status,
                    detail: redactSensitive(String(text).slice(0, 200)),
                });
            }

            const content = extractContent(upstream.kind, parsed);
            return json(200, { content, provider, model });
        } catch (err) {
            audit({
                type: 'llm_proxy',
                provider,
                model,
                status: 502,
                durationMs: Date.now() - started,
                ok: false,
                error: redactSensitive(err?.message || 'fetch_failed'),
            });
            return json(502, { error: 'upstream_unreachable' });
        }
    };
}

function extractContent(kind, parsed) {
    if (typeof parsed === 'string') return parsed;
    if (kind === 'anthropic') {
        return parsed?.content?.[0]?.text || '';
    }
    return parsed?.choices?.[0]?.message?.content || '';
}

export default { createGatewayHandler };
