/**
 * 用户门禁控制器（HITL / 决策 / 配置确认共用）
 *
 * 从 CEOAgentRunner 抽出 generation 令牌、gateId 所有权与回滚，
 * 便于单测且为后续 Gateway 侧「取消进行中的门禁」留同一语义。
 */

export function createGateController(options = {}) {
    const createId = typeof options.createId === 'function'
        ? options.createId
        : () => `gate-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    let generation = 0;
    let runGateId = null;

    return {
        get generation() {
            return generation;
        },
        set generation(value) {
            const next = Number(value);
            generation = Number.isFinite(next) ? next : 0;
        },
        get runGateId() {
            return runGateId;
        },
        set runGateId(value) {
            runGateId = value || null;
        },

        /** stop / 新一轮执行：作废在途门禁 */
        bump({ rotateRunId = true } = {}) {
            generation += 1;
            if (rotateRunId) {
                runGateId = createId();
            }
            return generation;
        },

        captureToken() {
            if (!runGateId) {
                runGateId = createId();
            }
            return {
                generation,
                gateId: `${runGateId}:${createId()}`,
            };
        },

        isAlive(gen, { aborted = false, signal = null } = {}) {
            return !aborted
                && gen === generation
                && !signal?.aborted;
        },

        invalidated(gen, ctx) {
            return !this.isAlive(gen, ctx);
        },

        rollbackOwned(dispatch, gateId, gateType) {
            if (!gateId || typeof dispatch !== 'function') return;
            dispatch({
                type: 'ROLLBACK_GATE',
                payload: {
                    gateId,
                    gateType,
                    status: 'blocked',
                },
            });
        },

        /**
         * 精简 dispatch 可能没有 ROLLBACK_GATE；
         * 后备路径只按精确 gateId 清理，绝不按 waiting 类型误删新门禁。
         */
        rollbackOwnedCompat({ dispatch, getState, clearCheckpoint }, gateId, gateType) {
            if (!gateId || typeof dispatch !== 'function' || typeof getState !== 'function') return;

            const before = getState() || {};
            const checkpointOwned = before.workflowCheckpoint?.gateId === gateId
                && (!gateType || before.workflowCheckpoint?.type === gateType);
            const decisionOwned = before.pendingDecision?.gateId === gateId;

            this.rollbackOwned(dispatch, gateId, gateType);
            let after = getState() || {};

            if (checkpointOwned && after.workflowCheckpoint?.gateId === gateId) {
                if (typeof clearCheckpoint === 'function') {
                    clearCheckpoint();
                } else {
                    dispatch({ type: 'CLEAR_WORKFLOW_CHECKPOINT' });
                }
                after = getState() || {};
            }
            if (decisionOwned && after.pendingDecision?.gateId === gateId) {
                dispatch({ type: 'RESOLVE_DECISION', payload: { gateId } });
                after = getState() || {};
            }
            if (checkpointOwned && after.systemStatus === gateType) {
                dispatch({ type: 'SET_STATUS', payload: 'blocked' });
            }
        },
    };
}

export default { createGateController };
