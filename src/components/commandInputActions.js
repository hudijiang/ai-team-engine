export function startExecutionFromCheckpoint({
    workflowCheckpoint,
    dispatch,
    getSnapshot,
    getRunnerImpl,
}) {
    const runner = getRunnerImpl(dispatch, getSnapshot);
    if (!runner) {
        return { status: 'missing_runner' };
    }

    if (!runner.hasPendingExecution()) {
        const restored = runner.restorePendingExecution(workflowCheckpoint);
        if (!restored) {
            return { status: 'restore_failed', runner };
        }
    }

    runner.resume();
    return { status: 'resumed', runner };
}

/**
 * 恢复执行：
 * 1) 内存中仍在跑且处于 pause 栅栏 → unpause
 * 2) 页面刷新后仅有 running_execution 检查点 → resumeFromExecutionCheckpoint
 */
export function resumeExecutionAction({
    workflowCheckpoint,
    dispatch,
    getSnapshot,
    getRunnerImpl,
    peekRunnerImpl = null,
}) {
    const live = typeof peekRunnerImpl === 'function' ? peekRunnerImpl() : null;
    if (live?.isRunning && (live._paused || live._pauseBarrier?.isPaused?.())) {
        live.unpause();
        return { status: 'unpaused', runner: live };
    }

    const runner = getRunnerImpl(dispatch, getSnapshot);
    if (!runner) {
        return { status: 'missing_runner' };
    }

    // 内存 pause（getRunner 新建了实例时 isRunning 为 false）
    if (runner.isRunning && (runner._paused || runner._pauseBarrier?.isPaused?.())) {
        runner.unpause();
        return { status: 'unpaused', runner };
    }

    const checkpoint = workflowCheckpoint || getSnapshot()?.workflowCheckpoint;
    if (checkpoint?.type === 'running_execution') {
        void runner.resumeFromExecutionCheckpoint(checkpoint);
        return { status: 'resumed_checkpoint', runner };
    }

    // 兜底：尝试 unpause（无副作用）
    if (typeof runner.unpause === 'function') {
        runner.unpause();
        return { status: 'unpaused_noop', runner };
    }

    return { status: 'noop', runner };
}

export function submitHumanInputAction({
    humanInput,
    dispatch,
    getSnapshot,
    getRunnerImpl,
}) {
    const normalizedInput = humanInput.trim();
    if (!normalizedInput) {
        return { status: 'noop' };
    }

    const runner = getRunnerImpl(dispatch, getSnapshot);
    if (!runner?.provideHumanInput) {
        return { status: 'missing_runner' };
    }

    runner.provideHumanInput(normalizedInput);
    return { status: 'submitted', input: normalizedInput, runner };
}

export function skipHumanInputAction({
    reason = 'FORCE_CONTINUE',
    dispatch,
    getSnapshot,
    getRunnerImpl,
}) {
    const runner = getRunnerImpl(dispatch, getSnapshot);
    if (!runner?.skipHumanInput) {
        return { status: 'missing_runner' };
    }

    runner.skipHumanInput(reason);
    return { status: 'skipped', reason, runner };
}

export function resolveDecisionAction({
    proposalIndex,
    customText = '',
    dispatch,
    getSnapshot,
    getRunnerImpl,
}) {
    const runner = getRunnerImpl(dispatch, getSnapshot);
    if (!runner?.resolveDecision) {
        return { status: 'missing_runner' };
    }

    runner.resolveDecision(proposalIndex, customText);
    return {
        status: 'resolved',
        proposalIndex,
        customText,
        runner,
    };
}

export default {
    startExecutionFromCheckpoint,
    resumeExecutionAction,
    submitHumanInputAction,
    skipHumanInputAction,
    resolveDecisionAction,
};
