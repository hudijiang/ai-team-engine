import { CEOAgentRunner } from './ceoAgent.js';
import { ABORT_REASON } from './executionControl.js';

let activeRunner = null;

export function bindStore(runner, dispatch, getState) {
    if (!runner) return runner;
    if (typeof runner.bindStore === 'function') {
        runner.bindStore(dispatch, getState);
        return runner;
    }
    runner._rawDispatch = dispatch;
    runner.getState = getState;
    return runner;
}

export function getRunner(dispatch, getState) {
    if (!activeRunner) {
        activeRunner = new CEOAgentRunner(dispatch, getState);
    }
    return bindStore(activeRunner, dispatch, getState);
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
        const runner = activeRunner;
        activeRunner = null;
        return Promise.resolve(runner.stop(ABORT_REASON.STOPPED));
    }
    return Promise.resolve(null);
}

export default {
    getRunner,
    replaceRunner,
    peekRunner,
    clearRunner,
    bindStore,
};
