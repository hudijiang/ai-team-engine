import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    importFreshFromRoot,
    readIndexedValue,
    readLocalJSON,
    resetBrowserState,
    settleAsync,
    writeIndexedValue,
} from './helpers/browserEnv.mjs';

beforeEach(() => {
    return settleAsync().then(() => {
        resetBrowserState();
        return settleAsync();
    });
});

test('store uses bootstrap state immediately and then hydrates richer full state from IndexedDB', { concurrency: false }, async () => {
    localStorage.setItem('agent-auto-state', JSON.stringify({
        currentObjective: 'bootstrap-objective',
        currentSessionId: 'bootstrap-session',
        systemStatus: 'completed',
        messages: [
            { role: '系统', dialogue: ['bootstrap'] },
        ],
    }));
    writeIndexedValue('state:full', {
        currentObjective: 'full-objective',
        currentSessionId: 'full-session',
        systemStatus: 'completed',
        messages: [
            { role: '系统', dialogue: ['bootstrap'] },
            { role: 'CEO', dialogue: ['full-1'] },
            { role: '工程师', dialogue: ['full-2'] },
        ],
        promptLogs: [
            { id: 'log-1' },
            { id: 'log-2' },
        ],
    });

    const { useStore } = await importFreshFromRoot('src/store/store.js');

    assert.equal(useStore.getState().hasHydrated, false);
    assert.equal(useStore.getState().currentObjective, 'bootstrap-objective');
    assert.equal(useStore.getState().messages.length, 1);

    await settleAsync(10);

    assert.equal(useStore.getState().hasHydrated, true);
    assert.equal(useStore.getState().currentObjective, 'full-objective');
    assert.equal(useStore.getState().currentSessionId, 'full-session');
    assert.equal(useStore.getState().messages.length, 3);
    assert.equal(useStore.getState().promptLogs.length, 2);
    assert.equal(useStore.getState().agents[0].model, '');
});

test('store hydration does not overwrite newer user mutations that happen before async hydrate completes', { concurrency: false }, async () => {
    localStorage.setItem('agent-auto-state', JSON.stringify({
        currentObjective: 'bootstrap-objective',
        systemStatus: 'idle',
        messages: [],
    }));
    writeIndexedValue('state:full', {
        currentObjective: 'stale-full-objective',
        systemStatus: 'completed',
        messages: [{ role: '系统', dialogue: ['stale'] }],
    });

    const { useStore } = await importFreshFromRoot('src/store/store.js');
    useStore.getState().dispatch({ type: 'SET_OBJECTIVE', payload: 'fresh-objective' });

    await settleAsync(12);

    assert.equal(useStore.getState().hasHydrated, true);
    assert.equal(useStore.getState().currentObjective, 'fresh-objective');
    assert.equal(useStore.getState().systemStatus, 'running');

    const bootstrap = readLocalJSON('agent-auto-state');
    assert.equal(bootstrap.currentObjective, 'fresh-objective');

    const full = readIndexedValue('state:full');
    assert.equal(full.currentObjective, 'fresh-objective');
});

test('store hydration rechecks mutations after delayed Gateway reconciliation', { concurrency: false }, async () => {
    localStorage.setItem('agent-auto-state', JSON.stringify({
        currentObjective: 'bootstrap-objective',
        systemStatus: 'idle',
        messages: [],
        gatewayRunId: 'run-delayed',
    }));
    writeIndexedValue('state:full', {
        currentObjective: 'stale-full-objective',
        systemStatus: 'completed',
        messages: [{ role: '系统', dialogue: ['stale'] }],
        gatewayRunId: 'run-delayed',
    });

    // Store modules share the canonical Gateway config dependency. Mutate that
    // same resource rather than a query-string-isolated test instance.
    const { saveGatewayConfig } = await import('../src/engine/gatewayConfig.js');
    saveGatewayConfig({
        useGateway: true,
        gatewayUrl: 'http://gateway.local',
        accessToken: 'gateway-token',
    });
    await settleAsync(6);

    const previousFetch = globalThis.fetch;
    let releaseResponse;
    let markFetchStarted;
    const fetchStarted = new Promise(resolve => { markFetchStarted = resolve; });
    const delayedBody = new Promise(resolve => { releaseResponse = resolve; });
    globalThis.fetch = async () => {
        markFetchStarted();
        return {
            ok: true,
            status: 200,
            json: async () => delayedBody,
        };
    };

    try {
        const { useStore } = await importFreshFromRoot('src/store/store.js');
        await fetchStarted;
        useStore.getState().dispatch({ type: 'SET_OBJECTIVE', payload: 'fresh-during-gateway' });
        releaseResponse({
            record: {
                id: 'run-delayed',
                objective: 'stale-full-objective',
                status: 'completed',
            },
        });
        await settleAsync(12);

        assert.equal(useStore.getState().hasHydrated, true);
        assert.equal(useStore.getState().currentObjective, 'fresh-during-gateway');
        assert.equal(useStore.getState().systemStatus, 'running');
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('hydration sanitizes inbox entries written by older versions', { concurrency: false }, async () => {
    writeIndexedValue('state:full', {
        currentObjective: 'restore',
        systemStatus: 'completed',
        messages: [],
        inbox: [{
            from: 'A',
            to: 'B',
            content: ['credential sk-proj-1234567890abcdefghijklmnop'],
        }],
    });

    const { useStore } = await importFreshFromRoot('src/store/store.js');
    await useStore.getState().hydrate();
    await settleAsync(4);

    const serialized = JSON.stringify(useStore.getState().inbox);
    assert.equal(serialized.includes('sk-proj-1234567890abcdefghijklmnop'), false);
    assert.match(serialized, /REDACTED/);
});

test('store persists a trimmed bootstrap cache while keeping the full message history in IndexedDB', { concurrency: false }, async () => {
    const { useStore } = await importFreshFromRoot('src/store/store.js');
    const dispatch = useStore.getState().dispatch;

    for (let index = 0; index < 60; index += 1) {
        dispatch({
            type: 'ADD_MESSAGE',
            payload: {
                role: '测试',
                state: 'idle',
                current_task: `任务-${index}`,
                progress: 1,
                collaborators: [],
                dialogue: [`消息 ${index}`],
                next_step: [],
                agentId: `agent-${index}`,
                timestamp: new Date().toISOString(),
            },
        });
    }

    await settleAsync(20);

    const bootstrap = readLocalJSON('agent-auto-state');
    const full = readIndexedValue('state:full');

    assert.equal(bootstrap.messages.length, 50);
    assert.equal(full.messages.length, 60);
    assert.equal(bootstrap.messages[0].current_task, '任务-10');
    assert.equal(full.messages[0].current_task, '任务-0');
    assert.equal(full.messages.at(-1).current_task, '任务-59');
});
