import { CEOAgentRunner } from './ceoAgent.js';
import { ABORT_REASON } from './executionControl.js';

let activeRunner = null;

function bindRunner(runner, dispatch, getState) {
    runner.dispatch = dispatch;
    runner.getState = getState;
    return runner;
}

export function getRunner(dispatch, getState) {
    if (!activeRunner) {
        activeRunner = new CEOAgentRunner(dispatch, getState);
    }
    return bindRunner(activeRunner, dispatch, getState);
}

export function replaceRunner(dispatch, getState) {
    if (activeRunner) {
        activeRunner.stop(ABORT_REASON.RESET);
    }
    activeRunner = new CEOAgentRunner(dispatch, getState);
    return activeRunner;
}

export function peekRunner() {
    return activeRunner;
}

export function clearRunner() {
    if (activeRunner) {
        activeRunner.stop(ABORT_REASON.STOPPED);
        activeRunner = null;
    }
}

export default {
    getRunner,
    replaceRunner,
    peekRunner,
    clearRunner,
};
