import test from 'node:test';
import assert from 'node:assert/strict';
import { importFreshFromRoot } from './helpers/browserEnv.mjs';

test('gate controller bump invalidates captured generation', async () => {
    const { createGateController } = await importFreshFromRoot('src/engine/gateController.js');
    const gates = createGateController({ createId: (() => {
        let n = 0;
        return () => `id-${++n}`;
    })() });

    const token = gates.captureToken();
    assert.equal(gates.isAlive(token.generation), true);
    assert.match(token.gateId, /^id-1:id-2$/);

    gates.bump({ rotateRunId: false });
    assert.equal(gates.invalidated(token.generation), true);
    assert.equal(gates.runGateId, 'id-1');
});

test('rollbackOwnedCompat only clears matching gateId', async () => {
    const { createGateController } = await importFreshFromRoot('src/engine/gateController.js');
    const gates = createGateController({ createId: () => 'x' });

    const state = {
        systemStatus: 'waiting_for_human',
        workflowCheckpoint: { type: 'waiting_for_human', gateId: 'old' },
        pendingDecision: { gateId: 'new' },
    };
    const actions = [];
    const dispatch = (action) => {
        actions.push(action);
        if (action.type === 'ROLLBACK_GATE' && state.workflowCheckpoint?.gateId === action.payload.gateId) {
            state.workflowCheckpoint = null;
        }
        if (action.type === 'RESOLVE_DECISION' && state.pendingDecision?.gateId === action.payload.gateId) {
            state.pendingDecision = null;
        }
        if (action.type === 'SET_STATUS') state.systemStatus = action.payload;
        if (action.type === 'CLEAR_WORKFLOW_CHECKPOINT') state.workflowCheckpoint = null;
    };

    gates.rollbackOwnedCompat({
        dispatch,
        getState: () => state,
        clearCheckpoint: () => dispatch({ type: 'CLEAR_WORKFLOW_CHECKPOINT' }),
    }, 'old', 'waiting_for_human');

    assert.equal(state.workflowCheckpoint, null);
    assert.equal(state.pendingDecision.gateId, 'new');
    assert.equal(state.systemStatus, 'blocked');
});
