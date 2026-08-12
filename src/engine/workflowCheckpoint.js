/**
 * 工作流检查点 — 商用级可恢复进度模型
 *
 * running_execution 支持：
 * - completedPhases: 已成功完成的阶段
 * - phaseFailures: 已判定失败的阶段
 * - inFlight: 进行中阶段的子任务进度（可从 nextSubtaskIndex 续跑）
 */

export const CHECKPOINT_TYPES = {
    WAITING_FOR_CONFIG: 'waiting_for_config',
    WAITING_FOR_HUMAN: 'waiting_for_human',
    WAITING_FOR_DECISION: 'waiting_for_decision',
    RUNNING_EXECUTION: 'running_execution',
};

/**
 * @typedef {object} InFlightPhase
 * @property {string} phase
 * @property {string} agentId
 * @property {string} [agentName]
 * @property {number} nextSubtaskIndex  下一个待执行子任务下标
 * @property {string} [phaseStartedAt]
 * @property {number} [totalSubtasks]
 * @property {string} [currentSubtask]  当前/刚完成的子任务描述（展示用）
 */

/**
 * @typedef {object} RunningExecutionCheckpoint
 * @property {'running_execution'} type
 * @property {string} ceoAgentId
 * @property {string[]} teamAgentIds
 * @property {object} decomposition
 * @property {string[]} completedPhases
 * @property {Array<{phase: string, reason: string}>} phaseFailures
 * @property {InFlightPhase[]} inFlight
 * @property {string} updatedAt
 */

export function normalizeInFlight(list = []) {
    if (!Array.isArray(list)) return [];
    const byPhase = new Map();
    for (const item of list) {
        if (!item?.phase || !item?.agentId) continue;
        const nextSubtaskIndex = Math.max(0, Number(item.nextSubtaskIndex) || 0);
        byPhase.set(item.phase, {
            phase: item.phase,
            agentId: item.agentId,
            agentName: item.agentName || '',
            nextSubtaskIndex,
            phaseStartedAt: item.phaseStartedAt || null,
            totalSubtasks: Number(item.totalSubtasks) || 0,
            currentSubtask: item.currentSubtask || '',
        });
    }
    return Array.from(byPhase.values());
}

/**
 * 插入/更新进行中阶段进度
 */
export function upsertInFlight(inFlight = [], entry) {
    const list = normalizeInFlight(inFlight);
    if (!entry?.phase || !entry?.agentId) return list;

    const next = {
        phase: entry.phase,
        agentId: entry.agentId,
        agentName: entry.agentName || '',
        nextSubtaskIndex: Math.max(0, Number(entry.nextSubtaskIndex) || 0),
        phaseStartedAt: entry.phaseStartedAt || new Date().toISOString(),
        totalSubtasks: Number(entry.totalSubtasks) || 0,
        currentSubtask: entry.currentSubtask || '',
    };

    const idx = list.findIndex(item => item.phase === next.phase);
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    return list;
}

/**
 * 移除已完成/失败阶段的 inFlight 记录
 */
export function removeInFlight(inFlight = [], phase) {
    return normalizeInFlight(inFlight).filter(item => item.phase !== phase);
}

/**
 * 构建 running_execution 检查点（可与现有合并 inFlight）
 */
export function buildRunningExecutionCheckpoint({
    ceoAgentId,
    teamAgentIds = [],
    decomposition,
    completedPhases = [],
    phaseFailures = [],
    inFlight = [],
    existing = null,
} = {}) {
    const baseInFlight = existing?.type === CHECKPOINT_TYPES.RUNNING_EXECUTION
        ? normalizeInFlight(existing.inFlight)
        : [];

    // 已完成/失败的阶段不得残留 inFlight
    const completedSet = new Set(completedPhases || []);
    const failedSet = new Set((phaseFailures || []).map(f => f.phase));
    let mergedInFlight = normalizeInFlight([
        ...baseInFlight,
        ...normalizeInFlight(inFlight),
    ]).filter(item => !completedSet.has(item.phase) && !failedSet.has(item.phase));

    // 若显式传入 inFlight 覆盖同 phase
    if (Array.isArray(inFlight) && inFlight.length > 0) {
        for (const entry of inFlight) {
            if (completedSet.has(entry.phase) || failedSet.has(entry.phase)) {
                mergedInFlight = removeInFlight(mergedInFlight, entry.phase);
            } else {
                mergedInFlight = upsertInFlight(mergedInFlight, entry);
            }
        }
        mergedInFlight = mergedInFlight.filter(
            item => !completedSet.has(item.phase) && !failedSet.has(item.phase)
        );
    }

    return {
        type: CHECKPOINT_TYPES.RUNNING_EXECUTION,
        ceoAgentId,
        teamAgentIds: [...teamAgentIds],
        decomposition: decomposition || existing?.decomposition || null,
        completedPhases: [...completedPhases],
        phaseFailures: Array.isArray(phaseFailures) ? phaseFailures.map(f => ({
            phase: f.phase,
            reason: f.reason || 'failed',
        })) : [],
        inFlight: mergedInFlight,
        updatedAt: new Date().toISOString(),
    };
}

/**
 * 在现有 running 检查点上更新 inFlight 子任务进度
 */
export function patchRunningCheckpointProgress(existing, {
    completedPhases,
    phaseFailures,
    upsert,
    removePhase,
    teamAgentIds,
} = {}) {
    if (!existing || existing.type !== CHECKPOINT_TYPES.RUNNING_EXECUTION) {
        return null;
    }

    let inFlight = normalizeInFlight(existing.inFlight);
    if (upsert) {
        inFlight = upsertInFlight(inFlight, upsert);
    }
    if (removePhase) {
        inFlight = removeInFlight(inFlight, removePhase);
    }

    const completed = completedPhases
        ? [...completedPhases]
        : [...(existing.completedPhases || [])];
    const failures = phaseFailures
        ? [...phaseFailures]
        : [...(existing.phaseFailures || [])];

    const completedSet = new Set(completed);
    const failedSet = new Set(failures.map(f => f.phase));
    inFlight = inFlight.filter(item => !completedSet.has(item.phase) && !failedSet.has(item.phase));

    return {
        ...existing,
        teamAgentIds: teamAgentIds || existing.teamAgentIds,
        completedPhases: completed,
        phaseFailures: failures,
        inFlight,
        updatedAt: new Date().toISOString(),
    };
}

/**
 * 根据 agent.outputs 推断阶段内下一个应执行的子任务下标（幂等续跑）
 */
export function inferNextSubtaskIndex(agent, task) {
    const subtasks = task?.subtasks || [];
    if (subtasks.length === 0) return 0;
    const outputs = agent?.outputs || [];
    let done = 0;
    for (let i = 0; i < subtasks.length; i++) {
        const name = subtasks[i];
        const has = outputs.some(o =>
            (o.phase === task.phase || !o.phase)
            && o.subtask === name
            && (o.content || '').trim().length > 0
            && o.source !== 'template'
            && o.source !== 'fallback'
            && o.status !== 'failed'
            && o.status !== 'skipped'
            && o.status !== 'blocked'
        );
        if (has) done = i + 1;
        else break; // 要求按序完成，中断后后续不算
    }
    return done;
}

export function isSubtaskOutputPresent(agent, phase, subtask) {
    return (agent?.outputs || []).some(o =>
        (o.phase === phase || !o.phase)
        && o.subtask === subtask
        && (o.content || '').trim().length > 0
        && o.source !== 'template'
        && o.source !== 'fallback'
        && o.status !== 'failed'
        && o.status !== 'skipped'
        && o.status !== 'blocked'
    );
}

/**
 * 校验 running_execution 是否可用于恢复
 */
export function isValidRunningCheckpoint(cp, state = {}) {
    if (!cp || cp.type !== CHECKPOINT_TYPES.RUNNING_EXECUTION) return false;
    if (!cp.decomposition && !state.decomposition) return false;
    if (!Array.isArray(cp.teamAgentIds) || cp.teamAgentIds.length === 0) return false;
    if (!Array.isArray(cp.completedPhases)) return false;
    if (cp.inFlight != null && !Array.isArray(cp.inFlight)) return false;

    const agents = state.agents || [];
    const resolved = cp.teamAgentIds.filter(id => agents.some(a => a.id === id));
    return resolved.length > 0;
}

/**
 * UI / 日志摘要
 */
export function summarizeRunningCheckpoint(cp, decomposition = null) {
    const decomp = decomposition || cp?.decomposition;
    const total = decomp?.tasks?.length || 0;
    const completed = cp?.completedPhases?.length || 0;
    const failed = cp?.phaseFailures?.length || 0;
    const inFlight = normalizeInFlight(cp?.inFlight);
    const inFlightLines = inFlight.map(item => {
        const totalSub = item.totalSubtasks || 0;
        const done = item.nextSubtaskIndex;
        const progress = totalSub > 0 ? `${Math.min(done, totalSub)}/${totalSub}` : `${done}`;
        return `${item.phase}（${item.agentName || item.agentId} ${progress} 子任务）`;
    });

    return {
        totalPhases: total,
        completedCount: completed,
        failedCount: failed,
        inFlightCount: inFlight.length,
        inFlightLines,
        label: inFlight.length > 0
            ? `已完成 ${completed}/${total || '?'} 阶段，进行中 ${inFlight.length} 个阶段`
            : `已完成 ${completed}/${total || '?'} 阶段`,
    };
}

export default {
    CHECKPOINT_TYPES,
    normalizeInFlight,
    upsertInFlight,
    removeInFlight,
    buildRunningExecutionCheckpoint,
    patchRunningCheckpointProgress,
    inferNextSubtaskIndex,
    isSubtaskOutputPresent,
    isValidRunningCheckpoint,
    summarizeRunningCheckpoint,
};
