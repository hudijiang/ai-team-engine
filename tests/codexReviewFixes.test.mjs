/**
 * 针对 Codex 审查复现场景的闭环测试
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    importFreshFromRoot,
    resetBrowserState,
    settleAsync,
} from './helpers/browserEnv.mjs';

test('cold HITL resume never passes raw verification code into subtask', async () => {
    resetBrowserState();
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const worker = createAgent({ name: '工程师', role: 'dev' });
    const decomposition = {
        objective: '登录',
        tasks: [{
            phase: '登录',
            assignee: worker.name,
            subtasks: ['输入验证码', '进入系统'],
            dependencies: [],
        }],
    };
    const checkpoint = {
        type: 'waiting_for_human',
        ceoAgentId: ceo.id,
        teamAgentIds: [worker.id],
        decomposition,
        completedPhases: [],
        currentPhase: '登录',
        currentAgentId: worker.id,
        currentSubtaskIndex: 0,
        currentSubtask: '输入验证码',
        phaseStartedAt: '2026-03-24T10:00:00.000Z',
    };

    const state = {
        agents: [ceo, worker],
        decomposition,
        workflowCheckpoint: checkpoint,
        systemStatus: 'waiting_for_human',
        messages: [],
        availableModels: {},
        pendingDecision: null,
    };
    const dispatch = (action) => {
        if (action.type === 'SET_STATUS') state.systemStatus = action.payload;
        if (action.type === 'CLEAR_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = null;
        if (action.type === 'SET_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = action.payload;
        if (action.type === 'UPDATE_AGENT') {
            const { id, ...u } = action.payload;
            state.agents = state.agents.map(a => (a.id === id ? { ...a, ...u } : a));
        }
        if (action.type === 'UPDATE_AGENT_OUTPUTS') {
            const { id, output } = action.payload;
            state.agents = state.agents.map(a =>
                a.id === id ? { ...a, outputs: [...(a.outputs || []), output] } : a
            );
        }
        if (action.type === 'ADD_MESSAGE') state.messages.push(action.payload);
    };

    const runner = new CEOAgentRunner(dispatch, () => state);
    runner._delay = async () => {};
    let assistArg = null;
    runner._executeSubtask = async (_a, _s, _p, _on, assist) => {
        assistArg = assist;
        return { status: 'failed', source: 'llm-error', content: '', summary: ['fail'], reason: 'boom' };
    };
    runner._runRemainingSubtasks = async () => true;
    runner._finalizeAgentPhase = async () => true;
    runner._driveExecution = async () => {};

    await runner._resumeAfterHumanIntervention(checkpoint, '验证码 1234', { skipped: false });

    assert.equal(String(assistArg || '').includes('1234'), false);
    assert.equal(state.systemStatus, 'blocked');
    // 失败不得 completed
    const outputs = state.agents.find(a => a.id === worker.id).outputs || [];
    assert.ok(outputs.some(o => o.status === 'failed' || o.source === 'llm-error'));
});

test('QA revise prevents phase completion', async () => {
    resetBrowserState();
    const { createAgent, AGENT_STATES } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const worker = createAgent({ name: '工程师', role: 'dev' });
    worker.outputs = [{ phase: '开发', subtask: '实现', content: '草稿', source: 'llm', status: 'success' }];

    const state = {
        agents: [ceo, worker],
        decomposition: { tasks: [{ phase: '开发', assignee: '工程师', subtasks: ['实现'], dependencies: [] }] },
        messages: [],
        availableModels: {},
    };
    const dispatch = (action) => {
        if (action.type === 'UPDATE_AGENT') {
            const { id, ...u } = action.payload;
            state.agents = state.agents.map(a => (a.id === id ? { ...a, ...u } : a));
        }
        if (action.type === 'ADD_MESSAGE') state.messages.push(action.payload);
    };

    const runner = new CEOAgentRunner(dispatch, () => state);
    runner._delay = async () => {};
    runner._runPhaseQualityGate = async () => ({
        result: 'revise',
        suggestion: '不够具体',
        finalContent: '草稿',
        revised: true,
    });
    runner._recordPhasePerformance = () => {};

    const task = state.decomposition.tasks[0];
    const ok = await runner._finalizeAgentPhase(ceo, worker, task, new Set(), [worker]);
    assert.equal(ok, false);
    assert.equal(state.agents.find(a => a.id === worker.id).state, AGENT_STATES.BLOCKED);
    assert.match(state.agents.find(a => a.id === worker.id).currentTask, /QA 未通过/);
});

test('persistRunningCheckpoint does not clobber waiting_for_human type', async () => {
    resetBrowserState();
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const a = createAgent({ name: 'A', role: 'dev' });
    const b = createAgent({ name: 'B', role: 'dev' });
    const decomposition = {
        tasks: [
            { phase: 'p1', assignee: 'A', subtasks: ['s'], dependencies: [] },
            { phase: 'p2', assignee: 'B', subtasks: ['s'], dependencies: [] },
        ],
    };

    const state = {
        agents: [ceo, a, b],
        decomposition,
        workflowCheckpoint: {
            type: 'waiting_for_human',
            ceoAgentId: ceo.id,
            teamAgentIds: [a.id, b.id],
            currentAgentId: a.id,
            currentPhase: 'p1',
            currentSubtask: 's',
            currentSubtaskIndex: 0,
            decomposition,
            completedPhases: [],
        },
        systemStatus: 'waiting_for_human',
        messages: [],
    };
    const dispatch = (action) => {
        if (action.type === 'SET_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = action.payload;
    };

    const runner = new CEOAgentRunner(dispatch, () => state);
    runner._persistRunningCheckpoint(ceo, [a, b], decomposition, new Set(), {
        upsertInFlight: {
            phase: 'p2',
            agentId: b.id,
            agentName: 'B',
            nextSubtaskIndex: 0,
            totalSubtasks: 1,
        },
    });

    assert.equal(state.workflowCheckpoint.type, 'waiting_for_human');
    assert.ok(state.workflowCheckpoint.runningSnapshot);
    assert.equal(state.workflowCheckpoint.currentSubtask, 's');

    // 刷新恢复语义：waiting_for_human 仍可识别
    const { sanitizeLoadedState } = await importFreshFromRoot('src/store/storeRecovery.js');
    const sanitized = sanitizeLoadedState({
        ...state,
        systemStatus: 'waiting_for_human',
        messages: [],
    });
    assert.equal(sanitized.systemStatus, 'waiting_for_human');
    assert.equal(sanitized.workflowCheckpoint?.type, 'waiting_for_human');
});

test('SSE abort after partial content throws rather than resolve partial', async () => {
    const { readStreamingResponse, createLinkedAbortController } = await importFreshFromRoot('src/engine/llmClient.js');

    const encoder = new TextEncoder();
    let pullCount = 0;
    const stream = new ReadableStream({
        pull(controller) {
            pullCount += 1;
            if (pullCount === 1) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
                return;
            }
            // 保持流打开，等待 abort 取消
            return new Promise(() => {});
        },
        cancel() {},
    });

    const res = {
        body: stream,
    };
    const adapter = {
        parseStreamEvent: (data) => data?.choices?.[0]?.delta?.content || '',
    };

    const linked = createLinkedAbortController(null, 60000);
    const readPromise = readStreamingResponse(res, adapter, () => {}, linked.signal);

    await settleAsync(4);
    // 模拟外部取消（与 runner stop 一致）
    linked.signal.dispatchEvent?.(new Event('abort'));
    // AbortController abort
    try {
        // createLinkedAbortController 的 signal 来自内部 controller — 通过超时路径不好测
        // 直接 abort external: 重新构造
    } catch (_) { /* ignore */ }
    linked.clear();

    // 更可靠：直接用 AbortController
    const ac = new AbortController();
    const stream2 = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        },
        pull() {
            return new Promise(() => {});
        },
        cancel() {},
    });
    const p = readStreamingResponse({ body: stream2 }, adapter, () => {}, ac.signal);
    await settleAsync(2);
    ac.abort();
    await assert.rejects(p, (err) => {
        assert.match(err.message || '', /取消|abort|Abort|CANCELLED/i);
        assert.notEqual(err.message, 'partial');
        return true;
    });
});

test('HITL bare OTP never enters prompt context', async () => {
    const {
        buildSafeHumanAssistContext,
        buildHumanAssistPublicMessage,
    } = await importFreshFromRoot('src/utils/sensitiveData.js');

    const ctx = buildSafeHumanAssistContext('123456', '完成步骤二');
    assert.equal(ctx.includes('123456'), false);
    assert.match(ctx, /不透明|脱敏|已接收/);

    const pub = buildHumanAssistPublicMessage('123456', '完成步骤二');
    assert.equal(pub.includes('123456'), false);
});

test('HITL and decision share single user gate mutex', async () => {
    resetBrowserState();
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');
    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const runner = new CEOAgentRunner(() => {}, () => ({ agents: [ceo] }));
    assert.equal(runner._humanGate, runner._userGate);
    assert.equal(runner._decisionGate, runner._userGate);
});

test('restoreCheckpointContext merges runningSnapshot completed phases', async () => {
    resetBrowserState();
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');
    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const w = createAgent({ name: 'A', role: 'dev' });
    const decomposition = {
        tasks: [
            { phase: 'side', assignee: 'A', subtasks: ['s'], dependencies: [] },
            { phase: 'main', assignee: 'A', subtasks: ['s'], dependencies: [] },
        ],
    };
    const state = {
        agents: [ceo, w],
        decomposition,
        workflowCheckpoint: {
            type: 'waiting_for_human',
            ceoAgentId: ceo.id,
            teamAgentIds: [w.id],
            decomposition,
            completedPhases: [],
            currentPhase: 'main',
            runningSnapshot: {
                completedPhases: ['side'],
                phaseFailures: [],
                inFlight: [],
                teamAgentIds: [w.id],
                decomposition,
            },
        },
    };
    const runner = new CEOAgentRunner(() => {}, () => state);
    const ctx = runner._restoreCheckpointContext(state.workflowCheckpoint);
    assert.ok(ctx.completedPhases.has('side'));
    assert.equal(ctx.completedPhases.has('main'), false);
});

test('unknown custom tools default to high_risk and are denied', async () => {
    resetBrowserState();
    const { loadExecutionCapabilities } = await importFreshFromRoot('src/engine/capabilityRuntime.js');
    const { registerTool, getAllTools } = await importFreshFromRoot('src/engine/toolRegistry.js');
    registerTool('custom_write_db', {
        description: 'dangerous',
        parameters: {},
        execute: async () => 'wrote',
        // 无 risk 字段
    });
    const caps = await loadExecutionCapabilities('test');
    const tool = caps.toolMap.get('custom_write_db');
    // 可能因 denylist 不进 map 若 risk high 且 not allowed - 应仍在 map 但 not visible
    if (tool) {
        assert.equal(tool.risk, 'high_risk');
    }
    assert.equal(caps.toolPrompt.includes('custom_write_db'), false);
    // cleanup
    const all = getAllTools();
    delete all.custom_write_db;
});

test('deliverable does not claim all success from partial outputs', async () => {
    resetBrowserState();
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');
    const { STEP_STATUS } = await importFreshFromRoot('src/engine/executionResult.js');

    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const worker = createAgent({ name: '工程师', role: 'dev' });
    worker.outputs = [
        { phase: '开发', subtask: '设计', content: 'only one', source: 'llm', status: STEP_STATUS.SUCCESS },
    ];
    const tasks = [{
        phase: '开发',
        assignee: '工程师',
        subtasks: ['设计', '编码'],
        dependencies: [],
    }];
    const state = { agents: [ceo, worker], messages: [] };
    const runner = new CEOAgentRunner(() => {}, () => state);
    runner._phaseFailures = [];
    runner._phaseResults = {};

    // 未进 completedPhases → incomplete
    const d1 = runner._buildDeliverable(
        { objective: 'x', type: 't' },
        [worker],
        tasks,
        { completedPhases: new Set(), phaseFailures: [] }
    );
    assert.match(d1.content, /未完成|部分完成/);
    assert.equal(d1.meta.allSuccess, false);
    assert.equal(d1.meta.successCount, 0);

    // 错误地只有 completed 但子任务不全 → incomplete
    const d2 = runner._buildDeliverable(
        { objective: 'x', type: 't' },
        [worker],
        tasks,
        { completedPhases: new Set(['开发']), phaseFailures: [], phaseResults: { 开发: { status: 'success', qa: 'pass' } } }
    );
    assert.equal(d2.meta.successCount, 0);
    assert.match(d2.content, /子任务未全部成功|incomplete|未完成/);
});

test('sensitiveData covers sk-proj sk-ant AIza ghp prefixes', async () => {
    const { redactSensitive } = await importFreshFromRoot('src/utils/sensitiveData.js');
    const samples = [
        'sk-proj-abcdefghijklmnopqrstuvwxyz',
        'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
        'AIzaSyDummyGoogleApiKeyValue123456',
        'ghp_abcdefghijklmnopqrstuvwxyz1234',
    ];
    for (const s of samples) {
        const out = redactSensitive(s);
        assert.notEqual(out, s, `should redact ${s.slice(0, 12)}`);
        assert.match(out, /REDACTED/i);
    }
});

test('simulated web_search is not in default tool map', async () => {
    resetBrowserState();
    const { loadExecutionCapabilities } = await importFreshFromRoot('src/engine/capabilityRuntime.js');
    const caps = await loadExecutionCapabilities('搜索一下市场');
    assert.equal(caps.toolMap.has('web_search'), false);
});
