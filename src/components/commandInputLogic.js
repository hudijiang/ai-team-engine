export function buildObjectiveMessage(objective, timestamp = new Date().toISOString()) {
    return {
        role: '董事长',
        state: 'idle',
        current_task: '发布战略目标',
        progress: 1.0,
        collaborators: ['CEO'],
        dialogue: [`📢 战略目标发布：「${objective}」`, '请CEO分析并组织执行。'],
        next_step: [],
        agentId: 'chairman',
        timestamp,
    };
}

export function buildConfigRecoveryFailureMessage(timestamp = new Date().toISOString()) {
    return {
        role: '系统',
        state: 'blocked',
        current_task: '待配置快照恢复失败',
        progress: 1,
        collaborators: ['CEO'],
        dialogue: [
            '检测到页面刷新后尝试恢复待配置阶段，但缺少完整的执行快照。',
            '当前会话已切换为阻塞态，请重新发布目标启动新的执行流程。',
        ],
        next_step: ['重新发布目标'],
        agentId: 'system',
        timestamp,
        source: 'system-recovery',
    };
}

export function canSubmitObjective({ objective, systemStatus, ceoHasModel = true }) {
    const normalizedObjective = objective.trim();
    const blockedStatuses = new Set(['running', 'waiting_for_config', 'waiting_for_human', 'waiting_for_decision', 'paused']);
    return !!normalizedObjective && !blockedStatuses.has(systemStatus) && ceoHasModel !== false;
}

export function restoreConfigCheckpoint({
    systemStatus,
    workflowCheckpoint,
    dispatch,
    getSnapshot,
    getRunnerImpl,
}) {
    if (systemStatus !== 'waiting_for_config' || workflowCheckpoint?.type !== 'waiting_for_config') {
        return { status: 'noop' };
    }

    const runner = getRunnerImpl(dispatch, getSnapshot);
    if (runner.hasPendingExecution()) {
        return { status: 'already_pending', runner };
    }

    const restored = runner.restorePendingExecution(workflowCheckpoint);
    if (restored) {
        return { status: 'restored', runner };
    }

    dispatch({ type: 'CLEAR_WORKFLOW_CHECKPOINT' });
    dispatch({ type: 'SET_STATUS', payload: 'blocked' });
    dispatch({
        type: 'ADD_MESSAGE',
        payload: buildConfigRecoveryFailureMessage(),
    });
    return { status: 'blocked', runner };
}

export function submitObjectiveCommand({
    objective,
    systemStatus,
    dispatch,
    getSnapshot,
    clearRunnerImpl,
    replaceRunnerImpl,
}) {
    const normalizedObjective = objective.trim();
    const agents = getSnapshot?.()?.agents;
    const ceoHasModel = !Array.isArray(agents) || agents.length === 0
        || agents.some(agent => agent.name === 'CEO' && !!agent.model);
    if (!canSubmitObjective({ objective: normalizedObjective, systemStatus, ceoHasModel })) {
        return { status: 'noop' };
    }

    clearRunnerImpl();
    dispatch({ type: 'SET_OBJECTIVE', payload: normalizedObjective });
    dispatch({
        type: 'ADD_MESSAGE',
        payload: buildObjectiveMessage(normalizedObjective),
    });

    const runner = replaceRunnerImpl(dispatch, getSnapshot);
    runner.start(normalizedObjective);

    return {
        status: 'started',
        objective: normalizedObjective,
        runner,
    };
}

export default {
    buildObjectiveMessage,
    buildConfigRecoveryFailureMessage,
    canSubmitObjective,
    restoreConfigCheckpoint,
    submitObjectiveCommand,
};
