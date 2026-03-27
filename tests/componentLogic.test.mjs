import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    importFreshFromRoot,
    resetBrowserState,
    settleAsync,
} from './helpers/browserEnv.mjs';

beforeEach(() => {
    return settleAsync().then(() => {
        resetBrowserState();
        return settleAsync();
    });
});

test('restoreConfigCheckpoint does nothing outside waiting_for_config state', { concurrency: false }, async () => {
    const { restoreConfigCheckpoint } = await importFreshFromRoot('src/components/commandInputLogic.js');

    let runnerRequested = false;
    const result = restoreConfigCheckpoint({
        systemStatus: 'idle',
        workflowCheckpoint: null,
        dispatch: () => {
            throw new Error('dispatch should not be called');
        },
        getSnapshot: () => ({}),
        getRunnerImpl: () => {
            runnerRequested = true;
            return null;
        },
    });

    assert.equal(result.status, 'noop');
    assert.equal(runnerRequested, false);
});

test('restoreConfigCheckpoint dispatches blocked recovery message when checkpoint restore fails', { concurrency: false }, async () => {
    const { restoreConfigCheckpoint } = await importFreshFromRoot('src/components/commandInputLogic.js');

    const actions = [];
    const result = restoreConfigCheckpoint({
        systemStatus: 'waiting_for_config',
        workflowCheckpoint: { type: 'waiting_for_config' },
        dispatch: (action) => actions.push(action),
        getSnapshot: () => ({}),
        getRunnerImpl: () => ({
            hasPendingExecution: () => false,
            restorePendingExecution: () => false,
        }),
    });

    assert.equal(result.status, 'blocked');
    assert.deepEqual(actions.map(action => action.type), ['CLEAR_WORKFLOW_CHECKPOINT', 'SET_STATUS', 'ADD_MESSAGE']);
    assert.equal(actions[1].payload, 'blocked');
    assert.equal(actions[2].payload.source, 'system-recovery');
});

test('submitObjectiveCommand starts a new runner and dispatches chairman message for valid objective', { concurrency: false }, async () => {
    const { submitObjectiveCommand } = await importFreshFromRoot('src/components/commandInputLogic.js');

    const actions = [];
    let cleared = false;
    let startedObjective = null;
    const fakeRunner = {
        start(objective) {
            startedObjective = objective;
        },
    };

    const result = submitObjectiveCommand({
        objective: '  交付电商小程序  ',
        systemStatus: 'idle',
        dispatch: (action) => actions.push(action),
        getSnapshot: () => ({ snapshot: true }),
        clearRunnerImpl: () => {
            cleared = true;
        },
        replaceRunnerImpl: () => fakeRunner,
    });

    assert.equal(result.status, 'started');
    assert.equal(result.objective, '交付电商小程序');
    assert.equal(result.runner, fakeRunner);
    assert.equal(cleared, true);
    assert.equal(startedObjective, '交付电商小程序');
    assert.deepEqual(actions.map(action => action.type), ['SET_OBJECTIVE', 'ADD_MESSAGE']);
    assert.equal(actions[1].payload.role, '董事长');
});

test('submitObjectiveCommand stays noop while workflow status blocks submission', { concurrency: false }, async () => {
    const { submitObjectiveCommand } = await importFreshFromRoot('src/components/commandInputLogic.js');

    let cleared = false;
    const actions = [];
    const result = submitObjectiveCommand({
        objective: '新的目标',
        systemStatus: 'waiting_for_human',
        dispatch: (action) => actions.push(action),
        getSnapshot: () => ({}),
        clearRunnerImpl: () => {
            cleared = true;
        },
        replaceRunnerImpl: () => ({
            start() {
                throw new Error('runner should not start');
            },
        }),
    });

    assert.equal(result.status, 'noop');
    assert.equal(cleared, false);
    assert.equal(actions.length, 0);
});

test('decisionPanelLogic returns selected proposal payload when chairman picks an existing option', { concurrency: false }, async () => {
    const { getDecisionConfirmState } = await importFreshFromRoot('src/components/decisionPanelLogic.js');

    const result = getDecisionConfirmState({
        selectedIdx: 2,
        showCustom: false,
        customInput: '',
    });

    assert.equal(result.disabled, false);
    assert.deepEqual(result.payload, {
        proposalIndex: 2,
        customText: '',
    });
});

test('decisionPanelLogic prioritizes trimmed custom input when chairman enters a custom plan', { concurrency: false }, async () => {
    const { getDecisionConfirmState } = await importFreshFromRoot('src/components/decisionPanelLogic.js');

    const result = getDecisionConfirmState({
        selectedIdx: null,
        showCustom: true,
        customInput: '  采用折中方案，分阶段切换  ',
    });

    assert.equal(result.disabled, false);
    assert.deepEqual(result.payload, {
        proposalIndex: -1,
        customText: '采用折中方案，分阶段切换',
    });
});

test('decisionPanelLogic disables confirmation when no selection or custom content exists', { concurrency: false }, async () => {
    const { getDecisionConfirmState } = await importFreshFromRoot('src/components/decisionPanelLogic.js');

    const result = getDecisionConfirmState({
        selectedIdx: null,
        showCustom: true,
        customInput: '   ',
    });

    assert.equal(result.disabled, true);
    assert.equal(result.payload, null);
});

test('modelConfigPanelLogic groups cached models by provider and ignores invalid cache rows', { concurrency: false }, async () => {
    const { buildFetchResultsFromCache } = await importFreshFromRoot('src/components/modelConfigPanelLogic.js');

    const result = buildFetchResultsFromCache({
        models: [
            { id: 'gpt-5', provider: 'openai' },
            { id: 'claude-4', provider: 'anthropic' },
            { id: 'gpt-4.1', provider: 'openai' },
            { id: 'orphan-model' },
        ],
    });

    assert.deepEqual(result, {
        openai: {
            models: [
                { id: 'gpt-5', provider: 'openai' },
                { id: 'gpt-4.1', provider: 'openai' },
            ],
            error: null,
        },
        anthropic: {
            models: [
                { id: 'claude-4', provider: 'anthropic' },
            ],
            error: null,
        },
    });
});

test('modelConfigPanelLogic flushes the latest debounced provider config on teardown', { concurrency: false }, async () => {
    const {
        flushPendingProviderConfigAutosave,
        queueProviderConfigAutosave,
    } = await importFreshFromRoot('src/components/modelConfigPanelLogic.js');

    const saveTimerRef = { current: null };
    const latestConfigsRef = { current: null };
    const savedConfigs = [];

    queueProviderConfigAutosave({
        saveTimerRef,
        latestConfigsRef,
        configs: { openai: { apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-old' } },
        saveProviderConfigsImpl: (configs) => savedConfigs.push(configs),
        delay: 1000,
    });

    queueProviderConfigAutosave({
        saveTimerRef,
        latestConfigsRef,
        configs: { openai: { apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-new' } },
        saveProviderConfigsImpl: (configs) => savedConfigs.push(configs),
        delay: 1000,
    });

    const flushed = flushPendingProviderConfigAutosave({
        saveTimerRef,
        latestConfigsRef,
        saveProviderConfigsImpl: (configs) => savedConfigs.push(configs),
    });

    assert.equal(flushed, true);
    assert.equal(saveTimerRef.current, null);
    assert.deepEqual(savedConfigs, [
        { openai: { apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-new' } },
    ]);
});

test('modelConfigPanelLogic flattens fetched provider results back into cache format', { concurrency: false }, async () => {
    const { buildModelsCacheFromFetchResults } = await importFreshFromRoot('src/components/modelConfigPanelLogic.js');

    const result = buildModelsCacheFromFetchResults({
        openai: {
            models: [{ id: 'gpt-5', name: 'gpt-5' }],
            error: null,
        },
        anthropic: {
            models: [{ id: 'claude-4', name: 'claude-4', provider: 'anthropic' }],
            error: null,
        },
    }, 1234567890);

    assert.deepEqual(result, {
        models: [
            { id: 'gpt-5', name: 'gpt-5', provider: 'openai' },
            { id: 'claude-4', name: 'claude-4', provider: 'anthropic' },
        ],
        timestamp: 1234567890,
    });
});

test('modelConfigPanelLogic skips late hydrate payloads after local edits begin', { concurrency: false }, async () => {
    const { shouldApplyHydratedProviderConfigs } = await importFreshFromRoot('src/components/modelConfigPanelLogic.js');

    assert.equal(shouldApplyHydratedProviderConfigs({
        hydrateStartedAt: 100,
        lastLocalMutationAt: 0,
    }), true);

    assert.equal(shouldApplyHydratedProviderConfigs({
        hydrateStartedAt: 100,
        lastLocalMutationAt: 150,
    }), false);
});
