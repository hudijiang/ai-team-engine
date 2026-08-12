import test from 'node:test';
import assert from 'node:assert/strict';
import {
    importFreshFromRoot,
    resetBrowserState,
} from './helpers/browserEnv.mjs';

test('normalizeSubtaskResult never treats template as success', async () => {
    const { normalizeSubtaskResult, STEP_STATUS } = await importFreshFromRoot('src/engine/executionResult.js');
    const r = normalizeSubtaskResult({
        source: 'template',
        content: '假装成功',
        summary: ['x'],
        status: 'success',
    });
    assert.equal(r.status, STEP_STATUS.FAILED);
});

test('sensitive redaction covers codes and tokens', async () => {
    const {
        redactSensitive,
        buildSafeHumanAssistContext,
        isHighRiskHumanTask,
    } = await importFreshFromRoot('src/utils/sensitiveData.js');

    assert.equal(isHighRiskHumanTask('输入短信验证码完成登录'), true);
    assert.match(redactSensitive('Authorization: Bearer abcdefghijklmnop'), /REDACTED/i);
    assert.match(redactSensitive('sk-abcdefghijklmnopqrstuv'), /REDACTED/);

    const safe = buildSafeHumanAssistContext('验证码：948271', '扫码登录');
    assert.equal(safe.includes('948271'), false);
    assert.match(safe, /已脱敏|已完成|人类完成/);
});

test('tool policy denies high-risk MCP by default and validates params', async () => {
    const {
        isToolAllowed,
        validateToolParams,
        TOOL_RISK,
    } = await importFreshFromRoot('src/engine/toolPolicy.js');

    const mcpTool = { name: 'mcp.x.delete', risk: 'high_risk', parameters: {} };
    const denied = isToolAllowed('mcp.x.delete', mcpTool, {
        allowHighRisk: false,
        allowReversibleWrite: false,
    });
    assert.equal(denied.allowed, false);
    assert.equal(denied.risk, TOOL_RISK.HIGH_RISK);

    const calc = {
        parameters: { expression: { type: 'string' } },
        required: ['expression'],
    };
    assert.equal(validateToolParams(calc, {}).ok, false);
    assert.equal(validateToolParams(calc, { expression: '1+1' }).ok, true);
});

test('executeCapabilityTool rejects disallowed tools with typed result', async () => {
    resetBrowserState();
    const { executeCapabilityTool } = await importFreshFromRoot('src/engine/capabilityRuntime.js');
    const toolMap = new Map([
        ['mcp.evil', {
            name: 'mcp.evil',
            risk: 'high_risk',
            parameters: {},
            execute: async () => 'should-not-run',
        }],
    ]);
    const result = await executeCapabilityTool(toolMap, 'mcp.evil', {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.match(result.error, /拒绝|默认/);
});

test('HITL check is fail-closed on keyword high-risk tasks', async () => {
    resetBrowserState();
    const { createAgent } = await importFreshFromRoot('src/engine/agentEngine.js');
    const { CEOAgentRunner } = await importFreshFromRoot('src/engine/ceoAgent.js');

    const ceo = createAgent({ name: 'CEO', role: 'ceo' });
    const worker = createAgent({ name: '工程师', role: 'dev' });
    const runner = new CEOAgentRunner(() => {}, () => ({
        agents: [ceo, worker],
        availableModels: {},
        defaultModel: '',
    }));

    const needed = await runner._checkHumanInterventionNeeded(worker, '完成支付并输入验证码');
    assert.equal(needed, true);
});
