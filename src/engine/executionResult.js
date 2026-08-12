/**
 * 严格执行结果模型（商用 P0）
 * 禁止把 template / 空产出 / 跳过 / 失败混称为 success
 */

export const STEP_STATUS = {
    SUCCESS: 'success',
    FAILED: 'failed',
    BLOCKED: 'blocked',
    DEGRADED: 'degraded',
    SKIPPED: 'skipped',
    PENDING: 'pending',
};

/** 可计为「阶段实质完成」的状态 */
export function isSuccessStatus(status) {
    return status === STEP_STATUS.SUCCESS;
}

/** 是否允许进入下游依赖 */
export function canUnlockDependents(status) {
    return status === STEP_STATUS.SUCCESS;
}

/**
 * 子任务结果规范化
 * @param {object} partial
 * @returns {{status: string, source: string, content: string, summary: string[], reason?: string, degraded?: boolean}}
 */
export function normalizeSubtaskResult(partial = {}) {
    const source = partial.source || 'unknown';
    let status = partial.status;

    if (!status) {
        if (source === 'template' || source === 'fallback') {
            status = STEP_STATUS.FAILED;
        } else if (source === 'skipped' || source === 'checkpoint-skip') {
            status = STEP_STATUS.SKIPPED;
        } else if (partial.content && String(partial.content).trim()) {
            status = STEP_STATUS.SUCCESS;
        } else {
            status = STEP_STATUS.FAILED;
        }
    }

    // 模板产出一律不得标 success
    if ((source === 'template' || source === 'fallback') && status === STEP_STATUS.SUCCESS) {
        status = STEP_STATUS.FAILED;
    }

    return {
        status,
        source,
        content: partial.content || '',
        summary: Array.isArray(partial.summary) ? partial.summary : [],
        reason: partial.reason || '',
        degraded: !!partial.degraded || status === STEP_STATUS.DEGRADED,
    };
}

/**
 * 从阶段内子任务结果汇总阶段状态
 * @param {Array<{status: string}>} subtaskResults
 */
export function aggregatePhaseStatus(subtaskResults = []) {
    if (!subtaskResults.length) return STEP_STATUS.FAILED;

    const statuses = subtaskResults.map(r => r.status);
    if (statuses.some(s => s === STEP_STATUS.FAILED || s === STEP_STATUS.BLOCKED)) {
        // 全部失败 → failed；部分成功 → degraded（但默认商用策略：有失败即 failed）
        const anySuccess = statuses.some(s => s === STEP_STATUS.SUCCESS || s === STEP_STATUS.SKIPPED);
        if (!anySuccess) return STEP_STATUS.FAILED;
        // 有实质失败则阶段失败（严格）
        if (statuses.some(s => s === STEP_STATUS.FAILED)) return STEP_STATUS.FAILED;
        if (statuses.some(s => s === STEP_STATUS.BLOCKED)) return STEP_STATUS.BLOCKED;
    }
    if (statuses.every(s => s === STEP_STATUS.SKIPPED)) return STEP_STATUS.SKIPPED;
    if (statuses.some(s => s === STEP_STATUS.DEGRADED)) return STEP_STATUS.DEGRADED;
    if (statuses.every(s => s === STEP_STATUS.SUCCESS || s === STEP_STATUS.SKIPPED)) {
        return STEP_STATUS.SUCCESS;
    }
    return STEP_STATUS.FAILED;
}

export function statusLabel(status) {
    const map = {
        [STEP_STATUS.SUCCESS]: '成功',
        [STEP_STATUS.FAILED]: '失败',
        [STEP_STATUS.BLOCKED]: '阻塞',
        [STEP_STATUS.DEGRADED]: '降级',
        [STEP_STATUS.SKIPPED]: '跳过',
        [STEP_STATUS.PENDING]: '待定',
    };
    return map[status] || status || '未知';
}

export default {
    STEP_STATUS,
    isSuccessStatus,
    canUnlockDependents,
    normalizeSubtaskResult,
    aggregatePhaseStatus,
    statusLabel,
};
