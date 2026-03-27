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
    submitHumanInputAction,
    skipHumanInputAction,
    resolveDecisionAction,
};
