import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    importFreshFromRoot,
    resetBrowserState,
    settleAsync,
} from './helpers/browserEnv.mjs';

beforeEach(async () => {
    await settleAsync();
    resetBrowserState();
});

function createHarness(CEOAgentRunner, agents, extraState = {}, dependencies = {}) {
    const actions = [];
    const state = {
        agents,
        messages: [],
        deliverables: [],
        promptLogs: [],
        sessionHistory: [],
        availableModels: {},
        defaultModel: '',
        currentObjective: '商业目标',
        currentSessionId: 'session-test',
        systemStatus: 'idle',
        decomposition: null,
        workflowCheckpoint: null,
        pendingDecision: null,
        ...extraState,
    };

    const dispatch = (action) => {
        actions.push(action);
        switch (action.type) {
            case 'SET_STATUS':
                state.systemStatus = action.payload;
                break;
            case 'SET_DECOMPOSITION':
                state.decomposition = action.payload;
                break;
            case 'SET_WORKFLOW_CHECKPOINT':
                state.workflowCheckpoint = action.payload;
                break;
            case 'CLEAR_WORKFLOW_CHECKPOINT':
                state.workflowCheckpoint = null;
                break;
            case 'SET_PENDING_DECISION':
                state.pendingDecision = action.payload;
                break;
            case 'RESOLVE_DECISION':
                state.pendingDecision = null;
                break;
            case 'ROLLBACK_GATE': {
                const { gateId, gateType, status } = action.payload || {};
                if (state.workflowCheckpoint?.gateId === gateId
                    && (!gateType || state.workflowCheckpoint.type === gateType)) {
                    state.workflowCheckpoint = null;
                    state.systemStatus = status || 'blocked';
                }
                if (state.pendingDecision?.gateId === gateId) state.pendingDecision = null;
                break;
            }
            case 'ADD_AGENT':
                state.agents.push(action.payload);
                break;
            case 'REMOVE_AGENT':
                state.agents = state.agents.filter(agent => agent.id !== action.payload);
                break;
            case 'UPDATE_AGENT': {
                const { id, ...updates } = action.payload;
                state.agents = state.agents.map(agent => agent.id === id ? { ...agent, ...updates } : agent);
                break;
            }
            case 'UPDATE_AGENT_OUTPUTS': {
                const { id, output } = action.payload;
                state.agents = state.agents.map(agent => agent.id === id
                    ? { ...agent, outputs: [...(agent.outputs || []), output] }
                    : agent);
                break;
            }
            case 'UPDATE_AGENT_HISTORY': {
                const { id, entry } = action.payload;
                state.agents = state.agents.map(agent => agent.id === id
                    ? { ...agent, conversationHistory: [...(agent.conversationHistory || []), entry] }
                    : agent);
                break;
            }
            case 'ADD_MESSAGE':
                state.messages.push(action.payload);
                break;
            case 'UPSERT_MESSAGE': {
                const index = state.messages.findIndex(message => message.clientId === action.payload.clientId);
                if (index >= 0) state.messages[index] = action.payload;
                else state.messages.push(action.payload);
                break;
            }
            case 'ADD_DELIVERABLE':
                state.deliverables.push(action.payload);
                break;
            default:
                break;
        }
    };

    const runner = new CEOAgentRunner(dispatch, () => state, dependencies);
    runner._delay = async () => {};
    return { runner, state, actions, dispatch };
}

async function fixtures() {
    const { createAgent, AGENT_STATES } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');
    const ceo = createAgent({ name: 'CEO', role: '首席执行官', model: 'ceo-model' });
    const worker = createAgent({ name: '工程师', role: '开发', model: 'worker-model' });
    return { createAgent, AGENT_STATES, CEOAgentRunner, ceo, worker };
}

test('model recommendation and HITL semantic checks cover success and fail-closed variants', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const models = {
        openai: [
            { id: 'model-a', provider: 'openai' },
            { id: 'model-b' },
        ],
    };
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker], {
        availableModels: models,
        defaultModel: 'fallback-ceo',
    });

    runner._callLLMWithRetry = async () => 'model-a';
    assert.equal(await runner._autoRecommendModel('工程师'), 'model-a');
    runner._callLLMWithRetry = async () => 'prefix-model-b-suffix';
    assert.equal(await runner._llmRecommendModel('工程师', models.openai), 'model-b');
    runner._callLLMWithRetry = async () => 'unknown';
    assert.equal(await runner._llmRecommendModel('工程师', models.openai), null);
    runner._llmRecommendModel = async () => { throw new Error('recommend failed'); };
    assert.equal(await runner._autoRecommendModel('工程师'), 'model-a');
    state.availableModels = {};
    assert.equal(await runner._autoRecommendModel('工程师'), '');

    runner._callLLMWithRetry = async () => 'YES';
    assert.equal(await runner._checkHumanInterventionNeeded(worker, '整理需求'), true);
    runner._callLLMWithRetry = async () => 'NO';
    assert.equal(await runner._checkHumanInterventionNeeded(worker, '整理需求'), false);
    runner._callLLMWithRetry = async () => 'MAYBE';
    assert.equal(await runner._checkHumanInterventionNeeded(worker, '整理需求'), true);
    runner._callLLMWithRetry = async () => { throw new Error('judge failed'); };
    assert.equal(await runner._checkHumanInterventionNeeded(worker, '整理需求'), true);
    ceo.model = '';
    state.defaultModel = '';
    assert.equal(await runner._checkHumanInterventionNeeded(worker, '执行发布'), true);
    assert.equal(await runner._checkHumanInterventionNeeded(worker, '分析资料'), false);
    assert.equal(await runner._checkHumanInterventionNeeded(worker, '输入验证码'), true);
});

test('start builds and reuses a team then persists the configuration gate', async () => {
    const { createAgent, CEOAgentRunner, ceo } = await fixtures();
    const reused = createAgent({ name: '工程师', role: '旧职责', color: '#000', model: 'kept-model' });
    reused.outputs = [{ content: 'old' }];
    const decomposition = {
        objective: '上线产品',
        type: '软件',
        totalPhases: 3,
        estimatedDuration: 3,
        roles: [
            { name: '工程师', role: '开发', color: '#123' },
            { name: '测试员', role: '测试', color: '#456', model: 'worker-model' },
            { name: '顾问', role: '咨询', color: '#789', model: 'worker-model' },
        ],
        tasks: [
            { phase: '开发一', assignee: '工程师', subtasks: ['编码'], dependencies: [] },
            { phase: '开发二', assignee: '工程师', subtasks: ['优化'], dependencies: ['开发一'] },
            { phase: '测试', assignee: '测试员', subtasks: ['验收'], dependencies: ['开发二'] },
        ],
    };
    const dependencies = {
        decomposeWithLLM: async (objective, model, availableModels, signal) => {
            assert.equal(objective, '上线产品');
            assert.equal(model, 'ceo-model');
            assert.equal(signal.aborted, false);
            return decomposition;
        },
        // 老版本/最小实现可能尚未返回 revision；Runner 必须从 1 开始。
        createGatewayRun: async () => ({ id: 'run-without-revision' }),
    };
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, reused], {
        availableModels: { custom: [{ id: 'worker-model' }] },
    }, dependencies);
    runner._autoRecommendModel = async () => 'recommended';

    await runner.start('上线产品');

    assert.equal(state.systemStatus, 'waiting_for_config');
    assert.equal(state.workflowCheckpoint.type, 'waiting_for_config');
    assert.equal(state.decomposition, decomposition);
    assert.equal(state.agents.filter(agent => agent.name === '工程师').length, 1);
    assert.equal(state.agents.find(agent => agent.name === '工程师').model, 'kept-model');
    assert.equal(state.agents.find(agent => agent.name === '工程师').currentTask, '开发一 等 2 个阶段');
    assert.ok(state.agents.some(agent => agent.name === '测试员'));
    assert.ok(state.agents.some(agent => agent.name === '顾问' && agent.currentTask === ''));
    assert.equal(runner.hasPendingExecution(), true);
    assert.equal(runner.isRunning, false);
    assert.equal(runner._gatewayRunId, 'run-without-revision');
    assert.equal(runner._gatewayRevision, 1);

    runner.isRunning = true;
    await runner.start('ignored');
    runner.isRunning = false;
});

test('start blocks on missing CEO and decomposition errors, and treats cancellation as clean exit', async () => {
    const { CEOAgentRunner, ceo } = await fixtures();
    const noCeo = createHarness(CEOAgentRunner, []);
    await noCeo.runner.start('x');
    assert.equal(noCeo.state.systemStatus, 'blocked');

    const missingModel = createHarness(CEOAgentRunner, [{ ...ceo, model: '' }], { defaultModel: '' });
    await missingModel.runner.start('x');
    assert.equal(missingModel.state.systemStatus, 'blocked');

    const failed = createHarness(CEOAgentRunner, [ceo], {}, {
        decomposeWithLLM: async () => { throw new Error('bad decomposition'); },
    });
    await failed.runner.start('x');
    assert.equal(failed.state.systemStatus, 'blocked');

    const cancelled = createHarness(CEOAgentRunner, [ceo], {}, {
        decomposeWithLLM: async () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
        },
    });
    await cancelled.runner.start('x');
    assert.equal(cancelled.state.systemStatus, 'idle');

    const gatewayUnavailable = createHarness(CEOAgentRunner, [ceo], {}, {
        decomposeWithLLM: async () => ({
            objective: 'x', type: 'x', totalPhases: 0, estimatedDuration: 0, roles: [], tasks: [],
        }),
        createGatewayRun: async () => {
            throw new Error('gateway unavailable');
        },
    });
    await gatewayUnavailable.runner.start('x');
    assert.equal(gatewayUnavailable.state.systemStatus, 'waiting_for_config');
});

test('resume checks provider configuration, promotes checkpoint, and drives execution', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const decomposition = {
        objective: '执行', type: '软件', roles: [],
        tasks: [{ phase: '开发', assignee: worker.name, subtasks: ['编码'], dependencies: [] }],
    };
    let driveArgs;
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition,
        workflowCheckpoint: {
            type: 'waiting_for_config', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        },
        availableModels: { custom: [{ id: worker.model }] },
    }, {
        ensureProviderConfigsHydrated: async () => ({ custom: { apiUrl: 'https://gateway', apiKey: 'key' } }),
        resolveProviderForModel: () => 'custom',
    });
    runner._pendingExecution = { ceoAgent: ceo, teamAgents: [worker], decomposition };
    runner._driveExecution = async (...args) => { driveArgs = args; };

    await runner.resume();
    assert.equal(state.systemStatus, 'running');
    assert.equal(state.workflowCheckpoint.type, 'running_execution');
    assert.equal(driveArgs[0].id, ceo.id);
    assert.equal(runner.isRunning, false);

    const missing = createHarness(CEOAgentRunner, [ceo, worker], { decomposition }, {
        ensureProviderConfigsHydrated: async () => ({ custom: { apiUrl: '', apiKey: '' } }),
        resolveProviderForModel: () => 'custom',
    });
    missing.runner._pendingExecution = { ceoAgent: ceo, teamAgents: [worker], decomposition };
    await missing.runner.resume();
    assert.equal(missing.runner.hasPendingExecution(), true);

    const broken = createHarness(CEOAgentRunner, [ceo, worker], { decomposition }, {
        ensureProviderConfigsHydrated: async () => { throw new Error('storage failed'); },
    });
    broken.runner._pendingExecution = { ceoAgent: ceo, teamAgents: [worker], decomposition };
    await broken.runner.resume();
    assert.equal(broken.state.systemStatus, 'blocked');
});

test('checkpoint helpers cover gate snapshots, patching, rebuilding, and restoration variants', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const decomposition = {
        objective: 'x', tasks: [{ phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: [] }],
    };
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    runner._persistRunningCheckpoint(null, [worker], decomposition, new Set());
    runner._persistRunningCheckpoint(ceo, [worker], null, new Set());

    state.workflowCheckpoint = {
        type: 'waiting_for_human', gateId: 'g', inFlight: [], runningSnapshot: { inFlight: [] },
    };
    runner._persistRunningCheckpoint(ceo, [worker], decomposition, new Set(['done']), {
        upsertInFlight: { phase: 'A', agentId: worker.id, nextSubtaskIndex: 0 },
    });
    assert.equal(state.workflowCheckpoint.type, 'waiting_for_human');
    assert.equal(state.workflowCheckpoint.runningSnapshot.inFlight.length, 1);
    runner._persistRunningCheckpoint(ceo, [worker], decomposition, new Set(), { removeInFlightPhase: 'A' });
    assert.equal(state.workflowCheckpoint.runningSnapshot.inFlight.length, 0);
    runner._persistRunningCheckpoint(ceo, [worker], decomposition, new Set(), {
        replaceInFlight: [{ phase: 'B', agentId: worker.id }],
    });
    assert.equal(state.workflowCheckpoint.runningSnapshot.inFlight[0].phase, 'B');

    state.workflowCheckpoint = null;
    runner._persistRunningCheckpoint(ceo, [worker], decomposition, new Set(), {
        upsertInFlight: { phase: 'A', agentId: worker.id, nextSubtaskIndex: 0 },
    });
    assert.equal(state.workflowCheckpoint.type, 'running_execution');
    runner._persistRunningCheckpoint(ceo, [worker], decomposition, new Set(['A']), { removeInFlightPhase: 'A' });
    assert.deepEqual(state.workflowCheckpoint.completedPhases, ['A']);

    const restored = runner._restoreCheckpointContext({
        type: 'waiting_for_human', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        completedPhases: [], phaseFailures: [{ phase: 'old', reason: 'x' }], inFlight: [],
        runningSnapshot: { completedPhases: ['A'], phaseFailures: [{ phase: 'B', reason: 'y' }], inFlight: [{ phase: 'A' }] },
    });
    assert.ok(restored.completedPhases.has('A'));
    assert.equal(restored.phaseFailures.length, 2);
    assert.equal(runner._restoreCheckpointContext({ type: 'x' }), null);

    const promoted = runner._promoteGateCheckpointToRunning(
        { type: 'waiting_for_human' }, restored, { inFlight: [] }
    );
    assert.equal(promoted.promotedFrom, 'waiting_for_human');
    assert.equal(runner._refreshTeamAgents([{ id: 'missing' }, worker])[0].id, worker.id);
});

test('subtask execution covers no-model, success, empty, tool-loop, cancellation, and error results', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    worker.outputs = [{ phase: 'old', subtask: '前序', content: '背景' }];
    const baseDependencies = {
        loadExecutionCapabilities: async () => ({ ragContext: 'rag', toolPrompt: 'tools', toolMap: new Map(), policy: {} }),
        shouldUseToolLoop: () => false,
        formatMemoryContext: () => 'memory',
    };
    const { runner, state, actions } = createHarness(CEOAgentRunner, [ceo, worker], {
        sessionHistory: [{ objective: '历史', messages: [{ role: 'A', outputContent: '产出' }] }],
        defaultModel: '',
    }, baseDependencies);
    assert.match(runner._buildSessionContext(), /历史会话1|工程师已完成/);

    const noModel = await runner._executeSubtask({ ...worker, model: '' }, '任务', 0.5);
    assert.equal(noModel.status, 'failed');

    state.defaultModel = 'fallback';
    runner._callLLMWithRetry = async ({ onToken }) => { onToken?.('stream'); return '# 成果\nsk-proj-abcdefghijklmnopqrstuvwxyz'; };
    const success = await runner._executeSubtask({ ...worker, model: '' }, '任务', 0.5, () => {}, '已完成');
    assert.equal(success.status, 'success');
    assert.doesNotMatch(success.content, /sk-proj-/);
    assert.ok(actions.some(action => action.type === 'UPDATE_AGENT_HISTORY'));

    runner._callLLMWithRetry = async () => '   ';
    assert.equal((await runner._executeSubtask(worker, '任务', 0.5)).status, 'failed');
    runner.dependencies.shouldUseToolLoop = () => true;
    runner._runToolAssistedSubtask = async () => '工具成果';
    assert.equal((await runner._executeSubtask(worker, '任务', 0.5)).status, 'success');
    runner._runToolAssistedSubtask = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    assert.equal((await runner._executeSubtask(worker, '任务', 0.5)).status, 'blocked');
    runner._runToolAssistedSubtask = async () => { throw new Error('boom'); };
    assert.equal((await runner._executeSubtask(worker, '任务', 0.5)).source, 'llm-error');
});

test('tool-assisted loop covers no calls, successful tools, previews, streaming, and tool failures', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const toolCalls = [
        { tool: 'read', params: { path: '/tmp/a' } },
        { tool: 'long', params: {} },
    ];
    let llmCalls = 0;
    const { runner } = createHarness(CEOAgentRunner, [ceo, worker], {}, {
        parseToolCalls: () => toolCalls,
        summarizeToolCall: (name) => `call ${name}`,
        executeCapabilityTool: async (_map, name) => ({ ok: true, data: name === 'long' ? 'x'.repeat(300) : 'ok' }),
    });
    runner._callLLMWithRetry = async ({ onToken }) => {
        llmCalls += 1;
        if (llmCalls === 1) return 'tool plan';
        onToken?.('done');
        return 'final';
    };
    let streamed = '';
    const request = {
        model: 'm', availableModels: {}, messages: [{ content: 'system' }],
        userPrompt: 'user', capabilities: { toolMap: new Map(), policy: {} },
    };
    assert.equal(await runner._runToolAssistedSubtask(worker, request, token => { streamed += token; }), 'final');
    assert.equal(streamed, 'done');

    runner.dependencies.parseToolCalls = () => [];
    runner._callLLMWithRetry = async () => 'direct';
    assert.equal(await runner._runToolAssistedSubtask(worker, request), 'direct');

    runner.dependencies.parseToolCalls = () => [{ tool: 'bad', params: {} }];
    runner.dependencies.executeCapabilityTool = async () => ({ ok: false, status: 'denied', error: 'secret sk-proj-abcdefghijklmnopqrstuvwxyz' });
    runner._callLLMWithRetry = async () => 'plan';
    await assert.rejects(runner._runToolAssistedSubtask(worker, request), /工具调用失败/);

});

test('phase helpers, revisions, QA, metrics, and finalization cover pass and revise paths', async () => {
    const { CEOAgentRunner, ceo, worker, AGENT_STATES } = await fixtures();
    const task = { phase: '开发', assignee: worker.name, subtasks: ['设计', '编码'], dependencies: [] };
    worker.outputs = [
        { phase: '开发', subtask: '设计', content: '设计稿' },
        { phase: '其他', subtask: '编码', content: '' },
    ];
    const performance = [];
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition: { tasks: [task] },
        promptLogs: [
            { agentName: worker.name, timestamp: '2026-01-02T00:00:00Z', durationMs: 20, totalTokens: 30 },
            { agentName: 'other', timestamp: '2026-01-02T00:00:00Z', durationMs: 99, totalTokens: 99 },
        ],
    }, {
        formatMemoryContext: () => '',
        recordPerformance: entry => performance.push(entry),
        saveMemory: () => {},
    });
    assert.equal(runner._getPhaseOutputs(worker, task).length, 2);
    assert.match(runner._buildPhaseOutput(worker, task), /设计稿|（空）/);
    assert.equal(runner._buildPhaseOutput({ ...worker, id: 'missing', outputs: [] }, task), '');
    assert.deepEqual(runner._collectPhaseMetrics(worker.name, '2026-01-01T00:00:00Z'), { durationMs: 20, tokenCount: 30 });
    runner._recordPhasePerformance(worker, task, '2026-01-01T00:00:00Z', null, 'abc');
    assert.equal(performance[0].outputLength, 3);

    runner._callLLMWithRetry = async () => '';
    assert.equal(await runner._revisePhaseOutput(worker, task, 'original', ''), 'original');
    runner._callLLMWithRetry = async () => 'revised';
    assert.equal(await runner._revisePhaseOutput(worker, task, 'original', 'more detail'), 'revised');
    runner._callLLMWithRetry = async () => { throw new Error('revision failed'); };
    assert.equal(await runner._revisePhaseOutput(worker, task, 'original', 'x'), 'original');

    runner._callLLMWithRetry = async () => '{"result":"pass"}';
    assert.deepEqual(await runner._qualityReview(worker, '开发', 'content'), { result: 'pass', suggestion: '' });
    runner._callLLMWithRetry = async () => '{"result":"revise","suggestion":" fix "}';
    assert.deepEqual(await runner._qualityReview(worker, '开发', 'content'), { result: 'revise', suggestion: 'fix' });
    runner._callLLMWithRetry = async () => 'bad';
    assert.equal((await runner._qualityReview(worker, '开发', 'content')).result, 'revise');
    runner._callLLMWithRetry = async () => { throw new Error('qa down'); };
    assert.match((await runner._qualityReview(worker, '开发', 'content')).suggestion, /qa down/);

    runner._buildPhaseOutput = () => '';
    assert.equal((await runner._runPhaseQualityGate(ceo, worker, task)).result, 'pass');
    runner._buildPhaseOutput = () => 'phase output';
    runner._qualityReview = async () => ({ result: 'pass', suggestion: '' });
    assert.equal((await runner._runPhaseQualityGate(ceo, worker, task)).revised, false);
    let reviewCount = 0;
    runner._qualityReview = async () => (++reviewCount === 1
        ? { result: 'revise', suggestion: 'fix it' }
        : { result: 'pass', suggestion: '' });
    runner._revisePhaseOutput = async () => 'fixed';
    assert.equal((await runner._runPhaseQualityGate(ceo, worker, task)).revised, true);
    reviewCount = 0;
    runner._qualityReview = async () => (++reviewCount === 1
        ? { result: 'revise', suggestion: '' }
        : { result: 'revise', suggestion: '' });
    assert.equal((await runner._runPhaseQualityGate(ceo, worker, task)).result, 'revise');

    runner._runPhaseQualityGate = async () => ({ result: 'pass', finalContent: 'final' });
    runner._recordPhasePerformance = () => {};
    runner._conductCollaboration = async () => {};
    assert.equal(await runner._finalizeAgentPhase(ceo, worker, task, new Set(), [worker]), true);
    assert.equal(state.agents.find(a => a.id === worker.id).state, AGENT_STATES.COMPLETED);

    runner._runPhaseQualityGate = async () => ({ result: 'revise', suggestion: '', finalContent: '' });
    assert.equal(await runner._finalizeAgentPhase(ceo, worker, task, new Set(), [worker]), false);
});

test('collaboration and consensus cover agreement, retry, fallbacks, escalation cancellation, and failures', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试', model: 'review-model' });
    worker.outputs = [{ subtask: '编码', content: '完成' }];
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        currentObjective: '交付', sessionHistory: [{ objective: 'old', messages: [] }],
    });
    let calls = 0;
    runner._callLLMWithRetry = async () => (++calls % 3 === 0
        ? '{"agreed":true,"summary":"一致","proposals":[]}'
        : 'dialogue');
    await runner._conductCollaboration(ceo, worker, reviewer, '开发', 2);
    assert.ok(state.agents.find(a => a.id === worker.id).conversationHistory.some(e => /共识/.test(e.content)));

    calls = 0;
    runner._callLLMWithRetry = async () => {
        calls += 1;
        if (calls <= 2) throw new Error('speaker failed');
        return '{"agreed":false,"summary":"still split"}';
    };
    runner._escalateDisagreement = async () => {};
    await runner._conductCollaboration(ceo, worker, reviewer, '开发', 1);

    runner._callLLMWithRetry = async () => '{"agreed":false,"summary":"x","proposals":["a"]}';
    assert.equal((await runner._checkConsensus([], 'A', 'B', 'T')).agreed, false);
    runner._callLLMWithRetry = async () => 'not json';
    assert.match((await runner._checkConsensus([], 'A', 'B', 'T')).summary, /失败/);
    runner._callLLMWithRetry = async () => { throw new Error('consensus failed'); };
    assert.equal((await runner._checkConsensus([], 'A', 'B', 'T')).agreed, false);

    runner._aborted = true;
    await runner._conductCollaboration(ceo, worker, reviewer, '开发', 1);
});

test('task validation, deliverables, message boundaries, pause controls, restructure, delay, and stop cover edge variants', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker, AGENT_STATES } = await fixtures();
    const task = { phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: [] };
    worker.outputs = [{ phase: 'A', subtask: 'a', content: 'done', status: 'success' }];
    const decomposition = { objective: 'key sk-proj-abcdefghijklmnopqrstuvwxyz', type: 'software', tasks: [task] };
    const { runner, state, actions } = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition,
        messages: [{ source: 'collaboration', dialogue: ['shared'] }],
    });
    assert.equal(runner._validateTasks([task]).ok, true);
    const invalid = runner._validateTasks([
        { phase: 'A', assignee: '', dependencies: ['missing'] },
        { phase: 'B', assignee: 'x', dependencies: ['C'] },
        { phase: 'C', assignee: 'x', dependencies: ['B'] },
    ]);
    assert.equal(invalid.ok, false);
    assert.match(invalid.issues.join(' '), /缺少负责人|不存在|依赖环/);

    runner._phaseResults.A = { status: 'success', qa: 'pass' };
    const success = runner._buildDeliverable(decomposition, [worker], [task], { completedPhases: ['A'] });
    assert.equal(success.meta.allSuccess, true);
    assert.doesNotMatch(success.content, /sk-proj-/);
    runner._phaseFailures = [{ phase: 'A', reason: 'bad key sk-proj-abcdefghijklmnopqrstuvwxyz' }];
    assert.equal(runner._buildDeliverable(decomposition, [worker], [task]).meta.failedCount, 1);

    ceo.currentTask = 'Bearer abcdefghijklmnop';
    runner._emitCEOMessage(ceo, ['sk-proj-abcdefghijklmnopqrstuvwxyz', null], ['next']);
    runner._emitAgentMessage(worker, ['sk-proj-abcdefghijklmnopqrstuvwxyz'], ['next'], 'llm', 'client', 'sk-proj-abcdefghijklmnopqrstuvwxyz');
    assert.doesNotMatch(JSON.stringify(actions.filter(a => /MESSAGE/.test(a.type)).slice(-2)), /sk-proj-/);

    runner.pause();
    runner.isRunning = true;
    runner.pause();
    assert.equal(state.systemStatus, 'paused');
    runner.unpause();
    assert.equal(state.systemStatus, 'running');
    runner.unpause();

    const removeMe = createAgent({ name: '移除', role: 'old' });
    state.agents.push(removeMe);
    runner.restructure({
        add: [{ name: '新增', role: 'new' }],
        remove: [ceo.id, removeMe.id, 'missing'],
        update: [{ id: worker.id, role: 'updated' }, { id: 'missing', role: 'x' }],
    });
    assert.ok(state.agents.some(a => a.name === '新增'));
    assert.equal(state.agents.some(a => a.id === removeMe.id), false);
    runner.restructure();

    runner._aborted = true;
    await runner._delay(1);
    runner._aborted = false;
    const delayed = runner._delay(1);
    runner._paused = true;
    setTimeout(() => runner._pauseBarrier.resume(), 2);
    await delayed;

    let human;
    let decision;
    runner._pendingHumanInput = value => { human = value; };
    runner._pendingDecisionResolve = value => { decision = value; };
    runner._beginRunAbortScope();
    state.systemStatus = 'waiting_for_decision';
    runner.stop();
    assert.ok(human);
    assert.equal(decision.aborted, true);
    assert.equal(state.systemStatus, 'blocked');
    assert.equal(runner._getRunSignal(), null);
    runner._endRunAbortScope();
    assert.equal(runner._gateInvalidated(runner._gateGeneration), true);
    assert.equal(AGENT_STATES.IDLE, 'idle');
});

test('abort scopes and compatibility rollback cover replacement and legacy dispatch', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const state = {
        agents: [ceo, worker],
        workflowCheckpoint: { type: 'waiting_for_human', gateId: 'owned' },
        pendingDecision: { gateId: 'owned' },
        systemStatus: 'waiting_for_human',
    };
    const actions = [];
    const dispatch = action => {
        actions.push(action);
        if (action.type === 'CLEAR_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = null;
        if (action.type === 'SET_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = action.payload;
        if (action.type === 'RESOLVE_DECISION') state.pendingDecision = null;
        if (action.type === 'SET_STATUS') state.systemStatus = action.payload;
        // Deliberately omit ROLLBACK_GATE support to exercise compatibility cleanup.
    };
    const runner = new CEOAgentRunner(dispatch, () => state);
    let aborts = 0;
    runner._runAbortController = { abort() { aborts += 1; } };
    runner._beginRunAbortScope();
    assert.equal(aborts, 1);
    runner._runAbortController = { abort() { throw new Error('already closed'); } };
    runner._beginRunAbortScope();
    assert.ok(runner._getRunSignal());

    runner._rollbackOwnedGateCompat('owned', 'waiting_for_human');
    assert.equal(state.workflowCheckpoint, null);
    assert.equal(state.pendingDecision, null);
    assert.equal(state.systemStatus, 'blocked');
    assert.ok(actions.some(action => action.type === 'ROLLBACK_GATE'));
    runner._rollbackOwnedGateCompat('', 'waiting_for_human');
    runner._rollbackOwnedGate('', 'waiting_for_human');

    state.workflowCheckpoint = { type: 'other', inFlight: [{ phase: 'A' }] };
    runner._persistRunningCheckpoint(ceo, [worker], { tasks: [] }, new Set(), { removeInFlightPhase: 'A' });
    assert.equal(state.workflowCheckpoint.inFlight.length, 0);
});

test('configuration gate generation races rollback each partially committed state', async () => {
    const { CEOAgentRunner, ceo } = await fixtures();
    const decomposition = {
        objective: 'race', type: 'test', totalPhases: 0, estimatedDuration: 0, roles: [], tasks: [],
    };
    const make = () => createHarness(CEOAgentRunner, [ceo], {}, {
        decomposeWithLLM: async () => decomposition,
    });

    const afterStatus = make();
    const baseStatusDispatch = afterStatus.runner.dispatch;
    afterStatus.runner.dispatch = action => {
        baseStatusDispatch(action);
        if (action.type === 'SET_STATUS' && action.payload === 'waiting_for_config') {
            afterStatus.runner._gateGeneration += 1;
        }
    };
    await afterStatus.runner.start('race');
    assert.equal(afterStatus.state.systemStatus, 'blocked');

    const afterCheckpoint = make();
    const baseCheckpointDispatch = afterCheckpoint.runner.dispatch;
    afterCheckpoint.runner.dispatch = action => {
        baseCheckpointDispatch(action);
        if (action.type === 'SET_WORKFLOW_CHECKPOINT' && action.payload.type === 'waiting_for_config') {
            afterCheckpoint.runner._gateGeneration += 1;
        }
    };
    await afterCheckpoint.runner.start('race');
    assert.equal(afterCheckpoint.state.workflowCheckpoint, null);

    const afterPending = make();
    let pendingValue = null;
    Object.defineProperty(afterPending.runner, '_pendingExecution', {
        configurable: true,
        get: () => pendingValue,
        set: value => {
            pendingValue = value;
            if (value) afterPending.runner._gateGeneration += 1;
        },
    });
    await afterPending.runner.start('race');
    assert.equal(pendingValue, null);

    const outerFailure = make();
    outerFailure.runner._delay = async () => { throw new Error('animation failed'); };
    await outerFailure.runner.start('race');
    assert.equal(outerFailure.state.systemStatus, 'blocked');
    assert.ok(outerFailure.state.messages.some(message => /启动失败/.test(message.dialogue.join(' '))));
});

test('resume restores a persisted config gate and honors empty and already-running guards', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const decomposition = {
        objective: 'resume', tasks: [{ phase: 'A', assignee: worker.name, subtasks: [], dependencies: [] }],
    };
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, { ...worker, model: '' }], {
        decomposition,
        workflowCheckpoint: {
            type: 'waiting_for_config', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        },
    }, {
        ensureProviderConfigsHydrated: async () => ({}),
    });
    let driven = false;
    runner._driveExecution = async () => { driven = true; };
    await runner.resume();
    assert.equal(driven, true);

    state.workflowCheckpoint = null;
    await runner.resume();
    runner._pendingExecution = { ceoAgent: ceo, teamAgents: [worker], decomposition };
    runner.isRunning = true;
    await runner.resume();
    assert.equal(runner.hasPendingExecution(), true);
    runner.isRunning = false;
    assert.equal(runner.restorePendingExecution({ type: 'other' }), false);
});

test('driveExecution covers validation, missing owners, dependency cascade, thrown phases, idle guard, and report fallback', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });

    const invalid = createHarness(CEOAgentRunner, [ceo, worker]);
    await invalid.runner._driveExecution(ceo, [worker], {
        objective: 'x', type: 'x', tasks: [{ phase: 'A', assignee: '', dependencies: [] }],
    });
    assert.equal(invalid.state.systemStatus, 'blocked');

    const cascade = createHarness(CEOAgentRunner, [ceo, worker], { systemStatus: 'running' });
    await cascade.runner._driveExecution(ceo, [worker], {
        objective: 'x', type: 'x', tasks: [
            { phase: 'A', assignee: 'Ghost', subtasks: [], dependencies: [] },
            { phase: 'B', assignee: worker.name, subtasks: [], dependencies: ['A'] },
        ],
    });
    assert.ok(cascade.runner._phaseFailures.some(f => f.phase === 'A'));
    assert.ok(cascade.runner._phaseFailures.some(f => f.phase === 'B' && /依赖/.test(f.reason)));

    const thrown = createHarness(CEOAgentRunner, [ceo, worker, reviewer]);
    thrown.runner._executeAgentPhase = async (_ceo, _agent, task) => {
        if (task.phase === 'A') throw new Error('phase exploded');
        return true;
    };
    await thrown.runner._driveExecution(ceo, [worker, reviewer], {
        objective: 'x', type: 'x', tasks: [
            { phase: 'A', assignee: worker.name, subtasks: [], dependencies: [] },
            { phase: 'B', assignee: reviewer.name, subtasks: [], dependencies: [] },
        ],
    });
    assert.ok(thrown.runner._phaseFailures.some(f => /exploded/.test(f.reason)));

    const idle = createHarness(CEOAgentRunner, [ceo, worker]);
    idle.runner._validateTasks = () => ({ ok: true, issues: [] });
    await idle.runner._driveExecution(ceo, [worker], {
        objective: 'x', type: 'x', tasks: [
            { phase: 'A', assignee: worker.name, subtasks: [], dependencies: ['never'] },
        ],
    });
    assert.equal(idle.state.systemStatus, 'blocked');
    assert.ok(idle.state.messages.some(message => /长时间无进展/.test(message.dialogue.join(' '))));

    const reportFallback = createHarness(CEOAgentRunner, [ceo], { systemStatus: 'running' });
    const baseDispatch = reportFallback.runner.dispatch;
    reportFallback.runner.dispatch = action => {
        if (action.type === 'ADD_MESSAGE' && action.payload.outputContent) throw new Error('message store full');
        baseDispatch(action);
    };
    await reportFallback.runner._driveExecution(ceo, [], { objective: 'x', type: 'x', tasks: [] });
    assert.equal(reportFallback.state.systemStatus, 'completed');
    assert.ok(reportFallback.state.messages.some(message => /交付物已生成/.test(message.dialogue.join(' '))));

    const pendingReport = createHarness(CEOAgentRunner, [ceo, worker]);
    await pendingReport.runner._driveExecution(
        ceo,
        [worker],
        { objective: 'x', type: 'x', tasks: [{ phase: 'A', assignee: worker.name, subtasks: [], dependencies: [] }] },
        { completedPhases: new Set(['unrelated']) }
    );
    assert.ok(pendingReport.state.messages.some(message => /未完成/.test(message.dialogue.join(' '))));
});

test('execution checkpoint recovery covers invalid, missing, skipped, failed, successful, aborted, and exceptional flights', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const task = { phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: [] };
    const ghostTask = { phase: 'G', assignee: 'Ghost', subtasks: ['g'], dependencies: [] };
    const decomposition = { objective: 'x', tasks: [task, ghostTask] };
    const makeCheckpoint = overrides => ({
        type: 'running_execution', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        completedPhases: [], phaseFailures: [], inFlight: [], ...overrides,
    });
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    assert.equal(await runner.resumeFromExecutionCheckpoint({ type: 'other' }), false);
    runner.isRunning = true;
    assert.equal(await runner.resumeFromExecutionCheckpoint(makeCheckpoint()), false);
    runner.isRunning = false;
    assert.equal(await runner.resumeFromExecutionCheckpoint({ ...makeCheckpoint(), teamAgentIds: ['missing'] }), false);
    assert.equal(state.systemStatus, 'blocked');

    let executed = 0;
    let drove = 0;
    runner._executeAgentPhase = async () => { executed += 1; return false; };
    runner._driveExecution = async () => { drove += 1; };
    const mixed = makeCheckpoint({
        completedPhases: ['done'],
        inFlight: [
            { phase: 'done', agentId: worker.id },
            { phase: 'missing-task', agentId: worker.id },
            { phase: 'G', agentId: 'missing', agentName: 'Ghost' },
            { phase: 'A', agentId: worker.id, nextSubtaskIndex: 0 },
        ],
    });
    assert.equal(await runner.resumeFromExecutionCheckpoint(mixed), true);
    assert.equal(executed, 1);
    assert.equal(drove, 1);
    assert.ok(runner._phaseFailures.length >= 3);

    runner._executeAgentPhase = async () => true;
    assert.equal(await runner.resumeFromExecutionCheckpoint(makeCheckpoint({ inFlight: [{ phase: 'A', agentId: worker.id }] })), true);

    runner._promoteGateCheckpointToRunning = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    assert.equal(await runner.resumeFromExecutionCheckpoint(makeCheckpoint()), false);
    runner._promoteGateCheckpointToRunning = () => { throw new Error('restore boom'); };
    assert.equal(await runner.resumeFromExecutionCheckpoint(makeCheckpoint()), false);
    assert.equal(state.systemStatus, 'blocked');

    const aborted = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    aborted.runner._executeAgentPhase = async () => { aborted.runner._aborted = true; return false; };
    aborted.runner._driveExecution = async () => { throw new Error('must not drive'); };
    assert.equal(await aborted.runner.resumeFromExecutionCheckpoint(makeCheckpoint({ inFlight: [{ phase: 'A', agentId: worker.id }] })), false);
});

test('executeAgentPhase covers dependency planning, inferred resume, failure, abort, finalize rejection, and exception paths', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const task = { phase: 'B', assignee: worker.name, subtasks: ['a'], dependencies: ['A'] };
    const decomposition = { tasks: [task] };
    const { runner } = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    runner._runRemainingSubtasks = async () => true;
    runner._finalizeAgentPhase = async () => true;
    assert.equal(await runner._executeAgentPhase(ceo, worker, task, new Set(['A']), [worker]), true);

    runner._runRemainingSubtasks = async () => false;
    assert.equal(await runner._executeAgentPhase(ceo, worker, task, new Set(), [worker], { startIndex: 1 }), false);
    runner._runRemainingSubtasks = async () => true;
    runner._finalizeAgentPhase = async () => false;
    assert.equal(await runner._executeAgentPhase(ceo, worker, task, new Set(), [worker]), false);
    runner._runRemainingSubtasks = async () => { throw new Error('phase error'); };
    assert.equal(await runner._executeAgentPhase(ceo, worker, task, new Set(), [worker]), false);
    runner._aborted = true;
    assert.equal(await runner._executeAgentPhase(ceo, worker, task, new Set(), [worker]), false);
});

test('runRemainingSubtasks covers checkpoint skips, streaming success, model failures, HITL input, skips, cancellation, and gate errors', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const task = { phase: 'A', assignee: worker.name, subtasks: ['cached', 'live'], dependencies: [] };
    const decomposition = { tasks: [task] };
    worker.outputs = [{ phase: 'A', subtask: 'cached', content: 'already', status: 'success' }];
    const successHarness = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    successHarness.runner._checkHumanInterventionNeeded = async () => false;
    successHarness.runner._executeSubtask = async (_agent, _subtask, _progress, onStream) => {
        onStream('part');
        return { status: 'success', source: 'llm', content: 'done', summary: ['done'] };
    };
    assert.equal(await successHarness.runner._runRemainingSubtasks(ceo, worker, task, new Set(), [worker]), true);
    assert.ok(successHarness.state.messages.some(message => message.source === 'checkpoint-skip'));
    assert.ok(successHarness.actions.some(action => action.type === 'UPSERT_MESSAGE' && action.payload.source === 'llm-stream'));

    const failure = createHarness(CEOAgentRunner, [ceo, { ...worker, outputs: [] }], { decomposition });
    failure.runner._checkHumanInterventionNeeded = async () => false;
    failure.runner._executeSubtask = async () => ({ status: 'failed', source: 'llm-error', reason: 'bad' });
    assert.equal(await failure.runner._runRemainingSubtasks(ceo, worker, task, new Set(), [worker]), false);

    const assisted = createHarness(CEOAgentRunner, [ceo, { ...worker, outputs: [] }], { decomposition });
    assisted.runner._checkHumanInterventionNeeded = async () => true;
    assisted.runner._requestHumanIntervention = async () => '验证码 123456';
    assisted.runner._executeSubtask = async (_agent, _subtask, _progress, _stream, context) => {
        assert.doesNotMatch(context, /123456/);
        return { status: 'success', source: 'llm', content: 'ok', summary: ['ok'] };
    };
    assert.equal(await assisted.runner._runRemainingSubtasks(ceo, worker, { ...task, subtasks: ['human'] }, new Set(), [worker]), true);

    for (const result of ['FORCE_CONTINUE', 'SKIPPED_BY_USER', 'TIMEOUT_SKIP', 'STOPPED', 'TIMEOUT_ABORT', 'RESET', 'GATE_CANCELLED']) {
        const skipped = createHarness(CEOAgentRunner, [ceo, { ...worker, outputs: [] }], { decomposition });
        skipped.runner._checkHumanInterventionNeeded = async () => true;
        skipped.runner._requestHumanIntervention = async () => result;
        assert.equal(await skipped.runner._runRemainingSubtasks(ceo, worker, { ...task, subtasks: ['human'] }, new Set(), [worker]), false);
    }

    const cancelledGate = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    cancelledGate.runner._checkHumanInterventionNeeded = async () => true;
    cancelledGate.runner._userGate.runExclusive = async () => { const e = new Error('cancelled'); e.code = 'GATE_CANCELLED'; throw e; };
    assert.equal(await cancelledGate.runner._runRemainingSubtasks(ceo, worker, { ...task, subtasks: ['human'] }, new Set(), [worker]), false);

    const brokenGate = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    brokenGate.runner._checkHumanInterventionNeeded = async () => true;
    brokenGate.runner._userGate.runExclusive = async () => { throw new Error('mutex failed'); };
    await assert.rejects(brokenGate.runner._runRemainingSubtasks(ceo, worker, { ...task, subtasks: ['human'] }, new Set(), [worker]), /mutex failed/);

    const abortAfterCheck = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    abortAfterCheck.runner._checkHumanInterventionNeeded = async () => { abortAfterCheck.runner._aborted = true; return false; };
    assert.equal(await abortAfterCheck.runner._runRemainingSubtasks(ceo, worker, { ...task, subtasks: ['x'] }, new Set(), [worker]), false);
});

test('human gate timers, identity guard, warm provide, warm skip, and invalid generations are safe', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const decomposition = { tasks: [{ phase: 'A', assignee: worker.name, subtasks: ['登录'], dependencies: [] }] };
    const checkpointPayload = {
        ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition, completedPhases: [],
        currentPhase: 'A', currentAgentId: worker.id, currentSubtaskIndex: 0, currentSubtask: '登录',
    };
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    try {
        let timerId = 0;
        globalThis.setTimeout = callback => { callback(); timerId += 1; return timerId; };
        globalThis.clearTimeout = () => {};
        const pending = runner._requestHumanIntervention(worker, '登录账号', checkpointPayload);
        const finish = runner._pendingHumanInput;
        runner._pendingHumanInput = () => {};
        finish('ignored');
        runner._pendingHumanInput = finish;
        runner.provideHumanInput('已完成');
        assert.equal(await pending, '已完成');
        assert.equal(state.systemStatus, 'running');

        const skippedPending = runner._requestHumanIntervention(worker, '普通确认', checkpointPayload);
        runner.skipHumanInput();
        assert.equal(await skippedPending, 'SKIPPED_BY_USER');
        assert.equal(state.systemStatus, 'blocked');
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }

    const invalid = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    invalid.runner._aborted = true;
    assert.equal(await invalid.runner._requestHumanIntervention(worker, 'x'), 'GATE_CANCELLED');

    for (const invalidAt of [2, 3, 4, 5]) {
        const raced = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
        let checks = 0;
        raced.runner._gateInvalidated = () => (++checks >= invalidAt);
        assert.equal(await raced.runner._requestHumanIntervention(worker, 'x', checkpointPayload), 'GATE_CANCELLED');
    }

    runner.provideHumanInput('ignored');
    runner.skipHumanInput('ignored');
});

test('cold HITL recovery covers duplicate, skip, no-input, remainder failure, QA failure, and exception paths', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const task = { phase: 'A', assignee: worker.name, subtasks: ['human', 'rest'], dependencies: [] };
    const decomposition = { tasks: [task] };
    const checkpoint = {
        type: 'waiting_for_human', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        completedPhases: [], currentPhase: 'A', currentAgentId: worker.id,
        currentSubtaskIndex: 0, currentSubtask: 'human', inFlight: [],
    };
    const make = () => createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition, workflowCheckpoint: checkpoint, systemStatus: 'waiting_for_human',
    });

    const duplicate = make();
    duplicate.runner.isRunning = true;
    await duplicate.runner._resumeAfterHumanIntervention(checkpoint, 'done');
    assert.equal(duplicate.state.systemStatus, 'waiting_for_human');

    const skipped = make();
    await skipped.runner._resumeAfterHumanIntervention(checkpoint, 'manual skip', { skipped: true });
    assert.equal(skipped.state.systemStatus, 'blocked');

    const noInput = make();
    noInput.runner._runRemainingSubtasks = async () => true;
    noInput.runner._finalizeAgentPhase = async () => true;
    noInput.runner._driveExecution = async () => {};
    await noInput.runner._resumeAfterHumanIntervention(checkpoint, '');
    assert.equal(noInput.state.systemStatus, 'running');

    const restFailed = make();
    restFailed.runner._executeSubtask = async () => ({ status: 'success', source: 'llm', content: 'ok', summary: ['ok'] });
    restFailed.runner._runRemainingSubtasks = async () => false;
    await restFailed.runner._resumeAfterHumanIntervention(checkpoint, 'done');
    assert.equal(restFailed.state.systemStatus, 'blocked');

    const qaFailed = make();
    qaFailed.runner._executeSubtask = async () => ({ status: 'success', source: 'llm', content: 'ok', summary: ['ok'] });
    qaFailed.runner._runRemainingSubtasks = async () => true;
    qaFailed.runner._finalizeAgentPhase = async () => false;
    await qaFailed.runner._resumeAfterHumanIntervention(checkpoint, 'done');
    assert.equal(qaFailed.state.systemStatus, 'blocked');

    const thrown = make();
    thrown.runner._executeSubtask = async () => { throw new Error('resume exploded'); };
    await thrown.runner._resumeAfterHumanIntervention(checkpoint, 'done');
    assert.equal(thrown.state.systemStatus, 'blocked');
});

test('escalation and decisions cover generated/default proposals, hot resolution, abort cleanup, and cold resume errors', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const decomposition = {
        tasks: [
            { phase: 'A', assignee: worker.name, subtasks: [], dependencies: [] },
            { phase: 'B', assignee: reviewer.name, subtasks: [], dependencies: ['A'] },
        ],
    };
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition });
    runner._callLLMWithRetry = async () => '{"summary":"split","proposals":[{"title":"One"}]}';
    const escalation = runner._escalateDisagreement(ceo, worker, reviewer, 'A', [{ from: 'x', content: 'y' }], {
        ceoAgentId: ceo.id, teamAgentIds: [worker.id, reviewer.id], decomposition,
        completedPhases: [], currentPhase: 'A',
    });
    await settleAsync(2);
    assert.equal(state.systemStatus, 'waiting_for_decision');
    runner.resolveDecision(0);
    await escalation;
    assert.equal(state.systemStatus, 'running');
    assert.equal(state.pendingDecision, null);

    const fallback = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition });
    fallback.runner._callLLMWithRetry = async () => { throw new Error('proposal down'); };
    const fallbackPromise = fallback.runner._escalateDisagreement(ceo, worker, reviewer, 'A', [], {
        teamAgentIds: [worker.id, reviewer.id], decomposition,
    });
    await settleAsync(2);
    assert.equal(fallback.state.pendingDecision.proposals.length, 3);
    fallback.runner.resolveDecision(1, 'custom');
    await fallbackPromise;

    const dead = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition });
    dead.runner._callLLMWithRetry = async () => { dead.runner._gateGeneration += 1; return '{}'; };
    assert.deepEqual(await dead.runner._escalateDisagreement(ceo, worker, reviewer, 'A', []), { aborted: true });

    const cancelled = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition });
    cancelled.runner._callLLMWithRetry = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    assert.deepEqual(await cancelled.runner._escalateDisagreement(ceo, worker, reviewer, 'A', []), { aborted: true });

    runner.resolveDecision(0);
    const noContext = createHarness(CEOAgentRunner, [ceo], { pendingDecision: { topic: 'x', proposals: [] } });
    await noContext.runner._resumeAfterDecision({ type: 'waiting_for_decision' }, 'x');
    assert.equal(noContext.state.systemStatus, 'blocked');

    const checkpoint = {
        type: 'waiting_for_decision', ceoAgentId: ceo.id, teamAgentIds: [worker.id, reviewer.id], decomposition,
        currentPhase: 'A', agentAId: worker.id, agentBId: reviewer.id, topic: 'A', inFlight: [{ phase: 'A' }],
    };
    const duplicate = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        decomposition, workflowCheckpoint: checkpoint, pendingDecision: { topic: 'A', proposals: [] },
    });
    duplicate.runner.isRunning = true;
    await duplicate.runner._resumeAfterDecision(checkpoint, 'x');

    const broken = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        decomposition, workflowCheckpoint: checkpoint, pendingDecision: { topic: 'A', proposals: [] },
    });
    broken.runner._driveExecution = async () => { throw new Error('decision resume failed'); };
    await broken.runner._resumeAfterDecision(checkpoint, 'x');
    assert.equal(broken.state.systemStatus, 'blocked');
});

test('LLM retry policy covers cancellation, config, HTTP, nonretryable, 429, exhaustion, and zero-attempt calls', async () => {
    const { CEOAgentRunner, ceo } = await fixtures();
    const delays = [];
    const { runner } = createHarness(CEOAgentRunner, [ceo], {}, { sendChat: async () => 'ok' });
    runner._delay = async ms => { delays.push(ms); };
    assert.equal(await runner._callLLMWithRetry({ model: 'x' }), 'ok');
    assert.equal(await runner._callLLMWithRetry({ model: 'x' }, 0), undefined);

    runner._aborted = true;
    await assert.rejects(runner._callLLMWithRetry({ model: 'x' }), error => error.code === 'LLM_CANCELLED');
    runner._aborted = false;
    const signal = new AbortController();
    signal.abort();
    await assert.rejects(runner._callLLMWithRetry({ model: 'x', signal: signal.signal }), /取消/);

    for (const error of [
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
        new Error('模型未配置'),
        Object.assign(new Error('LLM 调用失败 401'), { code: 'LLM_HTTP', status: 401 }),
        Object.assign(new Error('do not retry'), { retryable: false }),
    ]) {
        runner.dependencies.sendChat = async () => { throw error; };
        await assert.rejects(runner._callLLMWithRetry({ model: 'x' }), error);
    }

    let calls = 0;
    runner.dependencies.sendChat = async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('rate limited'), { code: 'LLM_HTTP', status: 429 });
        return 'after retry';
    };
    assert.equal(await runner._callLLMWithRetry({ model: 'x' }), 'after retry');
    assert.deepEqual(delays.slice(-2), [500, 1000]);

    runner.dependencies.sendChat = async () => { throw new Error('network'); };
    await assert.rejects(runner._callLLMWithRetry({ model: 'x' }, 2), /network/);
});

test('deliverable variants and pause checkpoint reconstruction cover remaining status and agent branches', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker, AGENT_STATES } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试', model: '' });
    reviewer.state = AGENT_STATES.PLANNING;
    reviewer.phase = 'B';
    reviewer.currentTask = 'review';
    worker.state = AGENT_STATES.COMPLETED;
    worker.phase = 'A';
    worker.outputs = [
        { phase: 'A', subtask: 'a', content: 'legacy' },
        { phase: 'A', subtask: 'extra', content: '', status: 'failed' },
    ];
    const tasks = [
        { phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: [] },
        { phase: 'B', assignee: reviewer.name, subtasks: [], dependencies: ['A'] },
        { phase: 'C', assignee: 'Ghost', subtasks: ['c'], dependencies: [] },
    ];
    const decomposition = { objective: '', type: 'x', tasks };
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition, messages: [] });
    const report = runner._buildDeliverable(decomposition, [worker, reviewer], tasks, {
        completedPhases: new Set(['A', 'B']),
        phaseFailures: [],
        phaseResults: { B: { status: 'success', qa: 'revise' } },
    });
    assert.equal(report.meta.successCount, 1);
    assert.equal(report.meta.failedCount, 1);
    assert.equal(report.meta.incompleteCount, 1);
    assert.match(report.content, /未指定|QA=revise|无已确认/);

    runner.isRunning = true;
    state.workflowCheckpoint = null;
    runner.pause();
    assert.equal(state.workflowCheckpoint.type, 'running_execution');
    assert.ok(state.workflowCheckpoint.completedPhases.includes('A'));
    assert.ok(state.workflowCheckpoint.inFlight.some(flight => flight.phase === 'B'));
    runner.unpause();

    state.workflowCheckpoint = {
        type: 'running_execution', ceoAgentId: ceo.id, teamAgentIds: [worker.id, reviewer.id],
        decomposition, completedPhases: ['A'], inFlight: [{ phase: 'B', agentId: reviewer.id }],
    };
    runner.pause();
    assert.equal(state.workflowCheckpoint.type, 'running_execution');

    const timerAbort = runner._delay(1);
    runner._aborted = true;
    await timerAbort;
});

test('remaining refresh, finalization, cold skip, stream callback, collaboration, and gate race lines execute', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const added = createAgent({ name: '新增', role: 'new' });
    const downstream = createAgent({ name: '下游', role: 'downstream' });
    const task = { phase: 'A', assignee: worker.name, subtasks: ['human'], dependencies: [] };
    const decomposition = {
        tasks: [
            task,
            { phase: 'B', assignee: downstream.name, subtasks: [], dependencies: ['A'] },
            { phase: 'C', assignee: worker.name, subtasks: [], dependencies: ['A'] },
            { phase: 'D', assignee: 'Ghost', subtasks: [], dependencies: ['A'] },
        ],
    };
    worker.outputs = [{ phase: 'A', subtask: 'human', content: 'done', status: 'success' }];
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker, downstream, added], { decomposition }, {
        saveMemory: () => { throw new Error('quota'); },
    });
    assert.ok(runner._refreshTeamAgents([worker]).some(agent => agent.id === added.id));

    let collaborations = 0;
    runner._runPhaseQualityGate = async () => ({ result: 'pass', finalContent: 'content' });
    runner._recordPhasePerformance = () => {};
    runner._conductCollaboration = async () => { collaborations += 1; };
    assert.equal(await runner._finalizeAgentPhase(ceo, worker, task, new Set(), [worker, downstream]), true);
    assert.equal(collaborations, 1);
    runner._aborted = true;
    assert.equal(await runner._finalizeAgentPhase(ceo, worker, task, new Set(), [worker, downstream]), false);
    runner._aborted = false;

    const checkpoint = {
        type: 'waiting_for_human', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        currentPhase: 'A', currentAgentId: worker.id, currentSubtaskIndex: 0, currentSubtask: 'human',
    };
    let coldSkip;
    runner._resumeAfterHumanIntervention = async (...args) => { coldSkip = args; };
    state.workflowCheckpoint = checkpoint;
    runner._pendingHumanInput = null;
    runner.skipHumanInput('cold-skip');
    await settleAsync();
    assert.equal(coldSkip[2].skipped, true);

    const streaming = createHarness(CEOAgentRunner, [ceo, worker], { decomposition, workflowCheckpoint: checkpoint });
    streaming.runner._executeSubtask = async (_agent, _subtask, _progress, onStream) => {
        onStream('streamed');
        return { status: 'success', source: 'llm', content: 'ok', summary: ['ok'] };
    };
    streaming.runner._runRemainingSubtasks = async () => true;
    streaming.runner._finalizeAgentPhase = async () => true;
    streaming.runner._driveExecution = async () => {};
    await streaming.runner._resumeAfterHumanIntervention(checkpoint, 'done');
    assert.ok(streaming.actions.some(action => action.type === 'UPSERT_MESSAGE'));

    const discussion = createHarness(CEOAgentRunner, [ceo, worker, downstream]);
    discussion.runner._callLLMWithRetry = async () => 'dialogue';
    let consensusCalls = 0;
    discussion.runner._checkConsensus = async () => ({ agreed: ++consensusCalls > 1, summary: 'status' });
    await discussion.runner._conductCollaboration(ceo, worker, downstream, 'A', 2);
    assert.ok(discussion.state.messages.some(message => /继续讨论/.test(message.dialogue.join(' '))));

    const cancelled = createHarness(CEOAgentRunner, [ceo, worker, downstream]);
    cancelled.runner._checkConsensus = async () => ({ agreed: false, summary: 'no' });
    cancelled.runner._callLLMWithRetry = async () => 'dialogue';
    cancelled.runner._userGate.runExclusive = async () => { const e = new Error('cancel'); e.code = 'GATE_CANCELLED'; throw e; };
    await cancelled.runner._conductCollaboration(ceo, worker, downstream, 'A', 1);
    cancelled.runner._userGate.runExclusive = async () => { throw new Error('gate crash'); };
    await assert.rejects(cancelled.runner._conductCollaboration(ceo, worker, downstream, 'A', 1), /gate crash/);

    const decisionRace = createHarness(CEOAgentRunner, [ceo, worker, downstream], { decomposition });
    decisionRace.runner._callLLMWithRetry = async () => '{}';
    let invalidChecks = 0;
    decisionRace.runner._gateInvalidated = () => ++invalidChecks >= 8;
    assert.deepEqual(
        await decisionRace.runner._escalateDisagreement(ceo, worker, downstream, 'A', []),
        { aborted: true }
    );
});

test('real delay covers timer callback, paused wait, and abort-after-schedule branches', async () => {
    const { CEOAgentRunner, ceo } = await fixtures();
    const { runner } = createHarness(CEOAgentRunner, [ceo]);
    // Restore the real prototype method because createHarness short-circuits delays.
    runner._delay = CEOAgentRunner.prototype._delay;
    await runner._delay.call(runner, 0);

    runner._pauseBarrier.pause();
    runner._paused = true;
    const paused = runner._delay.call(runner, 0);
    setTimeout(() => {
        runner._paused = false;
        runner._pauseBarrier.resume();
    }, 1);
    await paused;

    const abortLater = runner._delay.call(runner, 1);
    runner._aborted = true;
    await abortLater;

    await runner._delay.call(runner, 0);
});

test('stop resolves a real disagreement gate and reaches abort cleanup', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const decomposition = { tasks: [] };
    const { runner } = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition });
    runner._callLLMWithRetry = async () => '{}';
    const pending = runner._escalateDisagreement(ceo, worker, reviewer, '路线', [], {
        ceoAgentId: ceo.id,
        teamAgentIds: [worker.id, reviewer.id],
        decomposition,
    });
    await settleAsync(2);
    assert.equal(typeof runner._pendingDecisionResolve, 'function');
    runner.stop();
    assert.deepEqual(await pending, { aborted: true });
});

test('decision gate rechecks generation after registering its resolver', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const { runner } = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition: { tasks: [] } });
    runner._callLLMWithRetry = async () => '{}';
    let checks = 0;
    runner._gateInvalidated = () => ++checks >= 9;
    assert.deepEqual(
        await runner._escalateDisagreement(ceo, worker, reviewer, '路线', []),
        { aborted: true }
    );
    assert.equal(runner._pendingDecisionResolve, null);
});

test('cold HITL recovery rejects a valid checkpoint with missing phase details', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const decomposition = { tasks: [] };
    const checkpoint = {
        type: 'waiting_for_human',
        ceoAgentId: ceo.id,
        teamAgentIds: [worker.id],
        decomposition,
        currentPhase: 'missing',
        currentAgentId: worker.id,
    };
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition,
        workflowCheckpoint: checkpoint,
    });
    await runner._resumeAfterHumanIntervention(checkpoint, 'done');
    assert.equal(state.systemStatus, 'blocked');
});

test('branch matrix covers lifecycle fallbacks and checkpoint ownership variants', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const task = { phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: [] };
    const decomposition = { objective: 'x', type: 'x', tasks: [task] };
    const { runner, state, actions } = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        decomposition,
        availableModels: undefined,
    });

    runner._runGateId = null;
    assert.equal(runner._runGateId, null);
    const firstToken = runner._captureGateToken();
    const secondToken = runner._captureGateToken();
    assert.ok(firstToken.gateId && secondToken.gateId !== firstToken.gateId);
    assert.equal(runner._getRunSignal(), null);
    assert.equal(runner._isGateGenerationAlive(runner._gateGeneration), true);
    runner._runAbortController = new AbortController();
    runner._runAbortController.abort();
    assert.equal(runner._isGateGenerationAlive(runner._gateGeneration), false);
    runner._endRunAbortScope();
    assert.equal(runner._isGateGenerationAlive(runner._gateGeneration + 1), false);

    state.workflowCheckpoint = {
        type: 'waiting_for_human',
        inFlight: [{ phase: 'A', agentId: worker.id }],
    };
    runner._phaseFailures = null;
    runner._persistRunningCheckpoint(ceo, null, decomposition, null);
    assert.deepEqual(state.workflowCheckpoint.runningSnapshot.teamAgentIds, []);
    assert.equal(state.workflowCheckpoint.runningSnapshot.inFlight.length, 1);

    state.workflowCheckpoint = { type: 'waiting_for_decision' };
    runner._persistRunningCheckpoint(ceo, [], decomposition, new Set(), { replaceInFlight: [] });
    assert.deepEqual(state.workflowCheckpoint.runningSnapshot.inFlight, []);

    state.workflowCheckpoint = null;
    runner._phaseFailures = [];
    runner._persistRunningCheckpoint(ceo, [], decomposition, null, { replaceInFlight: [] });
    assert.equal(state.workflowCheckpoint.type, 'running_execution');

    state.workflowCheckpoint = {
        type: 'running_execution', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        completedPhases: [], phaseFailures: [], inFlight: [{ phase: 'A', agentId: worker.id }],
    };
    runner._persistRunningCheckpoint(ceo, [worker], decomposition, null);
    assert.equal(state.workflowCheckpoint.type, 'running_execution');

    assert.equal(await runner._autoRecommendModel('工程师'), '');
    state.availableModels = { custom: [{ id: 'first' }] };
    runner._llmRecommendModel = async () => null;
    assert.equal(await runner._autoRecommendModel('工程师'), 'first');

    ceo.model = '';
    state.defaultModel = 'fallback-ceo';
    runner._callLLMWithRetry = async () => '';
    assert.equal(await runner._llmRecommendModel('工程师', [{ id: 'm' }]), null);
    state.defaultModel = '';
    assert.equal(await runner._llmRecommendModel('工程师', [{ id: 'm' }]), null);
    assert.equal(await runner._checkHumanInterventionNeeded({ name: '操作员', role: '需要登录' }, '分析'), true);

    assert.equal(runner.hasPendingExecution(), false);
    assert.ok(actions.length > 0);
});

test('branch matrix covers execution abort windows, summaries, and checkpoint resume fallbacks', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const oneTask = { phase: 'A', assignee: worker.name, subtasks: [], dependencies: [] };
    const decomposition = { objective: 'x', type: 'x', tasks: [oneTask] };

    for (const abortAt of [1, 2]) {
        const h = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
        let delays = 0;
        h.runner._executeAgentPhase = async () => true;
        h.runner._delay = async () => {
            delays += 1;
            if (delays === abortAt) h.runner._aborted = true;
        };
        await h.runner._driveExecution(ceo, [worker], decomposition);
        assert.equal(h.runner._aborted, true);
    }

    const emptyReport = createHarness(CEOAgentRunner, [ceo], { agents: [ceo] });
    emptyReport.runner._delay = async () => { emptyReport.runner._aborted = true; };
    await emptyReport.runner._driveExecution(ceo, [], { objective: 'x', type: 'x', tasks: [] });
    assert.equal(emptyReport.state.deliverables.length, 0);

    const detailed = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition });
    worker.outputs = [
        { phase: 'A', subtask: 'a', content: '' },
        { phase: 'A', subtask: 'b', content: '\n# first line\nrest' },
    ];
    detailed.state.agents = [ceo, worker, reviewer];
    await detailed.runner._driveExecution(
        ceo,
        [worker, reviewer],
        {
            objective: 'x', type: 'x', tasks: [
                { phase: 'A', assignee: worker.name, subtasks: [], dependencies: [] },
                { phase: 'B', assignee: reviewer.name, subtasks: [], dependencies: [] },
            ],
        },
        { completedPhases: new Set(['A', 'B']) }
    );
    assert.ok(detailed.state.messages.some(message => message.outputContent));

    const cp = {
        type: 'running_execution', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        completedPhases: [], phaseFailures: [{ phase: 'old', reason: 'bad' }], inFlight: [],
    };
    const recovery = createHarness(CEOAgentRunner, [ceo, worker], { decomposition, workflowCheckpoint: cp });
    recovery.runner._driveExecution = async () => {};
    assert.equal(await recovery.runner.resumeFromExecutionCheckpoint(), true);
    assert.ok(recovery.state.messages.some(message => /历史失败/.test(message.dialogue.join(' '))));

    const directFailureArray = { ...cp, phaseFailures: undefined, inFlight: [] };
    assert.equal(await recovery.runner.resumeFromExecutionCheckpoint(directFailureArray), true);

    const namedFallback = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    namedFallback.runner._executeAgentPhase = async () => true;
    namedFallback.runner._driveExecution = async () => {};
    assert.equal(await namedFallback.runner.resumeFromExecutionCheckpoint({
        ...cp,
        inFlight: [{ phase: 'A', agentId: 'missing', agentName: worker.name, nextSubtaskIndex: undefined }],
    }), true);

    const abortedAfterFlight = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    abortedAfterFlight.runner._executeAgentPhase = async () => true;
    abortedAfterFlight.runner._refreshTeamAgents = agents => {
        abortedAfterFlight.runner._aborted = true;
        return agents;
    };
    assert.equal(await abortedAfterFlight.runner.resumeFromExecutionCheckpoint({
        ...cp, inFlight: [{ phase: 'A', agentId: worker.id }],
    }), false);
});

test('branch matrix covers task, subtask, tool, quality, and performance defaults', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const task = { phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: [] };
    const decomposition = { tasks: [task] };
    const performance = [];
    const { runner, state, actions } = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition,
        currentObjective: '',
        promptLogs: [
            { agentName: worker.name, timestamp: '', durationMs: 0, totalTokens: 0 },
            { agentName: worker.name, timestamp: 'invalid', durationMs: undefined, totalTokens: undefined },
        ],
        currentSessionId: '',
    }, {
        loadExecutionCapabilities: async () => ({ ragContext: '', toolPrompt: '', toolMap: new Map(), policy: null }),
        shouldUseToolLoop: () => false,
        formatMemoryContext: () => '',
        recordPerformance: entry => performance.push(entry),
    });

    runner._persistRunningCheckpoint(ceo, [worker], decomposition, new Set());
    runner._runRemainingSubtasks = async () => true;
    runner._finalizeAgentPhase = async () => true;
    assert.equal(await runner._executeAgentPhase(ceo, worker, task, new Set(), [worker], {
        phaseStartedAt: '2026-01-01T00:00:00.000Z', startIndex: 0, skipPlanning: true,
    }), true);

    runner._runRemainingSubtasks = async () => true;
    runner._finalizeAgentPhase = async () => { runner._aborted = true; return true; };
    assert.equal(await runner._executeAgentPhase(ceo, worker, task, new Set(), [worker]), false);
    runner._aborted = false;

    worker.outputs = undefined;
    state.sessionHistory = [
        { objective: 'old', messages: undefined },
        { objective: 'old2', messages: [{ role: 'x', outputContent: 'out' }] },
        { objective: 'old3', messages: [] },
    ];
    assert.match(runner._buildSessionContext(), /历史会话/);

    state.defaultModel = 'fallback';
    runner._callLLMWithRetry = async ({ onToken }) => {
        onToken?.('x');
        return 'ok';
    };
    assert.equal((await runner._executeSubtask(worker, 'a', 0, undefined, '')).status, 'success');

    const toolRequest = {
        model: 'm', availableModels: {}, messages: [{ content: 'system' }], userPrompt: 'u',
        capabilities: { toolMap: new Map(), policy: null },
    };
    runner._callLLMWithRetry = async () => 'plan';
    runner.dependencies.parseToolCalls = () => [{ tool: 'read' }];
    runner.dependencies.summarizeToolCall = () => 'read';
    runner.dependencies.executeCapabilityTool = async () => null;
    await assert.rejects(runner._runToolAssistedSubtask(worker, toolRequest), /工具调用失败/);
    runner.dependencies.executeCapabilityTool = async () => ({ ok: true, data: '' });
    let toolCalls = 0;
    runner._callLLMWithRetry = async () => (++toolCalls === 1 ? 'plan' : 'final');
    assert.equal(await runner._runToolAssistedSubtask(worker, toolRequest), 'final');

    assert.equal(runner._buildSubtaskResult(worker, 'x', '', 'llm').status, 'success');
    assert.equal(runner._buildPhaseOutput({ ...worker, id: 'missing', outputs: [{ phase: 'A', content: 'x' }] }, task), '### A-1\nx');
    assert.deepEqual(runner._collectPhaseMetrics(worker.name, ''), { durationMs: 0, tokenCount: 0 });
    runner._recordPhasePerformance(worker, task, '', undefined, '');
    assert.equal(performance.at(-1).qaResult, 'pass');

    runner._buildPhaseOutput = () => 'output';
    let review = 0;
    runner._qualityReview = async () => (++review === 1
        ? { result: 'revise', suggestion: 'first' }
        : { result: 'revise', suggestion: 'second' });
    runner._revisePhaseOutput = async () => 'revised';
    const gate = await runner._runPhaseQualityGate(ceo, worker, task);
    assert.equal(gate.suggestion, 'second');

    state.agents = [worker];
    runner._qualityReview = CEOAgentRunner.prototype._qualityReview;
    runner._callLLMWithRetry = async () => '{"result":"pass"}';
    assert.equal((await runner._qualityReview(worker, 'A', '')).result, 'pass');
    assert.ok(actions.length > 0);
});

test('branch matrix covers collaboration, messages, reports, pause, restructure, and stop errors', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker, AGENT_STATES } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试', model: '' });
    worker.outputs = undefined;
    const { runner, state, actions } = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        currentObjective: '',
        sessionHistory: [],
        messages: [{ source: 'collaboration', dialogue: undefined }],
    });

    let calls = 0;
    runner._callLLMWithRetry = async () => (++calls === 1 ? '' : (++calls === 3 ? '' : 'reply'));
    runner._checkConsensus = async () => ({ agreed: true, summary: '' });
    await runner._conductCollaboration(ceo, worker, reviewer, 'A', 1);

    runner._checkConsensus = CEOAgentRunner.prototype._checkConsensus;
    runner._callLLMWithRetry = async () => '';
    assert.equal((await runner._checkConsensus([], 'A', 'B', 'T')).agreed, false);

    runner._emitCEOMessage(ceo, undefined, undefined);
    runner._emitAgentMessage({ ...worker, id: 'missing' }, undefined, undefined, undefined, null, null);
    assert.ok(actions.some(action => action.type === 'ADD_MESSAGE'));

    const tasks = [
        { phase: 'failed-recorded', assignee: worker.name, subtasks: undefined, dependencies: undefined },
        { phase: 'failed-default', assignee: worker.name, subtasks: [], dependencies: [] },
        { phase: 'partial', assignee: worker.name, subtasks: ['missing'], dependencies: [] },
        { phase: 'qa', assignee: worker.name, subtasks: [], dependencies: [] },
        { phase: 'legacy', assignee: worker.name, subtasks: ['legacy'], dependencies: ['qa'] },
    ];
    worker.outputs = [
        { phase: 'legacy', subtask: 'legacy', content: 'ok', source: 'llm' },
        { phase: 'legacy', subtask: 'empty', content: '', status: 'failed' },
    ];
    state.agents = [ceo, worker, reviewer];
    const report = runner._buildDeliverable({ objective: '', type: '', tasks }, [worker], tasks, {
        completedPhases: new Set(['partial', 'qa', 'legacy']),
        phaseFailures: [
            { phase: 'failed-recorded', reason: '' },
            { phase: 'failed-default' },
        ],
        phaseResults: {
            'failed-recorded': { status: 'failed', reason: 'recorded reason' },
            qa: { status: 'success', qa: 'revise' },
            legacy: { status: 'success', qa: 'pass' },
        },
    });
    assert.equal(report.meta.failedCount, 3);
    assert.equal(report.meta.incompleteCount, 1);
    assert.match(report.content, /协作对话记录|未指定|（无内容）/);

    runner.isRunning = true;
    state.workflowCheckpoint = null;
    state.decomposition = { tasks };
    worker.state = AGENT_STATES.EXECUTING;
    worker.phase = 'missing';
    worker.currentSubtaskIndex = 0;
    worker.currentTask = '';
    reviewer.state = AGENT_STATES.IDLE;
    runner.pause();
    runner.unpause();

    state.agents = [worker];
    runner._paused = true;
    runner.unpause();
    runner.restructure({ add: [{ name: 'x', role: 'r', color: '', model: '' }] });
    assert.ok(state.agents.some(agent => agent.name === 'x'));

    const throwingState = { agents: [ceo], systemStatus: 'idle', workflowCheckpoint: null };
    const throwRunner = new CEOAgentRunner(action => {
        if (['RESOLVE_DECISION', 'CLEAR_WORKFLOW_CHECKPOINT', 'SET_STATUS'].includes(action.type)) {
            throw new Error(action.type);
        }
    }, () => throwingState);
    throwRunner._userGate = { invalidate() { throw new Error('mutex'); } };
    throwRunner._runAbortController = { abort() { throw new Error('abort'); } };
    throwRunner._pendingHumanInput = () => { throw new Error('human'); };
    throwRunner._pendingDecisionResolve = () => { throw new Error('decision'); };
    throwingState.systemStatus = 'waiting_for_human';
    assert.doesNotThrow(() => throwRunner.stop('FAULTS'));
});

test('branch matrix covers defensive aborts, recovery failures, and collaboration exits', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const task = { phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: [] };
    const decomposition = { objective: 'x', type: 'x', tasks: [task] };

    const drive = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    drive.runner._executeAgentPhase = async () => ({ valueOf: () => false });
    drive.runner._phaseFailures = [];
    await drive.runner._driveExecution(ceo, [worker], decomposition);
    assert.equal(drive.state.systemStatus, 'completed');

    const abortBeforeLoop = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    abortBeforeLoop.runner._aborted = true;
    await abortBeforeLoop.runner._driveExecution(ceo, [worker], decomposition);
    assert.equal(abortBeforeLoop.state.deliverables.length, 0);

    const failureReason = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    failureReason.runner._executeAgentPhase = async () => false;
    await failureReason.runner._driveExecution(ceo, [worker], decomposition);
    assert.match(failureReason.state.messages.flatMap(message => message.dialogue).join(' '), /阶段未成功完成|失败/);

    const recovery = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    const cp = {
        type: 'running_execution', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        completedPhases: [], phaseFailures: [], inFlight: [{ phase: 'A', agentId: worker.id }],
    };
    recovery.runner._executeAgentPhase = async () => false;
    recovery.runner._driveExecution = async () => {};
    assert.equal(await recovery.runner.resumeFromExecutionCheckpoint(cp), true);
    assert.ok(recovery.runner._phaseFailures.some(failure => failure.reason === '续跑未成功完成'));

    const badDispatch = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    badDispatch.runner._promoteGateCheckpointToRunning = () => { throw new Error('hard failure'); };
    badDispatch.runner._emitCEOMessage = () => { throw new Error('message failure'); };
    await assert.rejects(badDispatch.runner.resumeFromExecutionCheckpoint(cp), /message failure/);

    const finalize = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        decomposition: {
            tasks: [
                task,
                { phase: 'B', assignee: reviewer.name, subtasks: [], dependencies: ['A'] },
            ],
        },
    });
    worker.outputs = [{ phase: 'A', subtask: 'a', content: 'done', status: 'success' }];
    finalize.state.agents = [ceo, worker, reviewer];
    finalize.runner._runPhaseQualityGate = async () => ({ result: 'pass', finalContent: '' });
    finalize.runner._recordPhasePerformance = () => {};
    finalize.runner.dependencies.saveMemory = () => {};
    finalize.runner._conductCollaboration = async () => { finalize.runner._aborted = true; };
    assert.equal(await finalize.runner._finalizeAgentPhase(ceo, worker, task, new Set(), [worker, reviewer]), false);

    const skipDownstream = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition: { tasks: [task, { phase: 'B', assignee: worker.name, dependencies: ['A'] }] },
    });
    skipDownstream.runner._runPhaseQualityGate = async () => ({ result: 'pass', finalContent: '' });
    skipDownstream.runner._recordPhasePerformance = () => {};
    assert.equal(await skipDownstream.runner._finalizeAgentPhase(ceo, worker, task, new Set(), [worker]), true);

    for (const abortPoint of [1, 2]) {
        const collab = createHarness(CEOAgentRunner, [ceo, worker, reviewer]);
        let delays = 0;
        collab.runner._callLLMWithRetry = async () => 'reply';
        collab.runner._delay = async () => {
            delays += 1;
            if (delays === abortPoint) collab.runner._aborted = true;
        };
        await collab.runner._conductCollaboration(ceo, worker, reviewer, 'A', 1);
        assert.equal(collab.runner._aborted, true);
    }
});

test('branch matrix covers human recovery abort windows and cold public entry points', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const task = { phase: 'A', assignee: worker.name, subtasks: ['human', 'rest'], dependencies: [] };
    const decomposition = { tasks: [task] };
    const checkpoint = {
        type: 'waiting_for_human', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        currentPhase: 'A', currentAgentId: worker.id, currentSubtaskIndex: undefined,
        currentSubtask: undefined, phaseStartedAt: undefined, inFlight: [],
    };

    const coldEntry = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition, workflowCheckpoint: { ...checkpoint, currentSubtask: 'human' },
    });
    let resumed;
    coldEntry.runner._resumeAfterHumanIntervention = async (...args) => { resumed = args; };
    coldEntry.runner.provideHumanInput('done');
    await settleAsync();
    assert.equal(resumed[1], 'done');

    const noContext = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    await noContext.runner._resumeAfterHumanIntervention({ type: 'waiting_for_human' }, 'done');
    assert.equal(noContext.state.systemStatus, 'blocked');

    const fallbackSubtask = { ...checkpoint, currentSubtaskIndex: 0 };
    const abortAfterDelay = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    abortAfterDelay.runner._delay = async () => { abortAfterDelay.runner._aborted = true; };
    await abortAfterDelay.runner._resumeAfterHumanIntervention(fallbackSubtask, 'done');
    assert.equal(abortAfterDelay.runner.isRunning, false);

    const failedResult = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    failedResult.runner._executeSubtask = async () => ({ status: 'failed', source: 'x', content: '', reason: '' });
    await failedResult.runner._resumeAfterHumanIntervention(fallbackSubtask, 'done');
    assert.equal(failedResult.state.systemStatus, 'blocked');

    const abortAfterSubtask = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    abortAfterSubtask.runner._executeSubtask = async () => {
        abortAfterSubtask.runner._aborted = true;
        return { status: 'success', source: 'llm', content: 'ok', summary: ['ok'] };
    };
    await abortAfterSubtask.runner._resumeAfterHumanIntervention(fallbackSubtask, 'done');
    assert.equal(abortAfterSubtask.runner.isRunning, false);

    const abortRemainder = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    abortRemainder.runner._executeSubtask = async () => ({ status: 'success', source: 'llm', content: 'ok', summary: ['ok'] });
    abortRemainder.runner._runRemainingSubtasks = async () => {
        abortRemainder.runner._aborted = true;
        return false;
    };
    await abortRemainder.runner._resumeAfterHumanIntervention(fallbackSubtask, 'done');
    assert.equal(abortRemainder.state.systemStatus, 'running');

    const abortFinalize = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    abortFinalize.runner._executeSubtask = async () => ({ status: 'success', source: 'llm', content: 'ok', summary: ['ok'] });
    abortFinalize.runner._runRemainingSubtasks = async () => true;
    abortFinalize.runner._finalizeAgentPhase = async () => {
        abortFinalize.runner._aborted = true;
        return true;
    };
    await abortFinalize.runner._resumeAfterHumanIntervention(fallbackSubtask, 'done');
    assert.equal(abortFinalize.runner.isRunning, false);
});

test('branch matrix covers escalation write races, decisions, retry regex, and paused terminal state', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const decomposition = { tasks: [] };

    for (const invalidAt of [3, 4, 5, 6, 7]) {
        const h = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition });
        h.runner._callLLMWithRetry = async () => '{}';
        let checks = 0;
        h.runner._gateInvalidated = () => ++checks >= invalidAt;
        assert.deepEqual(await h.runner._escalateDisagreement(ceo, worker, reviewer, 'A', []), { aborted: true });
    }

    const abortCleanupError = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition });
    abortCleanupError.runner._callLLMWithRetry = async () => '{}';
    abortCleanupError.runner._rollbackOwnedGateCompat = () => { throw new Error('rollback'); };
    abortCleanupError.runner._gateInvalidated = () => true;
    assert.deepEqual(await abortCleanupError.runner._escalateDisagreement(ceo, worker, reviewer, 'A', []), { aborted: true });

    const decision = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        decomposition,
        pendingDecision: { topic: 'A', agentA: worker.name, agentB: reviewer.name, proposals: [] },
        workflowCheckpoint: null,
    });
    let resolvedValue;
    decision.runner._pendingDecisionResolve = value => { resolvedValue = value; };
    decision.runner.resolveDecision(4);
    assert.equal(resolvedValue.chosenText, '方案 5');

    const cold = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        decomposition,
        pendingDecision: { topic: 'A', proposals: [{ title: 'one' }] },
        workflowCheckpoint: {
            type: 'waiting_for_decision', ceoAgentId: ceo.id, teamAgentIds: [worker.id, reviewer.id], decomposition,
            currentPhase: 'A', agentAId: worker.id, agentBId: reviewer.id,
        },
    });
    let coldChoice;
    cold.runner._resumeAfterDecision = async (_cp, choice) => { coldChoice = choice; };
    cold.runner.resolveDecision(0);
    await settleAsync();
    assert.equal(coldChoice, 'one');

    const retry = createHarness(CEOAgentRunner, [ceo], {}, {
        sendChat: async () => { throw new Error('LLM 调用失败 418'); },
    });
    retry.runner._delay = async () => {};
    await assert.rejects(retry.runner._callLLMWithRetry({ model: 'x' }, 1), /418/);

    const paused = createHarness(CEOAgentRunner, [ceo]);
    paused.state.systemStatus = 'paused';
    paused.runner.stop();
    assert.equal(paused.state.systemStatus, 'blocked');
});

test('branch matrix covers start and resume cancellation checkpoints and reporting abort', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const decomposition = {
        objective: 'x', type: 'x', totalPhases: 1, estimatedDuration: 1,
        roles: [{ name: worker.name, role: worker.role, color: '', model: '' }],
        tasks: [{ phase: 'A', assignee: worker.name, subtasks: [], dependencies: [] }],
    };

    for (const abortDelay of [1, 2, 3]) {
        const h = createHarness(CEOAgentRunner, [ceo, worker], {}, {
            decomposeWithLLM: async () => decomposition,
        });
        let delays = 0;
        h.runner._delay = async () => {
            delays += 1;
            if (delays === abortDelay) h.runner._aborted = true;
        };
        await h.runner.start('x');
        assert.equal(h.runner.isRunning, false);
    }

    const abortAfterDecompose = createHarness(CEOAgentRunner, [ceo], {}, {
        decomposeWithLLM: async () => decomposition,
    });
    abortAfterDecompose.runner.dependencies.decomposeWithLLM = async () => {
        abortAfterDecompose.runner._aborted = true;
        return decomposition;
    };
    await abortAfterDecompose.runner.start('x');
    assert.equal(abortAfterDecompose.state.decomposition, null);

    const missingErrorMessage = createHarness(CEOAgentRunner, [], {}, {
        decomposeWithLLM: async () => decomposition,
    });
    missingErrorMessage.runner._emitCEOMessage = () => { throw new Error('secondary'); };
    await missingErrorMessage.runner.start('x');
    assert.equal(missingErrorMessage.state.systemStatus, 'blocked');

    const resumeCp = {
        type: 'waiting_for_config', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
    };
    const abortHydrate = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition, workflowCheckpoint: resumeCp,
    }, {
        ensureProviderConfigsHydrated: async () => {
            abortHydrate.runner._aborted = true;
            return {};
        },
    });
    abortHydrate.runner._pendingExecution = { ceoAgent: ceo, teamAgents: [worker], decomposition };
    await abortHydrate.runner.resume();
    assert.equal(abortHydrate.runner.isRunning, false);

    const customConfig = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition, workflowCheckpoint: null, availableModels: {},
    }, {
        ensureProviderConfigsHydrated: async () => ({ custom: { apiUrl: 'u', apiKey: 'k' } }),
        resolveProviderForModel: () => 'missing',
    });
    customConfig.runner._pendingExecution = { ceoAgent: ceo, teamAgents: [worker], decomposition };
    customConfig.runner._driveExecution = async () => {};
    await customConfig.runner.resume();
    assert.equal(customConfig.state.workflowCheckpoint.type, 'running_execution');

    const abortBeforeDrive = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition, workflowCheckpoint: resumeCp,
    }, {
        ensureProviderConfigsHydrated: async () => ({ custom: { apiUrl: 'u', apiKey: 'k' } }),
        resolveProviderForModel: () => 'custom',
    });
    abortBeforeDrive.runner._pendingExecution = { ceoAgent: ceo, teamAgents: [worker], decomposition };
    abortBeforeDrive.runner._delay = async () => { abortBeforeDrive.runner._aborted = true; };
    await abortBeforeDrive.runner.resume();
    assert.equal(abortBeforeDrive.runner.isRunning, false);

    const messageCatch = createHarness(CEOAgentRunner, [ceo, worker], { decomposition, workflowCheckpoint: resumeCp }, {
        ensureProviderConfigsHydrated: async () => { throw new Error('resume'); },
    });
    messageCatch.runner._pendingExecution = { ceoAgent: ceo, teamAgents: [worker], decomposition };
    messageCatch.runner._emitCEOMessage = () => { throw new Error('secondary'); };
    await messageCatch.runner.resume();
    assert.equal(messageCatch.state.systemStatus, 'blocked');

    const reportingAbort = createHarness(CEOAgentRunner, [ceo], {});
    reportingAbort.runner._delay = async () => { reportingAbort.runner._aborted = true; };
    await reportingAbort.runner._driveExecution(ceo, [], { objective: 'x', type: 'x', tasks: [] });
    assert.equal(reportingAbort.state.deliverables.length, 0);
});

test('branch matrix covers checkpoint context source precedence and refresh name fallback', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const replacement = { ...worker, id: 'replacement' };
    const decomposition = { tasks: [] };
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, replacement], { decomposition });
    assert.equal(runner._refreshTeamAgents([worker])[0].id, replacement.id);
    state.agents = undefined;
    assert.deepEqual(runner._refreshTeamAgents([]), []);

    state.agents = [ceo, worker];
    const fromState = {
        type: 'waiting_for_config', ceoAgentId: undefined, teamAgentIds: undefined,
        decomposition: undefined,
        runningSnapshot: { ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition },
    };
    const context = runner._restoreCheckpointContext(fromState);
    assert.equal(context.ceoAgent.id, ceo.id);
    assert.equal(context.teamAgents[0].id, worker.id);
    assert.equal(runner.restorePendingExecution(fromState), true);

    state.workflowCheckpoint = fromState;
    assert.equal(runner._restoreCheckpointContext().decomposition, decomposition);
    assert.equal(runner._restoreCheckpointContext(null).ceoAgent.name, 'CEO');

    runner._phaseFailures = [{ phase: 'old', reason: 'x' }];
    const promoted = runner._promoteGateCheckpointToRunning(null, {
        ceoAgent: ceo, teamAgents: [worker], decomposition,
        completedPhases: undefined, phaseFailures: undefined, inFlight: undefined,
    }, { inFlight: undefined });
    assert.equal(promoted.promotedFrom, null);
    assert.equal(promoted.phaseFailures.length, 1);
});

test('branch matrix covers direct subtask aborts, status defaults, and timer no-op callbacks', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const task = { phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: [] };
    const decomposition = { tasks: [task] };

    for (const abortStage of ['before', 'after-check', 'after-result', 'after-delay']) {
        const h = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
        h.runner._checkHumanInterventionNeeded = async () => {
            if (abortStage === 'after-check') h.runner._aborted = true;
            return false;
        };
        h.runner._executeSubtask = async () => {
            if (abortStage === 'after-result') h.runner._aborted = true;
            return { status: 'success', source: 'llm', content: 'ok', summary: ['ok'] };
        };
        h.runner._delay = async () => {
            if (abortStage === 'after-delay') h.runner._aborted = true;
        };
        if (abortStage === 'before') h.runner._aborted = true;
        assert.equal(await h.runner._runRemainingSubtasks(ceo, worker, task, new Set(), [worker]), false);
    }

    const fallback = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    fallback.runner._checkHumanInterventionNeeded = async () => false;
    fallback.runner._executeSubtask = async () => ({ status: 'failed', source: 'custom', content: '', reason: '' });
    assert.equal(await fallback.runner._runRemainingSubtasks(ceo, worker, task, new Set(), [worker]), false);
    const output = fallback.state.agents.find(agent => agent.id === worker.id).outputs.at(-1);
    assert.equal(output.content, '（失败）');

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    try {
        const callbacks = [];
        globalThis.setTimeout = callback => { callbacks.push(callback); return callbacks.length; };
        globalThis.clearTimeout = () => {};
        const timers = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
        const pending = timers.runner._requestHumanIntervention(worker, '普通确认', null);
        const finish = timers.runner._pendingHumanInput;
        timers.runner._pendingHumanInput = null;
        callbacks.forEach(callback => callback());
        timers.runner._pendingHumanInput = finish;
        timers.runner.provideHumanInput('done');
        assert.equal(await pending, 'done');
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});

test('branch matrix covers remaining model, checkpoint, planning, QA, and message defaults', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const task = { phase: 'A', assignee: worker.name, subtasks: [], dependencies: [] };
    const decomposition = { tasks: [task] };
    const { runner, state, actions } = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition,
        availableModels: {},
    });

    ceo.model = '';
    state.defaultModel = '';
    assert.equal(await runner._llmRecommendModel('x', [{ id: 'm' }]), null);
    ceo.model = 'm';
    runner._callLLMWithRetry = async () => null;
    assert.equal(await runner._llmRecommendModel('x', [{ id: 'model-x' }]), 'model-x');

    assert.equal(await runner._checkHumanInterventionNeeded({ name: 'x', role: undefined }, '支付'), true);
    runner._callLLMWithRetry = async () => null;
    assert.equal(await runner._checkHumanInterventionNeeded({ name: 'x', role: undefined }, '分析'), true);
    assert.equal(await runner._checkHumanInterventionNeeded(worker, '分析'), true);

    const stateOnly = {
        type: 'waiting_for_config', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
    };
    state.workflowCheckpoint = stateOnly;
    runner._restoreCheckpointContext(undefined);
    assert.equal(runner._restoreCheckpointContext({}), null);
    assert.equal(runner.restorePendingExecution({ ...stateOnly, teamAgentIds: [] }), false);

    state.workflowCheckpoint = { type: 'other' };
    runner._persistRunningCheckpoint(ceo, [worker], decomposition, new Set(), {
        upsertInFlight: { phase: 'A', agentId: worker.id },
        removeInFlightPhase: 'A',
    });
    assert.equal(state.workflowCheckpoint.type, 'running_execution');

    const planning = createHarness(CEOAgentRunner, [ceo, { ...worker, outputs: undefined }], {
        decomposition: null,
    });
    planning.runner._runRemainingSubtasks = async () => true;
    planning.runner._finalizeAgentPhase = async () => true;
    assert.equal(await planning.runner._executeAgentPhase(
        ceo,
        { ...worker, outputs: undefined },
        { ...task, subtasks: [], dependencies: undefined },
        new Set(),
        [worker]
    ), true);

    const dependencyAbort = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    dependencyAbort.runner._delay = async () => { dependencyAbort.runner._aborted = true; };
    assert.equal(await dependencyAbort.runner._executeAgentPhase(
        ceo, worker, { ...task, dependencies: ['prior'] }, new Set(), [worker]
    ), false);

    const planningAbort = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    planningAbort.runner._delay = async () => { planningAbort.runner._aborted = true; };
    assert.equal(await planningAbort.runner._executeAgentPhase(ceo, worker, task, new Set(), [worker]), false);

    const qa = createHarness(CEOAgentRunner, [ceo, worker], { decomposition: { tasks: undefined } });
    qa.runner._runPhaseQualityGate = async () => ({ result: 'revise', suggestion: 'fix', finalContent: '' });
    qa.runner._recordPhasePerformance = () => {};
    assert.equal(await qa.runner._finalizeAgentPhase(ceo, worker, task, new Set(), [worker]), false);

    qa.runner._runPhaseQualityGate = async () => ({ result: 'pass', finalContent: '' });
    qa.runner._recordPhasePerformance = () => {};
    qa.runner.dependencies.saveMemory = () => { throw new Error('memory'); };
    assert.equal(await qa.runner._finalizeAgentPhase(ceo, worker, task, new Set(), [worker]), true);

    const noLatest = { ...ceo, id: 'missing', currentTask: '', collaborators: [] };
    runner._emitCEOMessage(noLatest, [undefined], []);
    runner._emitAgentMessage({ ...worker, id: 'missing', currentTask: '', collaborators: [] }, [undefined], [undefined]);
    assert.ok(actions.length > 0);
});

test('branch matrix covers human rollback errors, warm decision checkpoints, and decision recovery aborts', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const task = { phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: [] };
    const decomposition = { tasks: [task] };
    const checkpoint = {
        type: 'waiting_for_human', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        currentPhase: 'A', currentAgentId: worker.id, currentSubtaskIndex: 0, currentSubtask: 'a',
    };

    const rollback = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    rollback.runner._rollbackOwnedGateCompat = () => { throw new Error('rollback'); };
    let checks = 0;
    rollback.runner._gateInvalidated = () => ++checks >= 3;
    assert.equal(await rollback.runner._requestHumanIntervention(worker, 'a', checkpoint), 'GATE_CANCELLED');

    const warmDecision = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition,
        workflowCheckpoint: { ...checkpoint, type: 'waiting_for_decision' },
    });
    const pending = warmDecision.runner._requestHumanIntervention(worker, 'a', checkpoint);
    await settleAsync();
    warmDecision.runner.provideHumanInput('done');
    assert.equal(await pending, 'done');

    const missingContext = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        pendingDecision: { topic: 'A', proposals: [{ title: 'one' }] },
        workflowCheckpoint: null,
    });
    missingContext.runner._pendingDecisionResolve = () => {};
    missingContext.runner.resolveDecision(0);

    const decisionCp = {
        type: 'waiting_for_decision', ceoAgentId: ceo.id,
        teamAgentIds: [worker.id, reviewer.id], decomposition,
        currentPhase: undefined, agentAId: worker.id, agentBId: reviewer.id, topic: undefined,
    };
    const abortDecision = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        decomposition,
        workflowCheckpoint: decisionCp,
        pendingDecision: { topic: 'A', agentA: worker.name, agentB: reviewer.name, proposals: [] },
    });
    abortDecision.runner._delay = async () => { abortDecision.runner._aborted = true; };
    await abortDecision.runner._resumeAfterDecision(decisionCp, 'choice');
    assert.equal(abortDecision.runner.isRunning, false);
});

test('branch matrix covers prompt/report/pause fallbacks and stop running status', async () => {
    const { CEOAgentRunner, ceo, worker, AGENT_STATES } = await fixtures();
    const task = { phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: [] };
    const decomposition = { objective: '', type: '', tasks: [task] };
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition,
        sessionHistory: undefined,
        promptLogs: undefined,
        currentSessionId: '',
        messages: [],
    });
    worker.outputs = [{ subtask: 'a', content: undefined }];
    state.agents = [ceo, worker];
    assert.equal(typeof runner._buildSessionContext(), 'string');
    assert.deepEqual(runner._collectPhaseMetrics(worker.name, ''), { durationMs: 0, tokenCount: 0 });

    state.defaultModel = 'fallback';
    runner._callLLMWithRetry = async () => 'ok';
    runner.dependencies.loadExecutionCapabilities = async () => ({ ragContext: '', toolPrompt: '', toolMap: new Map(), policy: {} });
    runner.dependencies.shouldUseToolLoop = () => false;
    runner.dependencies.formatMemoryContext = () => '';
    assert.equal((await runner._executeSubtask({ ...worker, outputs: undefined, model: '' }, 'a', 0)).status, 'success');

    const report = runner._buildDeliverable(decomposition, [worker], [task], {
        completedPhases: [], phaseFailures: [], phaseResults: {},
    });
    assert.equal(report.meta.incompleteCount, 1);

    runner.isRunning = true;
    state.workflowCheckpoint = {
        type: 'running_execution', ceoAgentId: ceo.id, teamAgentIds: [worker.id],
        decomposition: undefined, completedPhases: undefined, inFlight: undefined,
    };
    runner.pause();

    state.workflowCheckpoint = null;
    state.decomposition = { tasks: undefined };
    worker.state = AGENT_STATES.EXECUTING;
    worker.phase = 'A';
    runner.pause();

    state.systemStatus = 'running';
    runner.stop();
    assert.equal(state.systemStatus, 'blocked');
});

test('branch matrix covers remaining recovery status alternatives and report branches', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const task = { phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: [] };
    const decomposition = { objective: '', type: '', tasks: [task] };
    const checkpoint = {
        type: 'waiting_for_human', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        currentPhase: 'A', currentAgentId: worker.id, currentSubtaskIndex: 0,
        currentSubtask: 'a', phaseStartedAt: '', inFlight: undefined,
        phaseFailures: undefined,
    };

    const failedWithReason = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    failedWithReason.runner._phaseFailures = null;
    failedWithReason.runner._executeSubtask = async () => ({
        status: 'failed', source: 'x', content: '', reason: 'explicit', summary: [],
    });
    await failedWithReason.runner._resumeAfterHumanIntervention(checkpoint, 'done');
    assert.ok(failedWithReason.runner._phaseFailures.some(failure => failure.reason === 'explicit'));

    const skippedDefault = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    await skippedDefault.runner._resumeAfterHumanIntervention(checkpoint, '', { skipped: true });
    assert.ok(skippedDefault.runner._phaseFailures.some(failure => /SKIPPED/.test(failure.reason)));

    const dateFallback = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    dateFallback.runner._executeSubtask = async () => ({ status: 'success', source: 'llm', content: 'ok', summary: ['ok'] });
    dateFallback.runner._runRemainingSubtasks = async (...args) => {
        assert.match(args[6], /^\d{4}-/);
        return true;
    };
    dateFallback.runner._finalizeAgentPhase = async (...args) => {
        assert.match(args[5], /^\d{4}-/);
        return false;
    };
    await dateFallback.runner._resumeAfterHumanIntervention(checkpoint, 'done');
    assert.equal(dateFallback.state.systemStatus, 'blocked');

    const reportRunner = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition,
        messages: undefined,
    });
    worker.outputs = [
        { phase: 'A', subtask: 'a', content: 'ok', status: 'success' },
    ];
    reportRunner.state.agents = [ceo, worker];
    const report = reportRunner.runner._buildDeliverable(decomposition, [worker], [task], {
        completedPhases: new Set(['A']),
        phaseFailures: [],
        phaseResults: {},
    });
    assert.equal(report.meta.allSuccess, true);

    const legacyMeta = reportRunner.runner._buildDeliverable(decomposition, [worker], [task]);
    assert.equal(legacyMeta.meta.incompleteCount, 1);
});

test('branch matrix covers remaining collaboration prompt and decision context fallbacks', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const decomposition = { tasks: [] };
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        decomposition,
        currentObjective: '',
        sessionHistory: [],
    });
    worker.outputs = [{ subtask: 'a', content: undefined }];
    state.agents = [ceo, worker, reviewer];
    runner._callLLMWithRetry = async () => '';
    runner._checkConsensus = async () => ({ agreed: true, summary: '' });
    await runner._conductCollaboration(ceo, { ...worker, id: 'missing' }, reviewer, 'A', 1);

    const consensus = createHarness(CEOAgentRunner, [{ ...ceo, model: '' }, worker, reviewer], {
        availableModels: {},
    });
    consensus.runner._callLLMWithRetry = async () => '{"agreed":false,"summary":null,"proposals":null}';
    const result = await consensus.runner._checkConsensus([], 'A', 'B', 'T');
    assert.deepEqual(result.proposals, []);

    const escalation = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition });
    escalation.runner._callLLMWithRetry = async () => '';
    let checks = 0;
    escalation.runner._gateInvalidated = () => ++checks >= 2;
    assert.deepEqual(await escalation.runner._escalateDisagreement(ceo, worker, reviewer, 'A', []), { aborted: true });

    const decisionCheckpoint = {
        type: 'waiting_for_decision', ceoAgentId: ceo.id,
        teamAgentIds: [worker.id, reviewer.id], decomposition,
        currentPhase: undefined, agentAId: 'missing-a', agentBId: 'missing-b', topic: 'fallback',
        phaseFailures: undefined, inFlight: undefined,
    };
    const decision = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        decomposition, workflowCheckpoint: decisionCheckpoint,
        pendingDecision: { topic: undefined, agentA: worker.name, agentB: reviewer.name, proposals: [] },
    });
    decision.runner._phaseFailures = null;
    decision.runner._driveExecution = async () => {};
    await decision.runner._resumeAfterDecision(decisionCheckpoint, 'choice');
    assert.equal(decision.state.systemStatus, 'running');
});

test('branch matrix covers running checkpoint mutations and missing-provider configuration', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const decomposition = { tasks: [] };
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    state.workflowCheckpoint = {
        type: 'running_execution', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        completedPhases: [], phaseFailures: [], inFlight: [],
    };
    runner._persistRunningCheckpoint(ceo, [worker], decomposition, new Set(), {
        upsertInFlight: { phase: 'A', agentId: worker.id },
    });
    assert.equal(state.workflowCheckpoint.inFlight.length, 1);
    runner._persistRunningCheckpoint(ceo, [worker], decomposition, new Set(), {
        removeInFlightPhase: 'A',
    });
    assert.equal(state.workflowCheckpoint.inFlight.length, 0);

    state.workflowCheckpoint = {
        type: 'running_execution', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        completedPhases: [], phaseFailures: [], inFlight: [{ phase: 'A', agentId: worker.id }],
    };
    runner._persistRunningCheckpoint(ceo, [worker], decomposition, new Set(), { replaceInFlight: [] });
    assert.equal(state.workflowCheckpoint.inFlight.length, 0);

    const config = createHarness(CEOAgentRunner, [ceo, worker], { decomposition }, {
        ensureProviderConfigsHydrated: async () => ({}),
        resolveProviderForModel: () => 'missing',
    });
    config.runner._pendingExecution = { ceoAgent: ceo, teamAgents: [worker], decomposition };
    await config.runner.resume();
    assert.equal(config.runner.hasPendingExecution(), true);
});

test('branch matrix covers source-less subtasks, retry empty messages, and quality defaults', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const task = { phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: [] };
    const decomposition = { tasks: [task] };
    const { runner, state } = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition, currentObjective: '', availableModels: {}, currentSessionId: '',
    }, {
        loadExecutionCapabilities: async () => ({ ragContext: '', toolPrompt: '', toolMap: new Map(), policy: {} }),
        shouldUseToolLoop: () => false,
        formatMemoryContext: () => '',
        recordPerformance: () => {},
    });

    worker.outputs = undefined;
    state.agents = [ceo, worker];
    state.defaultModel = 'fallback';
    runner._callLLMWithRetry = async () => 'ok';
    assert.equal((await runner._executeSubtask({ ...worker, model: '', outputs: undefined }, 'a', 0)).status, 'success');
    assert.deepEqual(runner._getPhaseOutputs({ ...worker, id: 'missing', outputs: undefined }, task), []);

    runner._recordPhasePerformance(worker, task, '', { result: undefined }, '');
    runner._callLLMWithRetry = async () => 'revised';
    assert.equal(await runner._revisePhaseOutput({ ...worker, model: '' }, task, 'phase', ''), 'revised');

    runner._aborted = false;
    runner._callLLMWithRetry = CEOAgentRunner.prototype._callLLMWithRetry;
    runner.dependencies.sendChat = async () => { throw new Error(''); };
    await assert.rejects(runner._callLLMWithRetry({ model: 'x' }, 1));
});

test('branch matrix covers final stop states and cold decision failure handling', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const decomposition = { tasks: [] };

    for (const status of ['waiting_for_config', 'waiting_for_decision']) {
        const h = createHarness(CEOAgentRunner, [ceo], { systemStatus: status });
        h.runner.stop();
        assert.equal(h.state.systemStatus, 'blocked');
    }

    const decisionCheckpoint = {
        type: 'waiting_for_decision', ceoAgentId: ceo.id,
        teamAgentIds: [worker.id, reviewer.id], decomposition,
        currentPhase: 'A', agentAId: worker.id, agentBId: reviewer.id,
    };
    const failed = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        decomposition, workflowCheckpoint: decisionCheckpoint,
        pendingDecision: { topic: 'A', proposals: [] },
    });
    failed.runner._promoteGateCheckpointToRunning = () => { throw new Error('decision failure'); };
    await failed.runner._resumeAfterDecision(decisionCheckpoint, 'choice');
    assert.equal(failed.state.systemStatus, 'blocked');
});

test('branch matrix covers start model/color fallbacks and config-gate race positions', async () => {
    const { createAgent, CEOAgentRunner, ceo } = await fixtures();
    const existing = createAgent({ name: '复用', role: 'old', color: '#old', model: 'kept' });
    const decomposition = {
        objective: 'x', type: 'x', totalPhases: 1, estimatedDuration: 1,
        roles: [
            { name: '复用', role: 'new', color: '' },
            { name: '新建', role: 'new', color: '#new', model: 'explicit' },
        ],
        tasks: [],
    };
    const h = createHarness(CEOAgentRunner, [ceo, existing], { availableModels: undefined }, {
        decomposeWithLLM: async () => decomposition,
    });
    h.runner._autoRecommendModel = async () => 'recommended';
    await h.runner.start('x');
    assert.equal(h.state.agents.find(agent => agent.name === '复用').color, '#old');
    assert.equal(h.state.agents.find(agent => agent.name === '新建').model, 'explicit');

    for (const invalidAt of [1, 2]) {
        const race = createHarness(CEOAgentRunner, [ceo], {}, {
            decomposeWithLLM: async () => ({
                objective: 'x', type: 'x', totalPhases: 0, estimatedDuration: 0, roles: [], tasks: [],
            }),
        });
        let checks = 0;
        race.runner._gateInvalidated = () => ++checks >= invalidAt;
        await race.runner.start('x');
        assert.equal(race.runner.hasPendingExecution(), false);
    }

    const caught = createHarness(CEOAgentRunner, [ceo], {}, {
        decomposeWithLLM: async () => { throw new Error('primary'); },
    });
    caught.runner._emitCEOMessage = () => { throw new Error('secondary'); };
    await caught.runner.start('x');
    assert.equal(caught.runner.isRunning, false);
});

test('branch matrix covers resume custom fallbacks and malformed task dependencies', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const decomposition = { tasks: [{ phase: 'A', assignee: worker.name, subtasks: [], dependencies: undefined }] };
    const h = createHarness(CEOAgentRunner, [ceo, worker], { decomposition }, {
        ensureProviderConfigsHydrated: async () => ({ custom: undefined }),
        resolveProviderForModel: () => 'unknown',
    });
    h.runner._pendingExecution = { ceoAgent: ceo, teamAgents: [worker], decomposition };
    await h.runner.resume();
    assert.equal(h.runner.hasPendingExecution(), true);

    const cascaded = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    cascaded.runner._phaseFailures = [{ phase: 'failed', reason: 'x' }];
    cascaded.runner._validateTasks = () => ({ ok: true, issues: [] });
    await cascaded.runner._driveExecution(ceo, [worker], {
        objective: 'x', type: 'x', tasks: [
            { phase: 'A', assignee: worker.name, subtasks: [], dependencies: undefined },
            { phase: 'B', assignee: worker.name, subtasks: [], dependencies: ['failed'] },
        ],
    });
    assert.ok(cascaded.runner._phaseFailures.some(failure => failure.phase === 'B'));
});

test('branch matrix covers resumed-agent fallbacks, stale human finish, and hot human decision type', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const replacement = { ...worker, id: 'new-worker' };
    const task = { phase: 'A', assignee: worker.name, subtasks: [], dependencies: [] };
    const decomposition = { tasks: [task] };
    const cp = {
        type: 'running_execution', ceoAgentId: ceo.id, teamAgentIds: [replacement.id], decomposition,
        completedPhases: [], phaseFailures: [],
        inFlight: [{ phase: 'A', agentId: 'missing', agentName: worker.name, nextSubtaskIndex: 0 }],
    };
    const recovery = createHarness(CEOAgentRunner, [ceo, replacement], { decomposition });
    recovery.runner._getLatestAgent = () => null;
    recovery.runner._executeAgentPhase = async () => true;
    recovery.runner._driveExecution = async () => {};
    assert.equal(await recovery.runner.resumeFromExecutionCheckpoint(cp), true);

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    try {
        globalThis.setTimeout = () => 1;
        globalThis.clearTimeout = () => {};
        const stale = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
        const pending = stale.runner._requestHumanIntervention(worker, 'a', null);
        const finish = stale.runner._pendingHumanInput;
        stale.runner._pendingHumanInput = () => {};
        finish('stale');
        stale.runner._pendingHumanInput = finish;
        stale.runner.provideHumanInput('done');
        assert.equal(await pending, 'done');
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }

    const hot = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition,
        workflowCheckpoint: {
            type: 'waiting_for_decision', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
            completedPhases: [], phaseFailures: [], inFlight: [],
        },
    });
    let input;
    hot.runner._pendingHumanInput = value => { input = value; };
    hot.runner.provideHumanInput('done');
    assert.equal(input, 'done');
    assert.equal(hot.state.workflowCheckpoint.type, 'running_execution');
});

test('branch matrix covers aborted phase results, final reporting guards, and empty task totals', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const decomposition = {
        objective: 'x', type: 'x',
        tasks: [{ phase: 'A', assignee: worker.name, subtasks: [], dependencies: [] }],
    };
    const abortedResult = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    abortedResult.runner._executeAgentPhase = async () => {
        abortedResult.runner._aborted = true;
        return false;
    };
    await abortedResult.runner._driveExecution(ceo, [worker], decomposition);
    assert.deepEqual(abortedResult.runner._phaseFailures, []);

    const finalGuard = createHarness(CEOAgentRunner, [ceo], {});
    let delayCalls = 0;
    finalGuard.runner._delay = async () => {
        delayCalls += 1;
        if (delayCalls === 1) finalGuard.runner._aborted = true;
    };
    await finalGuard.runner._driveExecution(ceo, [], { objective: 'x', type: 'x', tasks: [] });
    assert.equal(finalGuard.state.deliverables.length, 0);

    const reportStates = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    await reportStates.runner._driveExecution(
        ceo,
        [worker],
        { objective: 'x', type: 'x', tasks: [
            { phase: 'A', assignee: worker.name, subtasks: [], dependencies: [] },
            { phase: 'B', assignee: worker.name, subtasks: [], dependencies: [] },
        ] },
        { completedPhases: new Set(['A']) }
    );
    assert.ok(reportStates.state.messages.some(message => /完成|汇总/.test(message.dialogue.join(' '))));
});

test('branch matrix covers resume indices, no-checkpoint HITL, and post-finalize abort', async () => {
    const { CEOAgentRunner, ceo, worker } = await fixtures();
    const task = { phase: 'A', assignee: worker.name, subtasks: [], dependencies: [] };
    const decomposition = { tasks: [task] };
    const cp = {
        type: 'running_execution', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        completedPhases: [], phaseFailures: [],
        inFlight: [{ phase: 'A', agentId: worker.id, nextSubtaskIndex: undefined }],
    };
    const resume = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    resume.runner._executeAgentPhase = async () => false;
    resume.runner._driveExecution = async () => {};
    assert.equal(await resume.runner.resumeFromExecutionCheckpoint(cp), true);
    assert.ok(resume.runner._phaseFailures.length > 0);

    const hitl = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    hitl.runner.provideHumanInput('ignored');
    assert.equal(hitl.state.workflowCheckpoint, null);

    const postFinalize = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    postFinalize.runner._runRemainingSubtasks = async () => true;
    postFinalize.runner._finalizeAgentPhase = async () => {
        postFinalize.runner._aborted = true;
        return true;
    };
    assert.equal(await postFinalize.runner._executeAgentPhase(ceo, worker, task, new Set(), [worker]), false);
});

test('branch matrix covers deliverable default meta, pause skips, and decision finish identity', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker, AGENT_STATES } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const tasks = [{ phase: 'A', assignee: worker.name, subtasks: [], dependencies: [] }];
    const decomposition = { objective: 'x', type: 'x', tasks };
    const report = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    report.runner._phaseFailures = null;
    report.runner._phaseResults = null;
    const built = report.runner._buildDeliverable(decomposition, [worker], tasks, {
        completedPhases: undefined, phaseFailures: undefined, phaseResults: undefined,
    });
    assert.equal(built.meta.incompleteCount, 1);

    const pause = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition });
    pause.runner.isRunning = true;
    worker.state = AGENT_STATES.IDLE;
    reviewer.state = AGENT_STATES.EXECUTING;
    reviewer.phase = 'missing';
    pause.state.agents = [ceo, worker, reviewer];
    pause.runner.pause();
    assert.deepEqual(pause.state.workflowCheckpoint.inFlight, []);

    const decision = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition });
    decision.runner._callLLMWithRetry = async () => '{}';
    const pending = decision.runner._escalateDisagreement(ceo, worker, reviewer, 'A', []);
    await settleAsync();
    const finish = decision.runner._pendingDecisionResolve;
    decision.runner._pendingDecisionResolve = () => {};
    finish({ chosenText: 'stale' });
    decision.runner._pendingDecisionResolve = finish;
    decision.runner.resolveDecision(0, 'done');
    await pending;
});

test('branch closure covers state fallbacks and asynchronous abort windows', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker, AGENT_STATES } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试', model: '' });
    const task = { phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: [] };
    const decomposition = { objective: 'x', type: 'x', tasks: [task] };

    // start() can be stopped after the first role is built but before the next role starts.
    const startDecomposition = {
        ...decomposition,
        totalPhases: 1,
        estimatedDuration: 1,
        roles: [
            { name: '一号', role: '开发', model: '' },
            { name: '二号', role: '测试', model: '' },
        ],
        tasks: [],
    };
    const start = createHarness(CEOAgentRunner, [ceo], {}, {
        decomposeWithLLM: async () => startDecomposition,
    });
    let recommendations = 0;
    start.runner._autoRecommendModel = async () => {
        recommendations += 1;
        start.runner._aborted = true;
        return 'recommended';
    };
    await start.runner.start('x');
    assert.equal(recommendations, 1);
    assert.equal(start.state.agents.some(agent => agent.name === '一号'), false);
    assert.equal(start.state.agents.some(agent => agent.name === '二号'), false);

    const context = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    assert.equal(context.runner._restoreCheckpointContext(), null);

    // The gate can become stale after a successful human response but before LLM execution.
    const postGateAbort = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    postGateAbort.runner._checkHumanInterventionNeeded = async () => true;
    postGateAbort.runner._userGate = {
        epoch: () => 0,
        runExclusive: async () => {
            postGateAbort.runner._aborted = true;
            return '已完成';
        },
    };
    assert.equal(await postGateAbort.runner._runRemainingSubtasks(
        ceo, worker, task, new Set(), [worker]
    ), false);

    // Cold HITL restoration must tolerate legacy checkpoints with absent arrays/indexes.
    const legacyCheckpoint = {
        type: 'waiting_for_human',
        ceoAgentId: ceo.id,
        teamAgentIds: [worker.id],
        decomposition,
        currentPhase: 'A',
        currentAgentId: worker.id,
        currentSubtask: 'a',
        currentSubtaskIndex: undefined,
        phaseFailures: null,
        inFlight: null,
    };
    const cold = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    cold.runner._phaseFailures = null;
    cold.runner._executeSubtask = async () => ({
        status: 'success', source: 'llm', content: 'ok', summary: ['ok'],
    });
    cold.runner._runRemainingSubtasks = async (...args) => {
        assert.equal(args[5], 1);
        return false;
    };
    await cold.runner._resumeAfterHumanIntervention(legacyCheckpoint, 'done');
    assert.equal(cold.state.systemStatus, 'blocked');

    // Public message/session boundaries accept sparse persisted records.
    const sparse = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition,
        sessionHistory: [{ objective: 'old', messages: undefined }],
    });
    sparse.runner._emitCEOMessage(ceo, [], [undefined]);
    assert.equal(typeof sparse.runner._buildSessionContext(), 'string');
    sparse.runner._getLatestAgent = () => null;
    sparse.runner.dependencies.loadExecutionCapabilities = async () => ({
        ragContext: '', toolPrompt: '', toolMap: new Map(), policy: {},
    });
    sparse.runner.dependencies.shouldUseToolLoop = () => false;
    sparse.runner.dependencies.formatMemoryContext = () => '';
    sparse.runner._callLLMWithRetry = async () => 'ok';
    assert.equal((await sparse.runner._executeSubtask(worker, 'a', 1)).status, 'success');

    const tools = createHarness(CEOAgentRunner, [ceo, worker]);
    let parsedInput;
    tools.runner._callLLMWithRetry = async () => null;
    tools.runner.dependencies.parseToolCalls = input => {
        parsedInput = input;
        return [];
    };
    assert.equal(await tools.runner._runToolAssistedSubtask(worker, {
        model: 'm', messages: [], availableModels: {}, capabilities: { policy: {}, toolMap: new Map() },
    }), null);
    assert.equal(parsedInput, '');

    // Empty session/model response fallbacks are observable in emitted request/metrics.
    const metrics = createHarness(CEOAgentRunner, [ceo, worker], {
        currentSessionId: '', defaultModel: '', decomposition,
    });
    const logger = (await import('../src/utils/logger.js')).default;
    logger.startSession('');
    let performance;
    metrics.runner.dependencies.recordPerformance = value => { performance = value; };
    metrics.runner._recordPhasePerformance(worker, task, '', null, '');
    assert.ok(performance.sessionId);
    let revisedModel;
    metrics.runner._callLLMWithRetry = async request => {
        revisedModel = request.model;
        return null;
    };
    await metrics.runner._revisePhaseOutput({ ...worker, model: '' }, task, 'draft', 'fix');
    assert.equal(revisedModel, '');

    let collaborationModel;
    metrics.runner._callLLMWithRetry = async request => {
        collaborationModel = request.model;
        return '';
    };
    metrics.runner._checkConsensus = async () => ({ agreed: true, summary: '' });
    await metrics.runner._conductCollaboration(ceo, { ...worker, model: '' }, reviewer, 'A', 1);
    assert.equal(collaborationModel, '');

    // Pause reconstruction accepts sparse state and can preserve legacy completed phases.
    const pause = createHarness(CEOAgentRunner, [ceo, worker], {
        agents: undefined,
        decomposition: { tasks: undefined },
        workflowCheckpoint: { type: 'legacy', completedPhases: ['done'] },
    });
    pause.state.agents = [ceo, { ...worker, state: AGENT_STATES.EXECUTING }];
    pause.runner.isRunning = true;
    pause.runner.pause();
    assert.deepEqual(pause.state.workflowCheckpoint.completedPhases, ['done']);
});

test('branch closure covers warm decision context and cold decision legacy defaults', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const decomposition = { tasks: [] };
    const pendingDecision = {
        topic: 'A', agentA: worker.name, agentB: reviewer.name, proposals: [{ title: 'p' }],
    };

    const warm = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        decomposition,
        pendingDecision,
        workflowCheckpoint: { type: 'waiting_for_human' },
    });
    warm.runner._pendingDecisionResolve = () => {};
    warm.runner._phaseFailures = [{ phase: 'old' }];
    warm.runner._restoreCheckpointContext = () => ({
        ceoAgent: null,
        teamAgents: [worker, reviewer],
        decomposition,
        completedPhases: null,
        phaseFailures: null,
        inFlight: null,
    });
    let promoted;
    warm.runner._promoteGateCheckpointToRunning = (_checkpoint, context) => { promoted = context; };
    warm.runner.resolveDecision(0);
    assert.equal(promoted.ceoAgent.id, ceo.id);
    assert.deepEqual(promoted.phaseFailures, [{ phase: 'old' }]);
    assert.deepEqual(promoted.inFlight, []);

    const checkpoint = {
        type: 'waiting_for_decision', ceoAgentId: ceo.id,
        teamAgentIds: [worker.id, reviewer.id], decomposition,
        phaseFailures: null, inFlight: null,
    };
    const cold = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        decomposition, pendingDecision, workflowCheckpoint: checkpoint,
    });
    cold.runner._phaseFailures = null;
    cold.runner._driveExecution = async () => {};
    await cold.runner._resumeAfterDecision(checkpoint, 'p');
    assert.deepEqual(cold.runner._phaseFailures, []);
});

test('branch closure covers remaining legacy guards and gate payload defaults', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const task = { phase: 'A', assignee: worker.name, subtasks: ['a'], dependencies: undefined };
    const decomposition = { objective: 'x', type: 'x', tasks: [task] };

    // Legacy cold-HITL contexts can omit failures/inFlight/subtasks entirely.
    const cold = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    cold.runner._phaseFailures = null;
    cold.runner._restoreCheckpointContext = () => ({
        ceoAgent: ceo,
        teamAgents: [worker],
        decomposition: { ...decomposition, tasks: [{ ...task, subtasks: undefined }] },
        completedPhases: new Set(),
        phaseFailures: null,
        inFlight: null,
    });
    cold.runner._runRemainingSubtasks = async () => false;
    await cold.runner._resumeAfterHumanIntervention({
        type: 'waiting_for_human', currentPhase: 'A', currentAgentId: worker.id,
        currentSubtask: 'a', currentSubtaskIndex: 0,
    }, '');
    assert.equal(cold.state.systemStatus, 'blocked');

    // A warm provide path uses the runner's failure list when a restored legacy ctx has none.
    const warm = createHarness(CEOAgentRunner, [ceo, worker], {
        decomposition,
        workflowCheckpoint: { type: 'waiting_for_human', currentSubtask: 'a' },
    });
    warm.runner._phaseFailures = [{ phase: 'old' }];
    warm.runner._restoreCheckpointContext = () => ({
        ceoAgent: ceo, teamAgents: [worker], decomposition,
        completedPhases: new Set(), phaseFailures: null, inFlight: [],
    });
    let promoted;
    warm.runner._promoteGateCheckpointToRunning = (_checkpoint, ctx) => { promoted = ctx; };
    let humanInput;
    warm.runner._pendingHumanInput = value => { humanInput = value; };
    warm.runner.provideHumanInput('done');
    assert.equal(humanInput, 'done');
    assert.deepEqual(promoted.phaseFailures, [{ phase: 'old' }]);

    // No decomposition is a supported gate payload fallback and must not leak stale state.
    const gate = createHarness(CEOAgentRunner, [ceo, worker], { decomposition: null });
    gate.runner._checkHumanInterventionNeeded = async () => true;
    gate.runner._requestHumanIntervention = async (_agent, _subtask, payload) => {
        assert.equal(payload.decomposition, null);
        return 'done';
    };
    gate.runner._executeSubtask = async () => ({ status: 'success', source: 'llm', content: 'ok', summary: ['ok'] });
    assert.equal(await gate.runner._runRemainingSubtasks(ceo, worker, task, new Set(), [worker]), true);

    // Sparse decision escalation supplies empty model/context arrays and null decomposition.
    const escalation = createHarness(CEOAgentRunner, [ceo, worker, reviewer], { decomposition: null });
    escalation.runner._callLLMWithRetry = async request => {
        assert.equal(request.model, '');
        return '{}';
    };
    const pending = escalation.runner._escalateDisagreement(
        { ...ceo, model: '' },
        worker,
        reviewer,
        'A',
        [],
        { ceoAgentId: 'ceo-fallback', teamAgentIds: [], decomposition: undefined, completedPhases: [] }
    );
    await settleAsync();
    assert.equal(escalation.state.workflowCheckpoint.decomposition, null);
    escalation.runner.resolveDecision(0, 'done');
    await pending;

    // Validation treats omitted dependencies as an empty list in both graph passes.
    assert.equal(cold.runner._validateTasks([task]).ok, true);

    // A wholly sparse pause state takes the defensive empty-agent path.
    const sparsePause = createHarness(CEOAgentRunner, [ceo], { decomposition });
    sparsePause.runner.isRunning = true;
    sparsePause.runner.getState = () => ({
        agents: [ceo],
        decomposition,
        workflowCheckpoint: null,
    });
    sparsePause.runner.pause();
    assert.equal(sparsePause.runner._paused, true);

});

test('branch closure covers final falsy fallbacks and abort-finally paths', async () => {
    const { createAgent, CEOAgentRunner, ceo, worker, AGENT_STATES } = await fixtures();
    const reviewer = createAgent({ name: '测试员', role: '测试' });
    const task = { phase: 'A', assignee: worker.name, subtasks: undefined, dependencies: [] };
    const decomposition = { tasks: [task] };

    // Cancellation through _aborted (without an AbortError) still runs the recovery finally block.
    const recovery = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    recovery.runner._promoteGateCheckpointToRunning = () => {
        recovery.runner._aborted = true;
        throw new Error('stopped');
    };
    const checkpoint = {
        type: 'running_execution', ceoAgentId: ceo.id, teamAgentIds: [worker.id], decomposition,
        completedPhases: [], phaseFailures: [], inFlight: [],
    };
    assert.equal(await recovery.runner.resumeFromExecutionCheckpoint(checkpoint), false);
    assert.equal(recovery.runner.isRunning, false);

    // A restored task with no subtask array takes the zero-length progress fallback.
    const coldHuman = createHarness(CEOAgentRunner, [ceo, worker], { decomposition });
    coldHuman.runner._restoreCheckpointContext = () => ({
        ceoAgent: ceo, teamAgents: [worker], decomposition,
        completedPhases: new Set(), phaseFailures: [], inFlight: [],
    });
    coldHuman.runner._executeSubtask = async () => ({
        status: 'success', source: 'llm', content: 'ok', summary: ['ok'],
    });
    coldHuman.runner._runRemainingSubtasks = async () => false;
    await coldHuman.runner._resumeAfterHumanIntervention({
        type: 'waiting_for_human', currentPhase: 'A', currentAgentId: worker.id,
        currentSubtask: 'a', currentSubtaskIndex: 0,
    }, 'done');
    assert.equal(coldHuman.state.systemStatus, 'blocked');

    // The logger may have no active session; recordPerformance must receive the explicit empty fallback.
    const metrics = createHarness(CEOAgentRunner, [ceo, worker], {
        currentSessionId: '', promptLogs: [],
    });
    const logger = (await import('../src/utils/logger.js')).default;
    const loggerSessionDescriptor = Object.getOwnPropertyDescriptor(logger, 'getSessionId');
    Object.defineProperty(logger, 'getSessionId', { value: () => null, configurable: true });
    try {
        let recorded;
        metrics.runner.dependencies.recordPerformance = value => { recorded = value; };
        metrics.runner._recordPhasePerformance(worker, task, '', null, '');
        assert.equal(recorded.sessionId, '');
    } finally {
        Object.defineProperty(logger, 'getSessionId', loggerSessionDescriptor);
    }

    // Cold decision recovery also accepts non-array legacy failure/inFlight fields.
    const decisionCheckpoint = {
        type: 'waiting_for_decision', ceoAgentId: ceo.id,
        teamAgentIds: [worker.id, reviewer.id], decomposition: { tasks: [] },
        phaseFailures: null, inFlight: null,
    };
    const coldDecision = createHarness(CEOAgentRunner, [ceo, worker, reviewer], {
        decomposition: { tasks: [] },
        workflowCheckpoint: decisionCheckpoint,
        pendingDecision: { topic: 'A', agentA: worker.name, agentB: reviewer.name, proposals: [] },
    });
    coldDecision.runner._phaseFailures = null;
    coldDecision.runner._restoreCheckpointContext = () => ({
        ceoAgent: ceo,
        teamAgents: [worker, reviewer],
        decomposition: { tasks: [] },
        completedPhases: new Set(),
        phaseFailures: null,
        inFlight: null,
    });
    coldDecision.runner._driveExecution = async () => {};
    await coldDecision.runner._resumeAfterDecision(decisionCheckpoint, 'done');
    assert.deepEqual(coldDecision.runner._phaseFailures, []);

    assert.equal(AGENT_STATES.EXECUTING, 'executing');
});
