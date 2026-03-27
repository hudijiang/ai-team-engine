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
