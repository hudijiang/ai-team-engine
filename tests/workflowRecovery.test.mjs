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

function createRunnerHarness(CEOAgentRunner, {
    agents,
    decomposition = null,
    workflowCheckpoint = null,
    pendingDecision = null,
    systemStatus = 'idle',
} = {}) {
    const actions = [];
    const state = {
        agents,
        decomposition,
        workflowCheckpoint,
        pendingDecision,
        systemStatus,
        messages: [],
    };

    const dispatch = (action) => {
        actions.push(action);
        switch (action.type) {
            case 'SET_STATUS':
                state.systemStatus = action.payload;
                break;
            case 'SET_PENDING_DECISION':
                state.pendingDecision = action.payload;
                break;
            case 'RESOLVE_DECISION':
                state.pendingDecision = null;
                break;
            case 'SET_WORKFLOW_CHECKPOINT':
                state.workflowCheckpoint = action.payload;
                break;
            case 'CLEAR_WORKFLOW_CHECKPOINT':
                state.workflowCheckpoint = null;
                break;
            case 'UPDATE_AGENT': {
                const { id, ...updates } = action.payload;
                state.agents = state.agents.map(agent =>
                    agent.id === id ? { ...agent, ...updates } : agent
                );
                break;
            }
            case 'UPDATE_AGENT_HISTORY': {
                const { id, entry } = action.payload;
                state.agents = state.agents.map(agent =>
                    agent.id === id
                        ? { ...agent, conversationHistory: [...(agent.conversationHistory || []), entry] }
                        : agent
                );
                break;
            }
            case 'ADD_MESSAGE':
                state.messages = [...state.messages, action.payload];
                break;
            default:
                break;
        }
    };

    const runner = new CEOAgentRunner(dispatch, () => state);
    runner._delay = async () => {};

    return {
        runner,
        state,
        actions,
        getAgent(agentId) {
            return state.agents.find(agent => agent.id === agentId);
        },
    };
}

test('storeRecovery blocks transient running state after refresh and appends recovery message', { concurrency: false }, async () => {
    const { sanitizeLoadedState } = await importFreshFromRoot('src/store/storeRecovery.js');

    const sanitized = sanitizeLoadedState({
        systemStatus: 'running',
        pendingDecision: { id: 'dec-1' },
        workflowCheckpoint: { type: 'waiting_for_human' },
        messages: [],
    });

    assert.equal(sanitized.systemStatus, 'blocked');
    assert.equal(sanitized.pendingDecision, null);
    assert.equal(sanitized.workflowCheckpoint, null);
    assert.equal(sanitized.messages.at(-1).source, 'system-recovery');
});

test('storeRecovery preserves recoverable waiting_for_config state', { concurrency: false }, async () => {
    const { sanitizeLoadedState } = await importFreshFromRoot('src/store/storeRecovery.js');

    const checkpoint = {
        type: 'waiting_for_config',
        ceoAgentId: 'ceo-1',
        teamAgentIds: ['agent-1'],
        decomposition: { objective: 'ship', tasks: [] },
    };
    const sanitized = sanitizeLoadedState({
        systemStatus: 'waiting_for_config',
        pendingDecision: { id: 'stale' },
        workflowCheckpoint: checkpoint,
        messages: [],
    });

    assert.equal(sanitized.systemStatus, 'waiting_for_config');
    assert.equal(sanitized.pendingDecision, null);
    assert.deepEqual(sanitized.workflowCheckpoint, checkpoint);
    assert.equal(sanitized.messages.length, 0);
});

test('storeRecovery blocks waiting_for_decision when checkpoint or pending decision is incomplete', { concurrency: false }, async () => {
    const { sanitizeLoadedState } = await importFreshFromRoot('src/store/storeRecovery.js');

    const sanitized = sanitizeLoadedState({
        systemStatus: 'waiting_for_decision',
        pendingDecision: null,
        workflowCheckpoint: { type: 'waiting_for_decision' },
        messages: [],
    });

    assert.equal(sanitized.systemStatus, 'blocked');
    assert.equal(sanitized.pendingDecision, null);
    assert.equal(sanitized.workflowCheckpoint, null);
    assert.match(sanitized.messages.at(-1).dialogue[1], /waiting_for_decision/);
});

test('CEOAgentRunner restores pending execution from waiting_for_config checkpoint', { concurrency: false }, async () => {
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceoAgent = createAgent({ name: 'CEO', role: '首席执行官' });
    const worker = createAgent({ name: '工程师', role: '执行' });
    const decomposition = {
        objective: '恢复配置后继续执行',
        tasks: [{ phase: '开发', assignee: worker.name, subtasks: [], dependencies: [] }],
    };
    const state = {
        agents: [ceoAgent, worker],
        decomposition,
        workflowCheckpoint: {
            type: 'waiting_for_config',
            ceoAgentId: ceoAgent.id,
            teamAgentIds: [worker.id],
            decomposition,
        },
    };

    const runner = new CEOAgentRunner(() => {}, () => state);

    assert.equal(runner.hasPendingExecution(), false);
    assert.equal(runner.restorePendingExecution(), true);
    assert.equal(runner.hasPendingExecution(), true);
    assert.equal(runner._pendingExecution.ceoAgent.id, ceoAgent.id);
    assert.deepEqual(runner._pendingExecution.teamAgents.map(agent => agent.id), [worker.id]);
    assert.equal(runner._pendingExecution.decomposition.objective, decomposition.objective);
});

test('CEOAgentRunner refuses to restore pending execution when checkpoint context is incomplete', { concurrency: false }, async () => {
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceoAgent = createAgent({ name: 'CEO', role: '首席执行官' });
    const runner = new CEOAgentRunner(() => {}, () => ({
        agents: [ceoAgent],
        decomposition: null,
        workflowCheckpoint: {
            type: 'waiting_for_config',
            ceoAgentId: ceoAgent.id,
            teamAgentIds: ['missing-agent'],
        },
    }));

    assert.equal(runner.restorePendingExecution(), false);
    assert.equal(runner.hasPendingExecution(), false);
});

test('runnerRuntime reuses the active runner until replace or clear is called', { concurrency: false }, async () => {
    const runtime = await importFreshFromRoot('src/engine/runnerRuntime.js');

    const dispatchA = () => {};
    const getStateA = () => ({ version: 'a' });
    const runnerA = runtime.getRunner(dispatchA, getStateA);

    const dispatchB = () => {};
    const getStateB = () => ({ version: 'b' });
    const runnerB = runtime.getRunner(dispatchB, getStateB);

    assert.equal(runnerA, runnerB);
    assert.equal(runnerB._rawDispatch, dispatchB);
    assert.notEqual(runnerB.dispatch, dispatchB);
    assert.equal(runnerB.getState, getStateB);

    const replaced = runtime.replaceRunner(dispatchA, getStateA);
    assert.notEqual(replaced, runnerA);
    assert.equal(runtime.peekRunner(), replaced);

    runtime.clearRunner();
    assert.equal(runtime.peekRunner(), null);
});

test('provideHumanInput resumes execution from a persisted waiting_for_human checkpoint', { concurrency: false }, async () => {
    const { createAgent, AGENT_STATES } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceoAgent = createAgent({ name: 'CEO', role: '首席执行官' });
    const worker = createAgent({ name: '工程师', role: '执行' });
    const decomposition = {
        objective: '继续执行',
        tasks: [{
            phase: '开发',
            assignee: worker.name,
            subtasks: ['登录系统', '实现功能', '编写说明'],
            dependencies: [],
        }],
    };
    const checkpoint = {
        type: 'waiting_for_human',
        ceoAgentId: ceoAgent.id,
        teamAgentIds: [worker.id],
        decomposition,
        completedPhases: ['准备'],
        currentPhase: '开发',
        currentAgentId: worker.id,
        currentSubtaskIndex: 0,
        currentSubtask: '登录系统',
        phaseStartedAt: '2026-03-24T10:00:00.000Z',
    };
    const harness = createRunnerHarness(CEOAgentRunner, {
        agents: [ceoAgent, worker],
        decomposition,
        workflowCheckpoint: checkpoint,
        systemStatus: 'waiting_for_human',
    });
    const { runner, state, getAgent } = harness;

    let runRemainingArgs = null;
    let finalizeArgs = null;
    let driveArgs = null;
    let executeSubtaskArgs = null;
    const ceoMessages = [];
    const agentMessages = [];

    runner._emitCEOMessage = (...args) => ceoMessages.push(args);
    runner._emitAgentMessage = (...args) => agentMessages.push(args);
    // 冷恢复：必须注入脱敏上下文，且仅 success 才能继续
    runner._executeSubtask = async (...args) => {
        executeSubtaskArgs = args;
        return {
            status: 'success',
            summary: ['【工程师】已完成：登录系统'],
            content: '登录成功',
            source: 'llm',
        };
    };
    runner._runRemainingSubtasks = async (...args) => {
        runRemainingArgs = args;
        return true;
    };
    runner._finalizeAgentPhase = async (...args) => {
        finalizeArgs = args;
        return true; // QA pass
    };
    runner._driveExecution = async (...args) => {
        driveArgs = args;
    };

    runner.provideHumanInput('验证码 1234');
    await settleAsync(8);

    assert.equal(state.systemStatus, 'running');
    // 原子提升：恢复时不得先清空；mock 的 drive 未清理时保持 running_execution
    assert.ok(
        state.workflowCheckpoint === null
        || state.workflowCheckpoint?.type === 'running_execution'
    );
    if (state.workflowCheckpoint?.type === 'running_execution') {
        assert.equal(state.workflowCheckpoint.promotedFrom, 'waiting_for_human');
    }
    assert.equal(runner.isRunning, false);
    assert.equal(getAgent(ceoAgent.id).state, AGENT_STATES.EXECUTING);
    assert.equal(getAgent(ceoAgent.id).currentTask, '协调协作，驱动执行');
    assert.equal(getAgent(worker.id).state, AGENT_STATES.EXECUTING);
    assert.equal(getAgent(worker.id).currentTask, '登录系统');
    // 当前子任务须使用脱敏安全上下文，禁止验证码原文进入执行函数
    assert.equal(executeSubtaskArgs[1], '登录系统');
    assert.equal(String(executeSubtaskArgs[4] || '').includes('1234'), false);
    assert.match(String(executeSubtaskArgs[4] || ''), /脱敏|人类完成|已接收|协助/i);
    // 后续从 index+1 继续
    assert.equal(runRemainingArgs[5], 1);
    assert.equal(runRemainingArgs[6], checkpoint.phaseStartedAt);
    assert.equal(finalizeArgs[2].phase, '开发');
    assert.deepEqual([...driveArgs[3].completedPhases], ['准备', '开发']);
    assert.match(ceoMessages[0][1][0], /已接收董事长协助|协助/);
    assert.match(agentMessages[0][1][0], /已完成：登录系统/);
});

test('provideHumanInput falls back to blocked state when persisted human checkpoint is incomplete', { concurrency: false }, async () => {
    const { createAgent, AGENT_STATES } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceoAgent = createAgent({ name: 'CEO', role: '首席执行官' });
    const checkpoint = {
        type: 'waiting_for_human',
        ceoAgentId: ceoAgent.id,
        teamAgentIds: ['missing-agent'],
        decomposition: { objective: '失效恢复', tasks: [] },
        currentPhase: '开发',
        currentAgentId: 'missing-agent',
        currentSubtaskIndex: 0,
    };
    const harness = createRunnerHarness(CEOAgentRunner, {
        agents: [ceoAgent],
        decomposition: checkpoint.decomposition,
        workflowCheckpoint: checkpoint,
        systemStatus: 'waiting_for_human',
    });
    const { runner, state, getAgent } = harness;

    const ceoMessages = [];
    runner._emitCEOMessage = (...args) => ceoMessages.push(args);
    runner._emitAgentMessage = () => {};

    runner.provideHumanInput('任意输入');
    await settleAsync(8);

    assert.equal(state.systemStatus, 'blocked');
    assert.equal(state.workflowCheckpoint, null);
    assert.equal(runner.isRunning, false);
    assert.equal(getAgent(ceoAgent.id).state, AGENT_STATES.BLOCKED);
    assert.equal(getAgent(ceoAgent.id).currentTask, '人工协助恢复失败');
    assert.match(ceoMessages[0][1][0], /缺少必要的阶段信息|未找到可恢复/);
});

test('resolveDecision resumes execution from a persisted waiting_for_decision checkpoint', { concurrency: false }, async () => {
    const { createAgent, AGENT_STATES } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceoAgent = createAgent({ name: 'CEO', role: '首席执行官' });
    const agentA = createAgent({ name: '架构师', role: '方案A' });
    const agentB = createAgent({ name: '工程师', role: '方案B' });
    const decomposition = {
        objective: '做出路线决策',
        tasks: [
            { phase: '方案评审', assignee: agentA.name, subtasks: ['对比方案'], dependencies: [] },
            { phase: '实施', assignee: agentB.name, subtasks: ['落地执行'], dependencies: ['方案评审'] },
        ],
    };
    const pendingDecision = {
        topic: '技术路线',
        agentA: agentA.name,
        agentB: agentB.name,
        proposals: [
            { title: '方案 A', description: 'A', pros: '快', cons: '旧' },
            { title: '方案 B', description: 'B', pros: '稳', cons: '慢' },
        ],
    };
    const checkpoint = {
        type: 'waiting_for_decision',
        ceoAgentId: ceoAgent.id,
        teamAgentIds: [agentA.id, agentB.id],
        decomposition,
        completedPhases: ['调研'],
        currentPhase: '方案评审',
        topic: pendingDecision.topic,
        agentAId: agentA.id,
        agentBId: agentB.id,
    };
    const harness = createRunnerHarness(CEOAgentRunner, {
        agents: [ceoAgent, agentA, agentB],
        decomposition,
        workflowCheckpoint: checkpoint,
        pendingDecision,
        systemStatus: 'waiting_for_decision',
    });
    const { runner, state, getAgent } = harness;

    let driveArgs = null;
    const ceoMessages = [];
    runner._emitCEOMessage = (...args) => ceoMessages.push(args);
    runner._driveExecution = async (...args) => {
        driveArgs = args;
    };

    runner.resolveDecision(1);
    await settleAsync(8);

    assert.equal(state.systemStatus, 'running');
    assert.equal(state.pendingDecision, null);
    // 原子提升：恢复中保持 running_execution（mock drive 未清理）
    assert.ok(
        state.workflowCheckpoint === null
        || state.workflowCheckpoint?.type === 'running_execution'
    );
    if (state.workflowCheckpoint?.type === 'running_execution') {
        assert.equal(state.workflowCheckpoint.promotedFrom, 'waiting_for_decision');
    }
    assert.equal(runner.isRunning, false);
    assert.equal(getAgent(ceoAgent.id).state, AGENT_STATES.EXECUTING);
    assert.equal(getAgent(ceoAgent.id).currentTask, '根据董事长决策恢复执行');
    assert.match(getAgent(agentA.id).conversationHistory.at(-1).content, /方案 B/);
    assert.match(getAgent(agentB.id).conversationHistory.at(-1).content, /技术路线/);
    assert.deepEqual([...driveArgs[3].completedPhases], ['调研', '方案评审']);
    assert.match(ceoMessages[0][1][0], /董事长已做出决策/);
});

test('resolveDecision falls back to blocked state when persisted decision checkpoint cannot be restored', { concurrency: false }, async () => {
    const { createAgent, AGENT_STATES } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceoAgent = createAgent({ name: 'CEO', role: '首席执行官' });
    const pendingDecision = {
        topic: '技术路线',
        agentA: '架构师',
        agentB: '工程师',
        proposals: [{ title: '方案 A' }],
    };
    const checkpoint = {
        type: 'waiting_for_decision',
        ceoAgentId: ceoAgent.id,
        teamAgentIds: ['missing-a', 'missing-b'],
        decomposition: null,
        currentPhase: '方案评审',
        topic: pendingDecision.topic,
    };
    const harness = createRunnerHarness(CEOAgentRunner, {
        agents: [ceoAgent],
        decomposition: null,
        workflowCheckpoint: checkpoint,
        pendingDecision,
        systemStatus: 'waiting_for_decision',
    });
    const { runner, state, getAgent } = harness;

    const ceoMessages = [];
    runner._emitCEOMessage = (...args) => ceoMessages.push(args);

    runner.resolveDecision(0);
    await settleAsync(8);

    assert.equal(state.systemStatus, 'blocked');
    assert.equal(state.pendingDecision, null);
    assert.equal(state.workflowCheckpoint, null);
    assert.equal(runner.isRunning, false);
    assert.equal(getAgent(ceoAgent.id).state, AGENT_STATES.BLOCKED);
    assert.equal(getAgent(ceoAgent.id).currentTask, '董事长决策恢复失败');
    assert.match(ceoMessages[0][1][0], /未找到可恢复的董事长决策上下文/);
});
