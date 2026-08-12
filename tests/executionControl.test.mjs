import test from 'node:test';
import assert from 'node:assert/strict';
import {
    importFreshFromRoot,
    resetBrowserState,
    settleAsync,
} from './helpers/browserEnv.mjs';

test('selectParallelReadyTasks skips incomplete deps and serializes same assignee', async () => {
    const {
        selectParallelReadyTasks,
        shouldMarkPhaseComplete,
    } = await importFreshFromRoot('src/engine/executionControl.js');

    const tasks = [
        { phase: 'A', assignee: '工程师', dependencies: [] },
        { phase: 'B', assignee: '工程师', dependencies: [] },
        { phase: 'C', assignee: '设计师', dependencies: ['A'] },
        { phase: 'D', assignee: '产品', dependencies: [] },
    ];
    const completed = new Set();

    const ready = selectParallelReadyTasks(tasks, completed);
    assert.deepEqual(ready.map(t => t.phase).sort(), ['A', 'D'].sort());
    // 同一 assignee 的 B 被延后
    assert.equal(ready.some(t => t.phase === 'B'), false);
    // 依赖未满足的 C 不进入
    assert.equal(ready.some(t => t.phase === 'C'), false);

    completed.add('A');
    const ready2 = selectParallelReadyTasks(tasks.filter(t => !completed.has(t.phase)), completed);
    assert.ok(ready2.some(t => t.phase === 'B') || ready2.some(t => t.phase === 'C'));

    assert.equal(shouldMarkPhaseComplete({ success: true, aborted: false }), true);
    assert.equal(shouldMarkPhaseComplete({ success: true, aborted: true }), false);
    assert.equal(shouldMarkPhaseComplete({ success: false, aborted: false }), false);
    assert.equal(shouldMarkPhaseComplete(null), false);
});

test('createPauseBarrier wakes all waiters on resume and forceRelease', async () => {
    const { createPauseBarrier } = await importFreshFromRoot('src/engine/executionControl.js');
    const barrier = createPauseBarrier();
    barrier.pause();

    let aDone = false;
    let bDone = false;
    const p1 = barrier.waitIfPaused().then(() => { aDone = true; });
    const p2 = barrier.waitIfPaused().then(() => { bDone = true; });

    await settleAsync(2);
    assert.equal(aDone, false);
    assert.equal(bDone, false);
    assert.equal(barrier.waiterCount(), 2);

    barrier.resume();
    await Promise.all([p1, p2]);
    assert.equal(aDone, true);
    assert.equal(bDone, true);

    barrier.pause();
    let cDone = false;
    const p3 = barrier.waitIfPaused().then(() => { cDone = true; });
    await settleAsync(1);
    barrier.forceRelease();
    await p3;
    assert.equal(cDone, true);
    assert.equal(barrier.isPaused(), false);
});

test('createAsyncMutex serializes exclusive critical sections', async () => {
    const { createAsyncMutex } = await importFreshFromRoot('src/engine/executionControl.js');
    const mutex = createAsyncMutex();
    const order = [];

    const slow = mutex.runExclusive(async () => {
        order.push('slow-start');
        await new Promise(r => setTimeout(r, 30));
        order.push('slow-end');
        return 1;
    });
    const fast = mutex.runExclusive(async () => {
        order.push('fast');
        return 2;
    });

    const results = await Promise.all([slow, fast]);
    assert.deepEqual(results, [1, 2]);
    assert.deepEqual(order, ['slow-start', 'slow-end', 'fast']);
});

test('driveExecution only marks successful phases complete', async () => {
    resetBrowserState();
    const { createAgent, AGENT_STATES } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const workerA = createAgent({ name: 'A', role: 'dev' });
    const workerB = createAgent({ name: 'B', role: 'qa' });
    const decomposition = {
        objective: 'test',
        type: 'test',
        roles: [
            { name: 'A', role: 'dev' },
            { name: 'B', role: 'qa' },
        ],
        tasks: [
            { phase: 'p1', assignee: 'A', subtasks: ['s1'], dependencies: [] },
            { phase: 'p2', assignee: 'B', subtasks: ['s2'], dependencies: [] },
        ],
        totalPhases: 2,
        estimatedDuration: 2,
    };

    const state = {
        agents: [ceo, workerA, workerB],
        decomposition,
        messages: [],
        promptLogs: [],
        systemStatus: 'running',
        sessionHistory: [],
        currentObjective: 'test',
        currentSessionId: 's1',
        availableModels: {},
        deliverables: [],
        pendingDecision: null,
        workflowCheckpoint: null,
    };

    const actions = [];
    const dispatch = (action) => {
        actions.push(action);
        if (action.type === 'SET_STATUS') state.systemStatus = action.payload;
        if (action.type === 'UPDATE_AGENT') {
            const { id, ...updates } = action.payload;
            state.agents = state.agents.map(a => (a.id === id ? { ...a, ...updates } : a));
        }
        if (action.type === 'ADD_MESSAGE') state.messages.push(action.payload);
        if (action.type === 'ADD_DELIVERABLE') state.deliverables.push(action.payload);
        if (action.type === 'SET_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = action.payload;
        if (action.type === 'CLEAR_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = null;
    };

    const runner = new CEOAgentRunner(dispatch, () => state);
    runner._delay = async () => {};
    runner._executeAgentPhase = async (_ceo, agent, task) => {
        // A 成功，B 失败
        return task.assignee === 'A';
    };

    await runner._driveExecution(ceo, [workerA, workerB], decomposition);

    // p1 完成，p2 失败 -> 系统 blocked（部分成功）
    assert.equal(state.systemStatus, 'blocked');
    assert.ok(runner._phaseFailures.some(f => f.phase === 'p2'));
    // 不应把失败阶段记成 completed agent state for B as COMPLETED via finalize
    // （因为 _executeAgentPhase 被 mock 为 false，不会 finalize）
    const agentB = state.agents.find(a => a.name === 'B');
    assert.notEqual(agentB.state, AGENT_STATES.COMPLETED);
});

test('stop resolves pending human intervention and does not leave isRunning true', async () => {
    resetBrowserState();
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');
    const { ABORT_REASON } = await importFreshFromRoot('src/engine/executionControl.js');

    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const worker = createAgent({ name: '工程师', role: 'dev' });
    const state = {
        agents: [ceo, worker],
        messages: [],
        systemStatus: 'running',
        decomposition: null,
        workflowCheckpoint: null,
        pendingDecision: null,
        availableModels: {},
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
    };

    const runner = new CEOAgentRunner(dispatch, () => state);
    runner.isRunning = true;

    const pending = runner._requestHumanIntervention(worker, '扫码登录', {
        ceoAgentId: ceo.id,
        teamAgentIds: [worker.id],
        decomposition: { tasks: [] },
        completedPhases: [],
        currentPhase: '登录',
        currentAgentId: worker.id,
        currentSubtaskIndex: 0,
        currentSubtask: '扫码登录',
    });

    await settleAsync(2);
    assert.equal(typeof runner._pendingHumanInput, 'function');
    assert.equal(state.systemStatus, 'waiting_for_human');

    runner.stop(ABORT_REASON.STOPPED);
    const result = await pending;
    assert.equal(result, ABORT_REASON.STOPPED);
    assert.equal(runner.isRunning, false);
    assert.equal(runner._pendingHumanInput, null);
});
