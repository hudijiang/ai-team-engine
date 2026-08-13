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

test('commandInputLogic updates the real store when chairman publishes a new objective', { concurrency: false }, async () => {
    const { useStore } = await importFreshFromRoot('src/store/store.js');
    const { submitObjectiveCommand } = await importFreshFromRoot('src/components/commandInputLogic.js');

    await settleAsync();
    const ceo = useStore.getState().agents.find(agent => agent.name === 'CEO');
    useStore.getState().dispatch({
        type: 'UPDATE_AGENT',
        payload: { id: ceo.id, model: 'gpt-test' },
    });

    let startedObjective = null;
    const result = submitObjectiveCommand({
        objective: '  执行一次真实的集成测试目标  ',
        systemStatus: useStore.getState().systemStatus,
        dispatch: useStore.getState().dispatch,
        getSnapshot: useStore.getState().getSnapshot,
        clearRunnerImpl: () => {},
        replaceRunnerImpl: () => ({
            start(objective) {
                startedObjective = objective;
            },
        }),
    });

    const state = useStore.getState();
    assert.equal(result.status, 'started');
    assert.equal(startedObjective, '执行一次真实的集成测试目标');
    assert.equal(state.currentObjective, '执行一次真实的集成测试目标');
    assert.equal(state.systemStatus, 'running');
    assert.ok(state.currentSessionId);
    assert.equal(state.messages.at(-1)?.role, '董事长');
});

test('restoreConfigCheckpoint drives the real store into blocked state when pending execution cannot be restored', { concurrency: false }, async () => {
    const { useStore } = await importFreshFromRoot('src/store/store.js');
    const { restoreConfigCheckpoint } = await importFreshFromRoot('src/components/commandInputLogic.js');

    await settleAsync();

    const { dispatch, getSnapshot } = useStore.getState();
    dispatch({ type: 'SET_STATUS', payload: 'waiting_for_config' });
    dispatch({
        type: 'SET_WORKFLOW_CHECKPOINT',
        payload: { type: 'waiting_for_config', objective: '恢复失败测试' },
    });

    const result = restoreConfigCheckpoint({
        systemStatus: useStore.getState().systemStatus,
        workflowCheckpoint: useStore.getState().workflowCheckpoint,
        dispatch,
        getSnapshot,
        getRunnerImpl: () => ({
            hasPendingExecution: () => false,
            restorePendingExecution: () => false,
        }),
    });

    const state = useStore.getState();
    assert.equal(result.status, 'blocked');
    assert.equal(state.systemStatus, 'blocked');
    assert.equal(state.workflowCheckpoint, null);
    assert.equal(state.messages.at(-1)?.source, 'system-recovery');
});

test('commandInputActions trim human input and forward it to the active runner', { concurrency: false }, async () => {
    const { useStore } = await importFreshFromRoot('src/store/store.js');
    const { submitHumanInputAction, skipHumanInputAction, resolveDecisionAction, startExecutionFromCheckpoint } = await importFreshFromRoot('src/components/commandInputActions.js');

    await settleAsync();

    let resumed = false;
    let restoredCheckpoint = null;
    let providedInput = null;
    let skippedReason = null;
    let resolvedPayload = null;

    const fakeRunner = {
        hasPendingExecution: () => false,
        restorePendingExecution(checkpoint) {
            restoredCheckpoint = checkpoint;
            return true;
        },
        resume() {
            resumed = true;
        },
        provideHumanInput(input) {
            providedInput = input;
        },
        skipHumanInput(reason) {
            skippedReason = reason;
        },
        resolveDecision(proposalIndex, customText) {
            resolvedPayload = { proposalIndex, customText };
        },
    };

    const runnerGetter = () => fakeRunner;
    const { dispatch, getSnapshot } = useStore.getState();

    const resumeResult = startExecutionFromCheckpoint({
        workflowCheckpoint: { type: 'waiting_for_config', objective: '恢复执行' },
        dispatch,
        getSnapshot,
        getRunnerImpl: runnerGetter,
    });
    const humanResult = submitHumanInputAction({
        humanInput: '  654321  ',
        dispatch,
        getSnapshot,
        getRunnerImpl: runnerGetter,
    });
    const skipResult = skipHumanInputAction({
        dispatch,
        getSnapshot,
        getRunnerImpl: runnerGetter,
    });
    const resolveResult = resolveDecisionAction({
        proposalIndex: 1,
        customText: '采用方案 B',
        dispatch,
        getSnapshot,
        getRunnerImpl: runnerGetter,
    });

    assert.equal(resumeResult.status, 'resumed');
    assert.deepEqual(restoredCheckpoint, { type: 'waiting_for_config', objective: '恢复执行' });
    assert.equal(resumed, true);
    assert.equal(humanResult.status, 'submitted');
    assert.equal(providedInput, '654321');
    assert.equal(skipResult.status, 'skipped');
    assert.equal(skippedReason, 'FORCE_CONTINUE');
    assert.equal(resolveResult.status, 'resolved');
    assert.deepEqual(resolvedPayload, { proposalIndex: 1, customText: '采用方案 B' });
});

test('modelConfigPanelActions hydrate persisted config and cached models into the real store', { concurrency: false }, async () => {
    const { useStore } = await importFreshFromRoot('src/store/store.js');
    const modelConfig = await importFreshFromRoot('src/engine/modelConfig.js');
    const { hydrateModelConfigPanelState } = await importFreshFromRoot('src/components/modelConfigPanelActions.js');

    await settleAsync();

    modelConfig.saveProviderConfigs({
        openai: {
            apiUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-live-test',
            enabled: true,
        },
    });
    modelConfig.saveModelsCache({
        models: [
            { id: 'gpt-5', name: 'gpt-5', provider: 'openai' },
        ],
        timestamp: 123,
    });

    const restored = await hydrateModelConfigPanelState({
        dispatch: useStore.getState().dispatch,
        ensureProviderConfigsHydratedImpl: modelConfig.ensureProviderConfigsHydrated,
        ensureModelsCacheHydratedImpl: modelConfig.ensureModelsCacheHydrated,
    });

    const state = useStore.getState();
    assert.equal(restored.configs.openai.apiKey, 'sk-live-test');
    assert.deepEqual(restored.fetchResults.openai, {
        models: [{ id: 'gpt-5', name: 'gpt-5', provider: 'openai' }],
        error: null,
    });
    assert.deepEqual(state.availableModels.openai, [{ id: 'gpt-5', name: 'gpt-5', provider: 'openai' }]);
});

test('modelConfigPanelActions persist fetched provider models back into cache and store', { concurrency: false }, async () => {
    const { useStore } = await importFreshFromRoot('src/store/store.js');
    const modelConfig = await importFreshFromRoot('src/engine/modelConfig.js');
    const {
        integrateFetchedProviderModels,
        integrateProviderFetchError,
    } = await importFreshFromRoot('src/components/modelConfigPanelActions.js');

    await settleAsync();

    const previousFetchResults = {
        openai: {
            models: [{ id: 'gpt-5', name: 'gpt-5', provider: 'openai' }],
            error: null,
        },
    };

    const next = integrateFetchedProviderModels({
        providerId: 'anthropic',
        models: [{ id: 'claude-4', name: 'claude-4' }],
        previousFetchResults,
        dispatch: useStore.getState().dispatch,
        saveModelsCacheImpl: modelConfig.saveModelsCache,
        timestamp: 456,
    });

    const failure = integrateProviderFetchError({
        providerId: 'google',
        error: new Error('network down'),
        previousFetchResults: next,
    });

    assert.deepEqual(useStore.getState().availableModels.anthropic, [{ id: 'claude-4', name: 'claude-4' }]);
    assert.deepEqual(modelConfig.loadModelsCache(), {
        models: [
            { id: 'gpt-5', name: 'gpt-5', provider: 'openai' },
            { id: 'claude-4', name: 'claude-4', provider: 'anthropic' },
        ],
        timestamp: 456,
    });
    assert.deepEqual(failure.google, {
        models: [],
        error: 'network down',
    });
});

test('Gateway manual model keeps an explicit known-provider mapping', { concurrency: false }, async () => {
    const { useStore } = await importFreshFromRoot('src/store/store.js');
    const modelConfig = await importFreshFromRoot('src/engine/modelConfig.js');
    const { integrateManualProviderModel } = await importFreshFromRoot('src/components/modelConfigPanelActions.js');
    await settleAsync();

    const previous = {};
    const next = integrateManualProviderModel({
        providerId: 'anthropic',
        modelId: '  claude-explicit-test  ',
        previousFetchResults: previous,
        dispatch: useStore.getState().dispatch,
        saveModelsCacheImpl: modelConfig.saveModelsCache,
    });
    const rejected = integrateManualProviderModel({
        providerId: 'custom',
        modelId: 'must-not-route',
        previousFetchResults: next,
        dispatch: () => {
            throw new Error('unknown provider must not dispatch');
        },
        saveModelsCacheImpl: () => {
            throw new Error('unknown provider must not persist');
        },
    });

    assert.deepEqual(next.anthropic.models, [{
        id: 'claude-explicit-test',
        name: 'claude-explicit-test',
        provider: 'anthropic',
    }]);
    assert.deepEqual(useStore.getState().availableModels.anthropic, next.anthropic.models);
    assert.equal(rejected, next);
});
