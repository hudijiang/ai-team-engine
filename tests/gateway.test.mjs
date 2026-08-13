import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayHandler } from '../gateway/handler.mjs';
import { createRunStore } from '../gateway/runStore.mjs';
import { assertAllowedUpstream, isPrivateOrLocalHost } from '../gateway/allowlist.mjs';
import { createTokenBucket } from '../gateway/rateLimit.mjs';
import {
    importFreshFromRoot,
    resetBrowserState,
    settleAsync,
} from './helpers/browserEnv.mjs';

test('allowlist denies private hosts and unknown public hosts', () => {
    assert.equal(isPrivateOrLocalHost('127.0.0.1'), true);
    assert.equal(isPrivateOrLocalHost('10.0.0.8'), true);
    assert.equal(isPrivateOrLocalHost('api.openai.com'), false);
    assert.throws(() => assertAllowedUpstream('http://127.0.0.1:8787/v1'), /private_upstream/);
    assert.throws(() => assertAllowedUpstream('https://evil.example/v1'), /not_allowlisted/);
    assert.ok(assertAllowedUpstream('https://api.openai.com/v1/chat/completions'));
});

test('gateway rejects missing token, raw provider keys, and unconfigured provider', async () => {
    const handler = createGatewayHandler({
        token: 'secret-token',
        providerKeys: { openai: 'sk-test' },
        fetchImpl: async () => {
            throw new Error('should not fetch');
        },
        audit: () => {},
    });

    const unauthorized = await handler({
        method: 'POST',
        url: '/api/llm/chat',
        headers: {},
        body: JSON.stringify({ provider: 'openai', model: 'gpt', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(unauthorized.status, 401);

    const withRawKey = await handler({
        method: 'POST',
        url: '/api/llm/chat',
        headers: { authorization: 'Bearer secret-token' },
        body: JSON.stringify({
            provider: 'openai',
            model: 'gpt',
            messages: [{ role: 'user', content: 'hi' }],
            apiKey: 'sk-leaked',
        }),
    });
    assert.equal(withRawKey.status, 400);
    assert.match(withRawKey.body, /provider_key_not_accepted/);

    const missingProvider = await handler({
        method: 'POST',
        url: '/api/llm/chat',
        headers: { authorization: 'Bearer secret-token' },
        body: JSON.stringify({
            provider: 'anthropic',
            model: 'claude',
            messages: [{ role: 'user', content: 'hi' }],
        }),
    });
    assert.equal(missingProvider.status, 503);
});

test('gateway proxies allowlisted upstream without forwarding client apiKey', async () => {
    const calls = [];
    const handler = createGatewayHandler({
        token: 'secret-token',
        providerKeys: { openai: 'sk-server-only' },
        audit: () => {},
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    choices: [{ message: { content: 'hello from upstream' } }],
                }),
            };
        },
    });

    const res = await handler({
        method: 'POST',
        url: '/api/llm/chat',
        headers: { authorization: 'Bearer secret-token' },
        body: JSON.stringify({
            provider: 'openai',
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'hi' }],
        }),
    });

    assert.equal(res.status, 200);
    assert.match(res.body, /hello from upstream/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.match(calls[0].init.headers.Authorization, /sk-server-only/);
    assert.equal(String(calls[0].init.body).includes('sk-leaked'), false);
});

test('persist create then get returns the same record after the create request ends', async () => {
    const handler = createGatewayHandler({
        token: 'secret-token',
        audit: () => {},
        fetchImpl: async () => { throw new Error('chat unused'); },
        runStore: createRunStore(),
    });

    const created = await handler({
        method: 'POST',
        url: '/api/runs',
        headers: { authorization: 'Bearer secret-token' },
        body: JSON.stringify({ objective: 'ship preview', status: 'running', sessionId: 'session-1' }),
    });
    assert.equal(created.status, 201);
    const createdBody = JSON.parse(created.body);
    assert.equal(createdBody.record.objective, 'ship preview');
    assert.equal(createdBody.record.status, 'running');
    assert.equal(createdBody.record.sessionId, 'session-1');
    assert.equal(createdBody.record.type, 'run');
    assert.ok(createdBody.record.id);
    assert.ok(createdBody.record.createdAt);

    const fetched = await handler({
        method: 'GET',
        url: `/api/runs/${createdBody.record.id}`,
        headers: { authorization: 'Bearer secret-token' },
    });
    assert.equal(fetched.status, 200);
    const fetchedBody = JSON.parse(fetched.body);
    assert.deepEqual(fetchedBody.record, createdBody.record);
});

test('persist record is readable from a new handler instance sharing the store file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ate-runs-'));
    const createHandler = () => createGatewayHandler({
        token: 'secret-token',
        audit: () => {},
        fetchImpl: async () => { throw new Error('chat unused'); },
        runStore: createRunStore({ dir }),
    });

    const created = await createHandler()({
        method: 'POST',
        url: '/api/runs',
        headers: { authorization: 'Bearer secret-token' },
        body: JSON.stringify({ objective: 'durable record', status: 'paused' }),
    });
    const createdBody = JSON.parse(created.body);

    const fetched = await createHandler()({
        method: 'GET',
        url: `/api/runs/${createdBody.record.id}`,
        headers: { authorization: 'Bearer secret-token' },
    });
    assert.equal(fetched.status, 200);
    const fetchedBody = JSON.parse(fetched.body);
    assert.equal(fetchedBody.record.id, createdBody.record.id);
    assert.equal(fetchedBody.record.objective, 'durable record');
    assert.equal(fetchedBody.record.status, 'paused');
});

test('persist rejects unauthorized callers and client-supplied secrets', async () => {
    const handler = createGatewayHandler({
        token: 'secret-token',
        audit: () => {},
        runStore: createRunStore(),
    });

    const unauthorized = await handler({
        method: 'POST',
        url: '/api/runs',
        headers: {},
        body: JSON.stringify({ objective: 'nope' }),
    });
    assert.equal(unauthorized.status, 401);

    const withSecret = await handler({
        method: 'POST',
        url: '/api/runs',
        headers: { authorization: 'Bearer secret-token' },
        body: JSON.stringify({ objective: 'nope', apiKey: 'sk-leaked' }),
    });
    assert.equal(withSecret.status, 400);
    assert.match(withSecret.body, /provider_key_not_accepted/);
});

test('browser createGatewayRun writes through the shipped handler and can be read back', async () => {
    resetBrowserState();
    const { saveGatewayConfig } = await importFreshFromRoot('src/engine/gatewayConfig.js');
    const { createGatewayRun, getGatewayRun } = await importFreshFromRoot('src/engine/gatewayRuns.js');
    saveGatewayConfig({
        useGateway: true,
        gatewayUrl: 'http://gateway.local',
        accessToken: 'secret-token',
    });

    const handler = createGatewayHandler({
        token: 'secret-token',
        audit: () => {},
        runStore: createRunStore(),
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const parsed = new URL(url, 'http://gateway.local');
        const result = await handler({
            method: init.method || 'GET',
            url: `${parsed.pathname}${parsed.search}`,
            headers: init.headers || {},
            body: init.body || '',
        });
        return {
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            json: async () => JSON.parse(result.body),
        };
    };

    try {
        const created = await createGatewayRun({ objective: 'from browser client', status: 'created' });
        assert.equal(created.objective, 'from browser client');
        const fetched = await getGatewayRun(created.id);
        assert.equal(fetched.id, created.id);
        assert.equal(fetched.objective, 'from browser client');
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('PATCH updates run status and slim checkpoint; completed cannot return to running', async () => {
    const handler = createGatewayHandler({
        token: 'secret-token',
        audit: () => {},
        runStore: createRunStore(),
    });
    const auth = { authorization: 'Bearer secret-token' };
    const created = JSON.parse((await handler({
        method: 'POST',
        url: '/api/runs',
        headers: auth,
        body: JSON.stringify({ objective: 'state machine', status: 'running' }),
    })).body);

    const patched = await handler({
        method: 'PATCH',
        url: `/api/runs/${created.record.id}`,
        headers: auth,
        body: JSON.stringify({
            status: 'waiting_for_human',
            checkpointType: 'waiting_for_human',
            currentPhase: '登录',
            completedPhases: ['准备'],
        }),
    });
    assert.equal(patched.status, 200);
    const afterPatch = JSON.parse(patched.body).record;
    assert.equal(afterPatch.status, 'waiting_for_human');
    assert.equal(afterPatch.checkpointType, 'waiting_for_human');
    assert.equal(afterPatch.currentPhase, '登录');
    assert.deepEqual(afterPatch.completedPhases, ['准备']);

    const backToRun = await handler({
        method: 'PATCH',
        url: `/api/runs/${created.record.id}`,
        headers: auth,
        body: JSON.stringify({ status: 'running' }),
    });
    assert.equal(backToRun.status, 200);
    const completed = await handler({
        method: 'PATCH',
        url: `/api/runs/${created.record.id}`,
        headers: auth,
        body: JSON.stringify({ status: 'completed' }),
    });
    assert.equal(completed.status, 200);
    const invalid = await handler({
        method: 'PATCH',
        url: `/api/runs/${created.record.id}`,
        headers: auth,
        body: JSON.stringify({ status: 'running' }),
    });
    assert.equal(invalid.status, 409);
    assert.match(invalid.body, /invalid_status_transition/);
});

test('start then stop keeps one gateway run id and ends blocked', async () => {
    resetBrowserState();
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');
    const { saveGatewayConfig } = await importFreshFromRoot('src/engine/gatewayConfig.js');
    const { getGatewayRun } = await importFreshFromRoot('src/engine/gatewayRuns.js');

    saveGatewayConfig({
        useGateway: true,
        gatewayUrl: 'http://gateway.local',
        accessToken: 'secret-token',
    });

    const handler = createGatewayHandler({
        token: 'secret-token',
        audit: () => {},
        runStore: createRunStore(),
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const parsed = new URL(url, 'http://gateway.local');
        const result = await handler({
            method: init.method || 'GET',
            url: `${parsed.pathname}${parsed.search}`,
            headers: init.headers || {},
            body: init.body || '',
        });
        return {
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            json: async () => JSON.parse(result.body || '{}'),
        };
    };

    const ceo = createAgent({ name: 'CEO', role: 'ceo', model: 'mock' });
    const state = {
        agents: [ceo],
        messages: [],
        availableModels: { custom: [{ id: 'mock' }] },
        defaultModel: 'mock',
        decomposition: null,
        workflowCheckpoint: null,
        pendingDecision: null,
        systemStatus: 'idle',
        gatewayRunId: null,
    };
    const dispatch = (action) => {
        if (action.type === 'SET_STATUS') state.systemStatus = action.payload;
        if (action.type === 'SET_DECOMPOSITION') state.decomposition = action.payload;
        if (action.type === 'SET_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = action.payload;
        if (action.type === 'CLEAR_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = null;
        if (action.type === 'SET_GATEWAY_RUN_ID') state.gatewayRunId = action.payload;
        if (action.type === 'ADD_AGENT') state.agents = [...state.agents, action.payload];
        if (action.type === 'UPDATE_AGENT') {
            const { id, ...u } = action.payload;
            state.agents = state.agents.map(a => (a.id === id ? { ...a, ...u } : a));
        }
        if (action.type === 'ADD_MESSAGE') state.messages.push(action.payload);
    };

    try {
        const runner = new CEOAgentRunner(dispatch, () => state, {
            decomposeWithLLM: async () => ({
                objective: '对账目标',
                type: 'test',
                totalPhases: 1,
                estimatedDuration: 1,
                roles: [{ name: '工程师', role: 'dev', color: '#111' }],
                tasks: [{ phase: '开发', assignee: '工程师', subtasks: ['x'], dependencies: [] }],
            }),
        });
        runner._delay = async () => {};
        runner._autoRecommendModel = async () => 'mock';
        runner._emitCEOMessage = () => {};

        await runner.start('对账目标');
        const runId = runner._gatewayRunId || state.gatewayRunId;
        assert.ok(runId, 'expected a gateway run id after start');
        const mid = await getGatewayRun(runId);
        assert.equal(mid.id, runId);
        assert.equal(mid.objective, '对账目标');
        assert.ok(['running', 'waiting_for_config'].includes(mid.status));

        runner.stop();
        await settleAsync(4);
        const done = await getGatewayRun(runId);
        assert.equal(done.id, runId);
        assert.equal(done.status, 'blocked');
        assert.equal(done.objective, '对账目标');
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('alignStateWithGatewayRun notes a gateway record when local checkpoint is gone', async () => {
    const { alignStateWithGatewayRun } = await importFreshFromRoot('src/store/storeRecovery.js');
    const aligned = alignStateWithGatewayRun({
        systemStatus: 'blocked',
        workflowCheckpoint: null,
        messages: [],
    }, {
        id: 'run-align-1',
        objective: '对账',
        status: 'waiting_for_human',
        checkpointType: 'waiting_for_human',
        currentPhase: '登录',
    });
    assert.equal(aligned.gatewayRunId, 'run-align-1');
    assert.equal(aligned.messages.at(-1).source, 'system-recovery');
    assert.match(aligned.messages.at(-1).dialogue.join(''), /run-align-1/);
    assert.match(aligned.messages.at(-1).dialogue.join(''), /waiting_for_human/);
});

test('token bucket rate-limits after rpm', () => {
    let t = 0;
    const bucket = createTokenBucket({ rpm: 2, now: () => t });
    assert.equal(bucket.take().ok, true);
    assert.equal(bucket.take().ok, true);
    assert.equal(bucket.take().ok, false);
    t += 60_000;
    assert.equal(bucket.take().ok, true);
});
