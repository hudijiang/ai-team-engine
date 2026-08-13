import test from 'node:test';
import assert from 'node:assert/strict';
import { importFreshFromRoot } from './helpers/browserEnv.mjs';

test('buildReadiness asks for CEO model before publish', async () => {
    const { buildReadiness } = await importFreshFromRoot('src/engine/readiness.js');
    const idle = buildReadiness({
        agents: [{ name: 'CEO', model: '' }],
        systemStatus: 'idle',
        gatewayProbe: { mode: 'direct', ok: true },
    });
    assert.equal(idle.ready, false);
    assert.equal(idle.issues.some(item => item.id === 'ceo-model'), true);

    const ready = buildReadiness({
        agents: [{ name: 'CEO', model: 'gpt-4o-mini' }],
        systemStatus: 'idle',
        gatewayProbe: { mode: 'direct', ok: true },
    });
    assert.equal(ready.ready, true);
});

test('buildReadiness reports gateway and team model gaps', async () => {
    const { buildReadiness } = await importFreshFromRoot('src/engine/readiness.js');
    const down = buildReadiness({
        agents: [{ name: 'CEO', model: 'gpt-4o-mini' }],
        systemStatus: 'idle',
        gatewayProbe: { mode: 'gateway', ok: false, reason: 'unreachable' },
    });
    assert.equal(down.issues.some(item => item.id === 'gw-down'), true);

    const waiting = buildReadiness({
        agents: [
            { name: 'CEO', model: 'gpt-4o-mini' },
            { name: '工程师', model: '' },
        ],
        systemStatus: 'waiting_for_config',
        gatewayProbe: { mode: 'gateway', ok: true, reason: null },
    });
    assert.equal(waiting.ready, false);
    assert.match(waiting.issues.find(item => item.id === 'team-models').label, /工程师/);
});
