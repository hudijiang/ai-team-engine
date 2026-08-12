import {
    isValidRunningCheckpoint,
    summarizeRunningCheckpoint,
} from '../engine/workflowCheckpoint.js';

const TRANSIENT_RUNTIME_STATUSES = new Set(['running', 'paused']);

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
    if (state.systemStatus === 'running' || state.systemStatus === 'paused') {
        return hasRecoverableRunningCheckpoint(state);
    }
    return false;
}

/**
 * 运行中阶段/子任务检查点是否可恢复
 */
export function hasRecoverableRunningCheckpoint(state) {
    return isValidRunningCheckpoint(state.workflowCheckpoint, state);
}

export function createWorkflowInterruptedMessage(previousStatus, options = {}) {
    const {
        canResumeConfig = false,
        canResumeExecution = false,
        checkpointSummary = null,
    } = options;

    let nextStep = ['重新发布目标'];
    let dialogue;

    if (canResumeExecution) {
        nextStep = ['点击「从检查点继续」恢复', '或重置后重新发布'];
        dialogue = [
            '检测到页面刷新，内存中的执行器实例已丢失。',
            `当前会话之前停留在「${previousStatus}」状态。`,
            checkpointSummary
                ? `检查点：${checkpointSummary}。已完成阶段不会重复执行；进行中阶段将从子任务断点续跑。`
                : '已保存阶段/子任务检查点，可从断点继续执行。',
        ];
    } else if (canResumeConfig) {
        nextStep = ['继续完成模型配置', '点击开始执行'];
        dialogue = [
            '检测到页面刷新，内存中的执行器实例已丢失。',
            `当前会话之前停留在「${previousStatus}」状态，但待配置快照仍在，可继续为团队成员选择模型后恢复执行。`,
        ];
    } else {
        dialogue = [
            '检测到页面刷新，内存中的执行器实例已丢失。',
            `当前会话之前停留在「${previousStatus}」状态，已自动切换为阻塞态，请重新发布目标启动新的执行流程。`,
        ];
    }

    return {
        role: '系统',
        state: canResumeExecution ? 'paused' : 'blocked',
        current_task: canResumeExecution ? '可从检查点恢复' : '执行器实例已中断',
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

    // 运行中 / 暂停：若存在阶段+子任务检查点，降级为 paused 供用户继续
    if (TRANSIENT_RUNTIME_STATUSES.has(next.systemStatus)) {
        const previousStatus = next.systemStatus;
        if (hasRecoverableRunningCheckpoint(next)) {
            next.systemStatus = 'paused';
            next.pendingDecision = null;
            const summary = summarizeRunningCheckpoint(
                next.workflowCheckpoint,
                next.decomposition || next.workflowCheckpoint?.decomposition
            );
            next.messages.push(createWorkflowInterruptedMessage(previousStatus, {
                canResumeExecution: true,
                checkpointSummary: summary.label,
            }));
            return next;
        }

        next.systemStatus = 'blocked';
        next.pendingDecision = null;
        next.workflowCheckpoint = null;
        next.messages.push(createWorkflowInterruptedMessage(previousStatus));
        return next;
    }

    next.pendingDecision = next.systemStatus === 'waiting_for_decision'
        ? next.pendingDecision
        : null;

    // idle/completed/blocked 清理检查点
    if (['idle', 'completed', 'blocked'].includes(next.systemStatus)) {
        next.workflowCheckpoint = null;
    }

    return next;
}

export default {
    hasRecoverableCheckpoint,
    hasRecoverableRunningCheckpoint,
    createWorkflowInterruptedMessage,
    sanitizeLoadedState,
};
