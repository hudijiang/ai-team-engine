/**
 * 执行控制原语 — 商用级调度所需的互斥、暂停与中止语义
 */

export const ABORT_REASON = {
    STOPPED: 'STOPPED',
    TIMEOUT_ABORT: 'TIMEOUT_ABORT',
    RESET: 'RESET',
    FAILED: 'FAILED',
    GATE_CANCELLED: 'GATE_CANCELLED',
};

/**
 * 可被多个协程共享的暂停栅栏
 */
export function createPauseBarrier() {
    let paused = false;
    /** @type {Array<() => void>} */
    let waiters = [];

    return {
        isPaused: () => paused,
        pause() {
            paused = true;
        },
        resume() {
            paused = false;
            const pending = waiters;
            waiters = [];
            pending.forEach(resolve => resolve());
        },
        async waitIfPaused() {
            if (!paused) return;
            await new Promise(resolve => {
                waiters.push(resolve);
            });
        },
        forceRelease() {
            paused = false;
            const pending = waiters;
            waiters = [];
            pending.forEach(resolve => resolve());
        },
        waiterCount: () => waiters.length,
    };
}

/**
 * 可取消的异步互斥锁
 * - invalidate() 提升 epoch，排队中的 waiter 进入临界区后立即取消
 * - runExclusive 支持 expectedEpoch / isAlive 二次校验
 */
export function createAsyncMutex() {
    let chain = Promise.resolve();
    let epoch = 0;

    return {
        epoch: () => epoch,
        /** stop/reset 时调用：使所有已排队任务在获得锁后作废 */
        invalidate() {
            epoch += 1;
        },
        /**
         * @param {() => Promise<any>|any} fn
         * @param {{ expectedEpoch?: number, isAlive?: () => boolean }} [options]
         */
        async runExclusive(fn, options = {}) {
            const scheduledEpoch = options.expectedEpoch ?? epoch;
            const isAlive = typeof options.isAlive === 'function'
                ? options.isAlive
                : () => true;

            let release;
            const gate = new Promise(resolve => {
                release = resolve;
            });
            const previous = chain;
            chain = previous.then(() => gate, () => gate);
            await previous.catch(() => {});

            try {
                if (scheduledEpoch !== epoch) {
                    const err = new Error('GATE_CANCELLED');
                    err.code = ABORT_REASON.GATE_CANCELLED;
                    throw err;
                }
                if (!isAlive()) {
                    const err = new Error('GATE_CANCELLED');
                    err.code = ABORT_REASON.GATE_CANCELLED;
                    throw err;
                }
                return await fn();
            } finally {
                release();
            }
        },
    };
}

/**
 * 从 ready 任务中挑选本轮可并行集合
 */
export function selectParallelReadyTasks(tasks, completedPhases, options = {}) {
    const { busyAssignees = new Set() } = options;
    const selected = [];
    const claimedAssignees = new Set(busyAssignees);

    for (const task of tasks) {
        if (!task?.phase) continue;
        if (completedPhases.has(task.phase)) continue;
        const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
        if (!deps.every(dep => completedPhases.has(dep))) continue;
        if (claimedAssignees.has(task.assignee)) continue;

        selected.push(task);
        if (task.assignee) claimedAssignees.add(task.assignee);
    }

    return selected;
}

export function shouldMarkPhaseComplete(result) {
    return !!(result && result.success === true && !result.aborted);
}

export default {
    ABORT_REASON,
    createPauseBarrier,
    createAsyncMutex,
    selectParallelReadyTasks,
    shouldMarkPhaseComplete,
};
