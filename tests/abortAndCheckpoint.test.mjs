import test from 'node:test';
import assert from 'node:assert/strict';
import {
    importFreshFromRoot,
    resetBrowserState,
    settleAsync,
} from './helpers/browserEnv.mjs';

test('createLinkedAbortController aborts on external signal as cancelled', async () => {
    const { createLinkedAbortController, LLM_ERROR } = await importFreshFromRoot('src/engine/llmClient.js');

    const external = new AbortController();
    const linked = createLinkedAbortController(external.signal, 60_000);

    assert.equal(linked.signal.aborted, false);
    external.abort();
    await settleAsync(2);
    assert.equal(linked.signal.aborted, true);
    assert.equal(linked.wasCancelled(), true);
    assert.equal(linked.wasTimedOut(), false);
    linked.clear();
    assert.equal(LLM_ERROR.CANCELLED, 'LLM_CANCELLED');
});

test('createLinkedAbortController times out independently', async () => {
    const { createLinkedAbortController } = await importFreshFromRoot('src/engine/llmClient.js');
    const linked = createLinkedAbortController(null, 20);
    await new Promise(r => setTimeout(r, 40));
    assert.equal(linked.signal.aborted, true);
    assert.equal(linked.wasTimedOut(), true);
    assert.equal(linked.wasCancelled(), false);
    linked.clear();
});

test('storeRecovery keeps running_execution checkpoint as paused after refresh', async () => {
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { sanitizeLoadedState, hasRecoverableRunningCheckpoint } = await importFreshFromRoot('src/store/storeRecovery.js');

    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const worker = createAgent({ name: '工程师', role: 'dev' });
    const decomposition = {
        objective: '续跑',
        tasks: [
            { phase: 'A', assignee: '工程师', subtasks: ['s1'], dependencies: [] },
            { phase: 'B', assignee: '工程师', subtasks: ['s2'], dependencies: ['A'] },
        ],
    };

    const state = {
        systemStatus: 'running',
        agents: [ceo, worker],
        decomposition,
        pendingDecision: null,
        messages: [],
        workflowCheckpoint: {
            type: 'running_execution',
            ceoAgentId: ceo.id,
            teamAgentIds: [worker.id],
            decomposition,
            completedPhases: ['A'],
            phaseFailures: [],
            updatedAt: new Date().toISOString(),
        },
    };

    assert.equal(hasRecoverableRunningCheckpoint(state), true);
    const sanitized = sanitizeLoadedState(state);
    assert.equal(sanitized.systemStatus, 'paused');
    assert.equal(sanitized.workflowCheckpoint.type, 'running_execution');
    assert.deepEqual(sanitized.workflowCheckpoint.completedPhases, ['A']);
    assert.equal(sanitized.messages.at(-1).source, 'system-recovery');
    assert.match(sanitized.messages.at(-1).dialogue.join(''), /检查点|继续/);
});

test('storeRecovery still blocks running without recoverable checkpoint', async () => {
    const { sanitizeLoadedState } = await importFreshFromRoot('src/store/storeRecovery.js');
    const sanitized = sanitizeLoadedState({
        systemStatus: 'running',
        agents: [],
        messages: [],
        workflowCheckpoint: null,
        pendingDecision: null,
    });
    assert.equal(sanitized.systemStatus, 'blocked');
    assert.equal(sanitized.workflowCheckpoint, null);
});

test('resumeFromExecutionCheckpoint continues from completedPhases only', async () => {
    resetBrowserState();
    const { createAgent, AGENT_STATES } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const worker = createAgent({ name: '工程师', role: 'dev' });
    const decomposition = {
        objective: 'checkpoint resume',
        type: 'test',
        roles: [{ name: '工程师', role: 'dev' }],
        tasks: [
            { phase: 'A', assignee: '工程师', subtasks: ['a1'], dependencies: [] },
            { phase: 'B', assignee: '工程师', subtasks: ['b1'], dependencies: ['A'] },
        ],
        totalPhases: 2,
        estimatedDuration: 2,
    };

    const state = {
        agents: [ceo, worker],
        decomposition,
        messages: [],
        promptLogs: [],
        systemStatus: 'paused',
        sessionHistory: [],
        currentObjective: 'checkpoint resume',
        currentSessionId: 's1',
        availableModels: {},
        deliverables: [],
        pendingDecision: null,
        workflowCheckpoint: {
            type: 'running_execution',
            ceoAgentId: ceo.id,
            teamAgentIds: [worker.id],
            decomposition,
            completedPhases: ['A'],
            phaseFailures: [],
        },
    };

    const dispatch = (action) => {
        if (action.type === 'SET_STATUS') state.systemStatus = action.payload;
        if (action.type === 'SET_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = action.payload;
        if (action.type === 'CLEAR_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = null;
        if (action.type === 'UPDATE_AGENT') {
            const { id, ...updates } = action.payload;
            state.agents = state.agents.map(a => (a.id === id ? { ...a, ...updates } : a));
        }
        if (action.type === 'ADD_MESSAGE') state.messages.push(action.payload);
        if (action.type === 'ADD_DELIVERABLE') state.deliverables.push(action.payload);
        if (action.type === 'UPDATE_AGENT_OUTPUTS') {
            const { id, output } = action.payload;
            state.agents = state.agents.map(a =>
                a.id === id ? { ...a, outputs: [...(a.outputs || []), output] } : a
            );
        }
    };

    const runner = new CEOAgentRunner(dispatch, () => state);
    runner._delay = async () => {};
    const executedPhases = [];
    runner._executeAgentPhase = async (_ceo, _agent, task) => {
        executedPhases.push(task.phase);
        return true;
    };

    const ok = await runner.resumeFromExecutionCheckpoint(state.workflowCheckpoint);
    assert.equal(ok, true);
    // A 已完成，只应执行 B
    assert.deepEqual(executedPhases, ['B']);
    assert.equal(state.systemStatus, 'completed');
    assert.equal(state.workflowCheckpoint, null);
    assert.equal(runner.isRunning, false);
});

test('stop aborts run signal so subsequent LLM sees cancelled scope', async () => {
    resetBrowserState();
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');
    const { ABORT_REASON } = await importFreshFromRoot('src/engine/executionControl.js');

    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const state = {
        agents: [ceo],
        messages: [],
        systemStatus: 'running',
        workflowCheckpoint: null,
        pendingDecision: null,
        decomposition: null,
        availableModels: {},
    };
    const dispatch = (action) => {
        if (action.type === 'SET_STATUS') state.systemStatus = action.payload;
        if (action.type === 'CLEAR_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = null;
        if (action.type === 'ADD_MESSAGE') state.messages.push(action.payload);
    };

    const runner = new CEOAgentRunner(dispatch, () => state);
    const signal = runner._beginRunAbortScope();
    runner.isRunning = true;
    assert.equal(signal.aborted, false);

    runner.stop(ABORT_REASON.STOPPED);
    assert.equal(signal.aborted, true);
    assert.equal(runner.isRunning, false);
    assert.equal(runner._runAbortController, null);
});

test('resumeExecutionAction routes to checkpoint resume when runner is cold', async () => {
    const actions = await importFreshFromRoot('src/components/commandInputActions.js');
    let resumed = false;
    const runner = {
        isRunning: false,
        _paused: false,
        resumeFromExecutionCheckpoint: async () => { resumed = true; },
        unpause: () => {},
    };
    const result = actions.resumeExecutionAction({
        workflowCheckpoint: {
            type: 'running_execution',
            completedPhases: ['A'],
            teamAgentIds: ['x'],
            decomposition: { tasks: [] },
        },
        dispatch: () => {},
        getSnapshot: () => ({}),
        getRunnerImpl: () => runner,
        peekRunnerImpl: () => null,
    });
    assert.equal(result.status, 'resumed_checkpoint');
    await settleAsync(2);
    assert.equal(resumed, true);
});

test('resumeExecutionAction unpauses live paused runner first', async () => {
    const actions = await importFreshFromRoot('src/components/commandInputActions.js');
    let unpaused = false;
    let resumedCheckpoint = false;
    const live = {
        isRunning: true,
        _paused: true,
        unpause: () => { unpaused = true; },
        resumeFromExecutionCheckpoint: async () => { resumedCheckpoint = true; },
    };
    const result = actions.resumeExecutionAction({
        workflowCheckpoint: { type: 'running_execution', completedPhases: [] },
        dispatch: () => {},
        getSnapshot: () => ({}),
        getRunnerImpl: () => live,
        peekRunnerImpl: () => live,
    });
    assert.equal(result.status, 'unpaused');
    assert.equal(unpaused, true);
    assert.equal(resumedCheckpoint, false);
});
