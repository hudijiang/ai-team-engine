import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

        await runner.stop();
        await runner.flushGatewaySync();
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

test('unknown provider is rejected and never falls back to OpenAI with custom key', async () => {
    const calls = [];
    const handler = createGatewayHandler({
        token: 'secret-token',
        providerKeys: { custom: 'sk-custom-should-not-leak', openai: 'sk-openai' },
        audit: () => {},
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"x"}}]}' };
        },
    });
    const res = await handler({
        method: 'POST',
        url: '/api/llm/chat',
        headers: { authorization: 'Bearer secret-token' },
        body: JSON.stringify({
            provider: 'google',
            model: 'gemini',
            messages: [{ role: 'user', content: 'hi' }],
        }),
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /unknown_provider/);
    assert.equal(calls.length, 0);
});

test('GET /api/providers lists known providers without secrets', async () => {
    const handler = createGatewayHandler({
        token: 'secret-token',
        providerKeys: { openai: 'sk-server' },
        audit: () => {},
    });
    const unauthorized = await handler({ method: 'GET', url: '/api/providers', headers: {} });
    assert.equal(unauthorized.status, 401);
    const res = await handler({
        method: 'GET',
        url: '/api/providers',
        headers: { authorization: 'Bearer secret-token' },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.providers.some(item => item.id === 'openai' && item.configured === true), true);
    assert.equal(JSON.stringify(body).includes('sk-server'), false);
});

test('stale revision is rejected', async () => {
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
        body: JSON.stringify({ objective: 'rev', status: 'running' }),
    })).body);
    assert.equal(created.record.revision, 1);
    const first = await handler({
        method: 'PATCH',
        url: `/api/runs/${created.record.id}`,
        headers: auth,
        body: JSON.stringify({ status: 'paused', revision: 1 }),
    });
    assert.equal(JSON.parse(first.body).record.revision, 2);
    const stale = await handler({
        method: 'PATCH',
        url: `/api/runs/${created.record.id}`,
        headers: auth,
        body: JSON.stringify({ status: 'running', revision: 1 }),
    });
    assert.equal(stale.status, 409);
    assert.match(stale.body, /stale_revision/);
});

test('getRunner bindStore keeps wrapped dispatch so Gateway PATCH still fires', async () => {
    resetBrowserState();
    const { saveGatewayConfig } = await importFreshFromRoot('src/engine/gatewayConfig.js');
    const { getRunner, peekRunner, clearRunner } = await importFreshFromRoot('src/engine/runnerRuntime.js');
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

    const state = { gatewayRunId: null, systemStatus: 'idle' };
    const dispatch = (action) => {
        if (action.type === 'SET_GATEWAY_RUN_ID') state.gatewayRunId = action.payload;
        if (action.type === 'SET_STATUS') state.systemStatus = action.payload;
    };
    try {
        const first = getRunner(dispatch, () => state);
        first._gatewayRunId = 'pending';
        const created = await handler({
            method: 'POST',
            url: '/api/runs',
            headers: { authorization: 'Bearer secret-token' },
            body: JSON.stringify({ objective: 'ui-path', status: 'running' }),
        });
        const runId = JSON.parse(created.body).record.id;
        first._gatewayRunId = runId;
        first._gatewayRevision = 1;

        const rebound = getRunner(dispatch, () => state);
        assert.equal(rebound, first);
        assert.notEqual(rebound.dispatch, dispatch);
        rebound.dispatch({ type: 'SET_STATUS', payload: 'paused' });
        await rebound.flushGatewaySync();
        const record = JSON.parse((await handler({
            method: 'GET',
            url: `/api/runs/${runId}`,
            headers: { authorization: 'Bearer secret-token' },
        })).body).record;
        assert.equal(record.status, 'paused');
        assert.equal(peekRunner(), first);
    } finally {
        clearRunner();
        globalThis.fetch = previousFetch;
    }
});

test('resume in gateway mode does not require browser vendor keys', async () => {
    resetBrowserState();
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceo = createAgent({ name: 'CEO', role: 'ceo', model: 'gpt-4o-mini' });
    const worker = createAgent({ name: '工程师', role: 'dev', model: 'gpt-4o-mini' });
    const decomposition = {
        objective: 'keyless',
        tasks: [{ phase: '开发', assignee: '工程师', subtasks: ['x'], dependencies: [] }],
    };
    const state = {
        agents: [ceo, worker],
        availableModels: {},
        workflowCheckpoint: { type: 'waiting_for_config', ceoAgentId: ceo.id },
        decomposition,
        systemStatus: 'waiting_for_config',
    };
    const dispatch = (action) => {
        if (action.type === 'SET_STATUS') state.systemStatus = action.payload;
        if (action.type === 'SET_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = action.payload;
        if (action.type === 'UPDATE_AGENT') {
            const { id, ...u } = action.payload;
            state.agents = state.agents.map(a => (a.id === id ? { ...a, ...u } : a));
        }
    };
    let drove = false;
    const runner = new CEOAgentRunner(dispatch, () => state, {
        ensureGatewayConfigHydrated: async () => ({ useGateway: true, gatewayUrl: 'http://g', accessToken: 't' }),
        isGatewayEnabled: () => true,
        ensureProviderConfigsHydrated: async () => ({ openai: { apiUrl: '', apiKey: '' } }),
    });
    runner._pendingExecution = { ceoAgent: ceo, teamAgents: [worker], decomposition };
    runner._delay = async () => {};
    runner._emitCEOMessage = () => {};
    runner._driveExecution = async () => { drove = true; };

    await runner.resume();
    assert.equal(drove, true);
    assert.equal(state.systemStatus, 'running');
});

test('resume in gateway mode keeps config gate when a worker model ID is missing', async () => {
    resetBrowserState();
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');
    const ceo = createAgent({ name: 'CEO', role: 'ceo', model: 'gpt-test' });
    const worker = createAgent({ name: '工程师', role: 'dev', model: '' });
    const decomposition = {
        objective: 'missing-model',
        tasks: [{ phase: '开发', assignee: '工程师', subtasks: ['x'], dependencies: [] }],
    };
    const state = {
        agents: [ceo, worker],
        availableModels: {},
        workflowCheckpoint: { type: 'waiting_for_config', ceoAgentId: ceo.id },
        decomposition,
        systemStatus: 'waiting_for_config',
    };
    let drove = false;
    let warningLines = [];
    const runner = new CEOAgentRunner(() => {}, () => state, {
        ensureGatewayConfigHydrated: async () => ({ useGateway: true, gatewayUrl: 'http://g', accessToken: 't' }),
        isGatewayEnabled: () => true,
    });
    runner._pendingExecution = { ceoAgent: ceo, teamAgents: [worker], decomposition };
    runner._emitCEOMessage = (_agent, lines) => { warningLines = lines; };
    runner._driveExecution = async () => { drove = true; };

    await runner.resume();

    assert.equal(drove, false);
    assert.equal(runner.hasPendingExecution(), true);
    assert.equal(state.systemStatus, 'waiting_for_config');
    assert.match(warningLines.join('\n'), /工程师 未指定模型/);
});

test('resume stops immediately if aborted while Gateway config is hydrating', async () => {
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');
    const ceo = createAgent({ name: 'CEO', role: 'ceo', model: 'gpt-test' });
    const worker = createAgent({ name: '工程师', role: 'dev', model: 'gpt-test' });
    const decomposition = { objective: 'abort', tasks: [] };
    let runner;
    let drove = false;
    runner = new CEOAgentRunner(() => {}, () => ({ agents: [ceo, worker] }), {
        ensureGatewayConfigHydrated: async () => {
            runner._aborted = true;
            return { useGateway: true, gatewayUrl: 'http://g', accessToken: 't' };
        },
        isGatewayEnabled: () => true,
    });
    runner._pendingExecution = { ceoAgent: ceo, teamAgents: [worker], decomposition };
    runner._driveExecution = async () => { drove = true; };

    await runner.resume();
    assert.equal(drove, false);
    assert.equal(runner.isRunning, false);
});

test('queued Gateway patches read revision at execution time and preserve checkpoint fields', async () => {
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');
    const store = createRunStore({ createId: () => 'queued-run' });
    const handler = createGatewayHandler({ token: 'secret-token', runStore: store, audit: () => {} });
    const auth = { authorization: 'Bearer secret-token' };
    await handler({
        method: 'POST',
        url: '/api/runs',
        headers: auth,
        body: JSON.stringify({ objective: 'queued', status: 'running' }),
    });
    const patchGatewayRun = async (id, fields) => {
        const result = await handler({
            method: 'PATCH',
            url: `/api/runs/${id}`,
            headers: auth,
            body: JSON.stringify(fields),
        });
        return result.status === 200 ? JSON.parse(result.body).record : null;
    };
    const runner = new CEOAgentRunner(() => {}, () => ({ gatewayRunId: 'queued-run' }), { patchGatewayRun });
    runner._gatewayRunId = 'queued-run';
    runner._gatewayRevision = 1;

    runner._syncGatewayRun({ status: 'paused' });
    runner._syncGatewayRun({ checkpointType: 'running_execution', currentPhase: '开发' });
    await runner.flushGatewaySync();

    const record = store.get('queued-run');
    assert.equal(record.revision, 3);
    assert.equal(record.status, 'paused');
    assert.equal(record.checkpointType, 'running_execution');
    assert.equal(record.currentPhase, '开发');
});

test('Gateway checkpoint sync normalizes missing type and contains rejected PATCH promises', async () => {
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');
    let sentPatch = null;
    const nullable = new CEOAgentRunner(() => {}, () => ({ gatewayRunId: 'nullable-run' }), {
        patchGatewayRun: async (_id, patch) => {
            sentPatch = patch;
            return { id: 'nullable-run', revision: 2 };
        },
    });
    nullable._gatewayRunId = 'nullable-run';
    nullable._gatewayRevision = 1;
    nullable._setWorkflowCheckpoint({ currentPhase: '开发' });
    await nullable.flushGatewaySync();
    assert.equal(sentPatch.checkpointType, null);

    const rejected = new CEOAgentRunner(() => {}, () => ({ gatewayRunId: 'rejected-run' }), {
        patchGatewayRun: async () => {
            throw new Error('gateway offline');
        },
    });
    rejected._gatewayRunId = 'rejected-run';
    assert.equal(await rejected._syncGatewayRun({ status: 'paused' }), null);
});

test('browser PATCH recovers once from an external stale revision', async () => {
    resetBrowserState();
    const { saveGatewayConfig } = await importFreshFromRoot('src/engine/gatewayConfig.js');
    const { createGatewayRun, patchGatewayRun } = await importFreshFromRoot('src/engine/gatewayRuns.js');
    const store = createRunStore();
    const handler = createGatewayHandler({ token: 'secret-token', runStore: store, audit: () => {} });
    const auth = { authorization: 'Bearer secret-token' };
    saveGatewayConfig({ useGateway: true, gatewayUrl: 'http://gateway.local', accessToken: 'secret-token' });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const parsed = new URL(url);
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
    try {
        const created = await createGatewayRun({ objective: 'stale retry', status: 'running' });
        await handler({
            method: 'PATCH',
            url: `/api/runs/${created.id}`,
            headers: auth,
            body: JSON.stringify({ status: 'paused', revision: 1 }),
        });
        const recovered = await patchGatewayRun(created.id, { status: 'running', revision: 1 });
        assert.equal(recovered.status, 'running');
        assert.equal(recovered.revision, 3);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('configured CORS origin wins on success, auth failure, and preflight', async () => {
    const handler = createGatewayHandler({
        token: 'secret-token',
        corsOrigin: 'http://allowed.example',
        audit: () => {},
    });
    const requests = [
        { method: 'GET', url: '/health', headers: {} },
        { method: 'GET', url: '/api/providers', headers: { authorization: 'Bearer secret-token' } },
        { method: 'POST', url: '/api/llm/chat', headers: {}, body: '{}' },
        { method: 'OPTIONS', url: '/api/llm/chat', headers: {} },
    ];
    for (const request of requests) {
        const result = await handler(request);
        assert.equal(result.headers['Access-Control-Allow-Origin'], 'http://allowed.example');
    }
});

test('Gateway client timeout remains active while response JSON body is pending', async () => {
    const { gatewayFetch } = await importFreshFromRoot('src/engine/gatewayRuns.js');
    const previousFetch = globalThis.fetch;
    let aborted = false;
    globalThis.fetch = async (_url, init = {}) => ({
        ok: true,
        status: 200,
        json: () => new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => {
                aborted = true;
                reject(new DOMException('aborted', 'AbortError'));
            }, { once: true });
        }),
    });
    try {
        const result = await gatewayFetch('/api/runs', {}, 10, {
            useGateway: true,
            gatewayUrl: 'http://gateway.local',
            accessToken: 'secret-token',
        });
        assert.equal(result, null);
        assert.equal(aborted, true);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('upstream response limit stops a streaming body before full buffering', async () => {
    let cancelled = false;
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('0123456789ABCDEF'));
        },
        cancel() {
            cancelled = true;
        },
    });
    const handler = createGatewayHandler({
        token: 'secret-token',
        providerKeys: { openai: 'server-only' },
        maxUpstreamChars: 8,
        audit: () => {},
        fetchImpl: async () => new Response(body, { status: 200 }),
    });
    const result = await handler({
        method: 'POST',
        url: '/api/llm/chat',
        headers: { authorization: 'Bearer secret-token' },
        body: JSON.stringify({
            provider: 'openai',
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hi' }],
        }),
    });
    assert.equal(result.status, 502);
    assert.equal(cancelled, true);
});

test('corrupt durable run file fails closed instead of being overwritten from memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ate-corrupt-runs-'));
    const filePath = join(dir, 'runs.json');
    writeFileSync(filePath, '{broken-json', 'utf8');
    const store = createRunStore({ filePath });
    assert.equal(store.isCorrupt(), true);
    assert.throws(() => store.list(), /run_store_corrupt/);
    assert.throws(() => store.create({ objective: 'x' }), /run_store_corrupt/);
});

test('fresh Gateway-only setup reaches initial decomposition and resume without browser vendor keys', async () => {
    resetBrowserState();
    const { saveGatewayConfig } = await importFreshFromRoot('src/engine/gatewayConfig.js');
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');
    saveGatewayConfig({
        useGateway: true,
        gatewayUrl: 'http://gateway.local',
        accessToken: 'secret-token',
    });

    const upstreamCalls = [];
    const decomposition = {
        type: '测试',
        roles: [{ name: '工程师', role: '实现功能', category: 'tech' }],
        tasks: [{
            phase: '开发',
            assignee: '工程师',
            subtasks: ['实现主路径'],
            dependencies: [],
            duration: 1,
        }],
    };
    const handler = createGatewayHandler({
        token: 'secret-token',
        providerKeys: { openai: 'server-vendor-secret' },
        runStore: createRunStore(),
        audit: () => {},
        fetchImpl: async (url, init) => {
            upstreamCalls.push({ url, init });
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    choices: [{ message: { content: JSON.stringify(decomposition) } }],
                }),
            };
        },
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const parsed = new URL(url);
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
            text: async () => result.body || '',
        };
    };

    const ceo = createAgent({ name: 'CEO', role: 'ceo', model: 'gpt-test' });
    const state = {
        agents: [ceo],
        messages: [],
        availableModels: { openai: [{ id: 'gpt-test', name: 'gpt-test', provider: 'openai' }] },
        defaultModel: '',
        decomposition: null,
        workflowCheckpoint: null,
        pendingDecision: null,
        systemStatus: 'idle',
        gatewayRunId: null,
    };
    const dispatch = action => {
        if (action.type === 'SET_STATUS') state.systemStatus = action.payload;
        if (action.type === 'SET_DECOMPOSITION') state.decomposition = action.payload;
        if (action.type === 'SET_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = action.payload;
        if (action.type === 'CLEAR_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = null;
        if (action.type === 'SET_GATEWAY_RUN_ID') state.gatewayRunId = action.payload;
        if (action.type === 'ADD_AGENT') state.agents = [...state.agents, action.payload];
        if (action.type === 'UPDATE_AGENT') {
            const { id, ...updates } = action.payload;
            state.agents = state.agents.map(agent => (agent.id === id ? { ...agent, ...updates } : agent));
        }
        if (action.type === 'ADD_MESSAGE') state.messages.push(action.payload);
    };

    try {
        const runner = new CEOAgentRunner(dispatch, () => state);
        runner._delay = async () => {};
        runner._autoRecommendModel = async () => 'gpt-test';
        runner._emitCEOMessage = () => {};
        await runner.start('仅 Gateway 完成首次拆解');

        assert.equal(state.systemStatus, 'waiting_for_config');
        assert.equal(state.decomposition.type, '测试');
        assert.equal(state.agents.some(agent => agent.name === '工程师' && agent.model === 'gpt-test'), true);
        assert.equal(upstreamCalls.length, 1);
        assert.equal(upstreamCalls[0].init.headers.Authorization, 'Bearer server-vendor-secret');
        assert.equal(String(upstreamCalls[0].init.body).includes('server-vendor-secret'), false);

        let drove = false;
        runner._driveExecution = async () => { drove = true; };
        await runner.resume();
        assert.equal(drove, true);
        assert.equal(state.systemStatus, 'running');
        await runner.stop();
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('run store delete and corrupt disk do not crash the handler', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ate-runs-del-'));
    const store = createRunStore({ dir });
    const handler = createGatewayHandler({
        token: 'secret-token',
        audit: () => {},
        runStore: store,
    });
    const auth = { authorization: 'Bearer secret-token' };
    const created = JSON.parse((await handler({
        method: 'POST',
        url: '/api/runs',
        headers: auth,
        body: JSON.stringify({ objective: 'to-delete', status: 'running' }),
    })).body);
    const removed = await handler({
        method: 'DELETE',
        url: `/api/runs/${created.record.id}`,
        headers: auth,
    });
    assert.equal(removed.status, 200);
    const missing = await handler({
        method: 'GET',
        url: `/api/runs/${created.record.id}`,
        headers: auth,
    });
    assert.equal(missing.status, 404);

    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'runs.json'), '{not-json', 'utf8');
    const broken = createGatewayHandler({
        token: 'secret-token',
        audit: () => {},
        runStore: createRunStore({ dir }),
    });
    const listed = await broken({
        method: 'GET',
        url: '/api/runs',
        headers: auth,
    });
    assert.equal(listed.status, 503);
    assert.match(listed.body, /run_store_corrupt/);
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
