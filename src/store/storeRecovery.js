const TRANSIENT_RUNTIME_STATUSES = new Set(['running', 'paused', 'waiting_for_human', 'waiting_for_decision']);

export function hasRecoverableCheckpoint(state) {
    const checkpointType = state.workflowCheckpoint?.type;
    if (state.systemStatus === 'waiting_for_config') {
        return checkpointType === 'waiting_for_config';
    }
    if (state.systemStatus === 'waiting_for_human') {
        return checkpointType === 'waiting_for_human';
    }
    if (state.systemStatus === 'waiting_for_decision') {
        return checkpointType === 'waiting_for_decision' && !!state.pendingDecision;
    }
    return false;
}

export function createWorkflowInterruptedMessage(previousStatus, canResumeConfig = false) {
    const nextStep = canResumeConfig
        ? ['继续完成模型配置', '点击开始执行']
        : ['重新发布目标'];
    const dialogue = canResumeConfig
        ? [
            '检测到页面刷新，内存中的执行器实例已丢失。',
            `当前会话之前停留在「${previousStatus}」状态，但待配置快照仍在，可继续为团队成员选择模型后恢复执行。`,
        ]
        : [
            '检测到页面刷新，内存中的执行器实例已丢失。',
            `当前会话之前停留在「${previousStatus}」状态，已自动切换为阻塞态，请重新发布目标启动新的执行流程。`,
        ];

    return {
        role: '系统',
        state: 'blocked',
        current_task: '执行器实例已中断',
        progress: 1,
        collaborators: ['CEO'],
        dialogue,
        next_step: nextStep,
        agentId: 'system',
        timestamp: new Date().toISOString(),
        source: 'system-recovery',
    };
}

export function sanitizeLoadedState(state) {
    if (!state) return null;

    const next = {
        ...state,
        messages: [...(state.messages || [])],
        workflowCheckpoint: state.workflowCheckpoint || null,
    };

    if (next.systemStatus === 'waiting_for_config') {
        const canResumeConfig = hasRecoverableCheckpoint(next);
        if (!canResumeConfig) {
            next.systemStatus = 'blocked';
            next.workflowCheckpoint = null;
            next.messages.push(createWorkflowInterruptedMessage('waiting_for_config'));
        }
        next.pendingDecision = null;
        return next;
    }

    if (next.systemStatus === 'waiting_for_human') {
        if (!hasRecoverableCheckpoint(next)) {
            next.systemStatus = 'blocked';
            next.workflowCheckpoint = null;
            next.messages.push(createWorkflowInterruptedMessage('waiting_for_human'));
        }
        next.pendingDecision = null;
        return next;
    }

    if (next.systemStatus === 'waiting_for_decision') {
        if (!hasRecoverableCheckpoint(next)) {
            next.systemStatus = 'blocked';
            next.pendingDecision = null;
            next.workflowCheckpoint = null;
            next.messages.push(createWorkflowInterruptedMessage('waiting_for_decision'));
        }
        return next;
    }

    if (TRANSIENT_RUNTIME_STATUSES.has(next.systemStatus)) {
        const previousStatus = next.systemStatus;
        next.systemStatus = 'blocked';
        next.pendingDecision = null;
        next.workflowCheckpoint = null;
        next.messages.push(createWorkflowInterruptedMessage(previousStatus));
        return next;
    }

    next.pendingDecision = next.systemStatus === 'waiting_for_decision'
        ? next.pendingDecision
        : null;
    next.workflowCheckpoint = null;
    return next;
}

export default {
    hasRecoverableCheckpoint,
    createWorkflowInterruptedMessage,
    sanitizeLoadedState,
};
