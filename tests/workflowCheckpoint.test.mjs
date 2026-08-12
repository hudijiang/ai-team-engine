import test from 'node:test';
import assert from 'node:assert/strict';
import {
    importFreshFromRoot,
    resetBrowserState,
    settleAsync,
} from './helpers/browserEnv.mjs';

test('inferNextSubtaskIndex walks outputs in order and stops at first gap', async () => {
    const {
        inferNextSubtaskIndex,
        isSubtaskOutputPresent,
        upsertInFlight,
        removeInFlight,
        buildRunningExecutionCheckpoint,
        summarizeRunningCheckpoint,
    } = await importFreshFromRoot('src/engine/workflowCheckpoint.js');

    const task = {
        phase: '开发',
        subtasks: ['需求', '编码', '测试'],
    };
    const agent = {
        outputs: [
            { phase: '开发', subtask: '需求', content: 'ok' },
            { phase: '开发', subtask: '编码', content: 'code' },
        ],
    };

    assert.equal(inferNextSubtaskIndex(agent, task), 2);
    assert.equal(isSubtaskOutputPresent(agent, '开发', '编码'), true);
    assert.equal(isSubtaskOutputPresent(agent, '开发', '测试'), false);

    let flight = [];
    flight = upsertInFlight(flight, {
        phase: '开发',
        agentId: 'a1',
        agentName: '工程师',
        nextSubtaskIndex: 2,
        totalSubtasks: 3,
    });
    flight = upsertInFlight(flight, {
        phase: '开发',
        agentId: 'a1',
        nextSubtaskIndex: 3,
        totalSubtasks: 3,
    });
    assert.equal(flight.length, 1);
    assert.equal(flight[0].nextSubtaskIndex, 3);
    flight = removeInFlight(flight, '开发');
    assert.equal(flight.length, 0);

    const cp = buildRunningExecutionCheckpoint({
        ceoAgentId: 'ceo',
        teamAgentIds: ['a1'],
        decomposition: { tasks: [task] },
        completedPhases: [],
        inFlight: [{
            phase: '开发',
            agentId: 'a1',
            agentName: '工程师',
            nextSubtaskIndex: 1,
            totalSubtasks: 3,
        }],
    });
    assert.equal(cp.type, 'running_execution');
    assert.equal(cp.inFlight[0].nextSubtaskIndex, 1);
    const summary = summarizeRunningCheckpoint(cp);
    assert.match(summary.label, /进行中/);
});

test('resumeFromExecutionCheckpoint resumes mid-phase from inFlight subtask index', async () => {
    resetBrowserState();
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const worker = createAgent({ name: '工程师', role: 'dev' });
    worker.outputs = [
        { phase: '开发', subtask: '登录', content: '已登录' },
    ];

    const decomposition = {
        objective: 'subtask resume',
        type: 'test',
        roles: [{ name: '工程师', role: 'dev' }],
        tasks: [
            {
                phase: '开发',
                assignee: '工程师',
                subtasks: ['登录', '实现功能', '写文档'],
                dependencies: [],
            },
        ],
        totalPhases: 1,
        estimatedDuration: 1,
    };

    const state = {
        agents: [ceo, worker],
        decomposition,
        messages: [],
        promptLogs: [],
        systemStatus: 'paused',
        sessionHistory: [],
        currentObjective: 'subtask resume',
        currentSessionId: 's1',
        availableModels: {},
        deliverables: [],
        pendingDecision: null,
        workflowCheckpoint: {
            type: 'running_execution',
            ceoAgentId: ceo.id,
            teamAgentIds: [worker.id],
            decomposition,
            completedPhases: [],
            phaseFailures: [],
            inFlight: [{
                phase: '开发',
                agentId: worker.id,
                agentName: '工程师',
                nextSubtaskIndex: 1,
                totalSubtasks: 3,
                phaseStartedAt: '2026-03-24T10:00:00.000Z',
                currentSubtask: '登录',
            }],
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
        if (action.type === 'UPDATE_AGENT_HISTORY') {
            const { id, entry } = action.payload;
            state.agents = state.agents.map(a =>
                a.id === id
                    ? { ...a, conversationHistory: [...(a.conversationHistory || []), entry] }
                    : a
            );
        }
    };

    const runner = new CEOAgentRunner(dispatch, () => state);
    runner._delay = async () => {};
    runner._checkHumanInterventionNeeded = async () => false;
    runner._runPhaseQualityGate = async () => ({ result: 'pass', suggestion: '', finalContent: 'ok', revised: false });
    runner._recordPhasePerformance = () => {};

    const executedSubtasks = [];
    runner._executeSubtask = async (_agent, subtask) => {
        executedSubtasks.push(subtask);
        return {
            summary: [`done ${subtask}`],
            content: `content ${subtask}`,
            source: 'llm',
        };
    };

    const ok = await runner.resumeFromExecutionCheckpoint(state.workflowCheckpoint);
    assert.equal(ok, true);
    // 登录已有产出应跳过；从「实现功能」开始
    assert.deepEqual(executedSubtasks, ['实现功能', '写文档']);
    assert.equal(state.systemStatus, 'completed');
    assert.equal(state.workflowCheckpoint, null);
});

test('storeRecovery message mentions subtask-level resume', async () => {
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { sanitizeLoadedState } = await importFreshFromRoot('src/store/storeRecovery.js');

    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const worker = createAgent({ name: '工程师', role: 'dev' });
    const decomposition = {
        tasks: [{ phase: 'A', assignee: '工程师', subtasks: ['s1', 's2'], dependencies: [] }],
    };

    const sanitized = sanitizeLoadedState({
        systemStatus: 'running',
        agents: [ceo, worker],
        decomposition,
        messages: [],
        pendingDecision: null,
        workflowCheckpoint: {
            type: 'running_execution',
            ceoAgentId: ceo.id,
            teamAgentIds: [worker.id],
            decomposition,
            completedPhases: [],
            phaseFailures: [],
            inFlight: [{
                phase: 'A',
                agentId: worker.id,
                agentName: '工程师',
                nextSubtaskIndex: 1,
                totalSubtasks: 2,
            }],
        },
    });

    assert.equal(sanitized.systemStatus, 'paused');
    assert.match(sanitized.messages.at(-1).dialogue.join(''), /子任务|断点|检查点/);
});
