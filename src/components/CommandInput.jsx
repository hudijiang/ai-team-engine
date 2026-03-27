import React, { useState, useCallback, useEffect } from 'react';
import { useStore } from '../store/store';
import { clearRunner, getRunner, peekRunner, replaceRunner } from '../engine/runnerRuntime';
import DecisionPanel from './DecisionPanel';
import {
    resolveDecisionAction,
    skipHumanInputAction,
    startExecutionFromCheckpoint,
    submitHumanInputAction,
} from './commandInputActions.js';
import { restoreConfigCheckpoint, submitObjectiveCommand } from './commandInputLogic.js';

/**
 * 董事长指令输入组件
 * 提供战略目标输入、一键发布、模型配置后确认执行
 */
export default function CommandInput() {
    const [input, setInput] = useState('');
    const dispatch = useStore(s => s.dispatch);
    const getSnapshot = useStore(s => s.getSnapshot);
    const reset = useStore(s => s.reset);
    const systemStatus = useStore(s => s.systemStatus);
    const workflowCheckpoint = useStore(s => s.workflowCheckpoint);

    const isRunning = systemStatus === 'running';
    const isCompleted = systemStatus === 'completed';
    const isWaitingConfig = systemStatus === 'waiting_for_config';
    const isWaitingHuman = systemStatus === 'waiting_for_human';
    const isBlocked = systemStatus === 'blocked';
    const isWaitingDecision = systemStatus === 'waiting_for_decision';
    const isPaused = systemStatus === 'paused';

    const [humanInput, setHumanInput] = useState('');

    useEffect(() => {
        restoreConfigCheckpoint({
            systemStatus,
            workflowCheckpoint,
            dispatch,
            getSnapshot,
            getRunnerImpl: getRunner,
        });
    }, [systemStatus, workflowCheckpoint, dispatch, getSnapshot]);

    const handleSubmit = useCallback(() => {
        const result = submitObjectiveCommand({
            objective: input,
            systemStatus,
            dispatch,
            getSnapshot,
            clearRunnerImpl: clearRunner,
            replaceRunnerImpl: replaceRunner,
        });

        if (result.status === 'started') {
            setInput('');
        }
    }, [input, systemStatus, dispatch, getSnapshot]);

    /**
     * 董事长确认模型配置，恢复 CEO 执行
     */
    const handleStartExecution = useCallback(() => {
        startExecutionFromCheckpoint({
            workflowCheckpoint,
            dispatch,
            getSnapshot,
            getRunnerImpl: getRunner,
        });
    }, [dispatch, getSnapshot, workflowCheckpoint]);

    /**
     * 董事长提供人工输入
     */
    const handleHumanSubmit = useCallback(() => {
        const result = submitHumanInputAction({
            humanInput,
            dispatch,
            getSnapshot,
            getRunnerImpl: getRunner,
        });
        if (result.status === 'submitted') {
            setHumanInput('');
        }
    }, [humanInput, dispatch, getSnapshot]);

    const handleHumanSkip = useCallback(() => {
        skipHumanInputAction({
            reason: 'FORCE_CONTINUE',
            dispatch,
            getSnapshot,
            getRunnerImpl: getRunner,
        });
    }, [dispatch, getSnapshot]);

    const handleReset = useCallback(() => {
        clearRunner();
        reset();
        setInput('');
        setHumanInput('');
    }, [reset]);

    /** 暂停执行 */
    const handlePause = useCallback(() => {
        peekRunner()?.pause();
    }, []);

    /** 恢复执行 */
    const handleUnpause = useCallback(() => {
        peekRunner()?.unpause();
    }, []);

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    // 预设示例目标
    const examples = [
        '开发一个电商小程序',
        '制定品牌推广方案',
        '如何通过互联网赚钱',
        '调研AI行业发展趋势',
    ];

    return (
        <div className="command-input">
            <div className="command-input__label">
                👑 董事长指令
            </div>

            {/* 等待人工协助状态 */}
            {isWaitingHuman && (
                <div className="command-input__config-notice">
                    <div className="command-input__config-text" style={{ color: 'var(--accent-amber)' }}>
                        🚨 团队在执行(如登录、验证码等)时遇到障碍，请求董事长协助。
                    </div>
                    <div className="command-input__wrapper" style={{ marginTop: '8px', paddingBottom: '4px' }}>
                        <input
                            className="command-input__field"
                            type="text"
                            value={humanInput}
                            onChange={e => setHumanInput(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') handleHumanSubmit();
                            }}
                            placeholder="输入验证结果/协助内容..."
                            id="human-input-field"
                        />
                        <button
                            className="command-input__start-btn"
                            onClick={handleHumanSubmit}
                            disabled={!humanInput.trim()}
                        >
                            提交
                        </button>
                        <button
                            className="command-input__reset"
                            onClick={handleHumanSkip}
                            style={{ marginLeft: 8 }}
                        >
                            跳过此步
                        </button>
                    </div>
                </div>
            )}

            {/* 等待配置状态 — 显示"开始执行"按钮 */}
            {isWaitingConfig && (
                <div className="command-input__config-notice">
                    <div className="command-input__config-text">
                        ⏸️ 团队已组建，请为每位成员选择 AI 模型：
                    </div>
                    <div className="command-input__config-actions">
                        <button
                            className="command-input__start-btn"
                            onClick={handleStartExecution}
                            id="start-execution-btn"
                        >
                            🚀 开始执行
                        </button>
                        <button
                            className="command-input__reset"
                            onClick={handleReset}
                            id="reset-btn"
                        >
                            重置
                        </button>
                    </div>
                </div>
            )}

            {/* 阻塞状态提示 */}
            {isBlocked && (
                <div className="command-input__config-notice" style={{ borderColor: 'rgba(239,68,68,0.4)' }}>
                    <div className="command-input__config-text" style={{ color: 'var(--accent-red)' }}>
                        ⚠️ 调度检测到依赖无法满足，流程已暂停。请检查任务拆解，或点击下方重置后重新发布目标。
                    </div>
                    <div className="command-input__config-actions">
                        <button
                            className="command-input__reset"
                            onClick={handleReset}
                            id="reset-btn-blocked"
                        >
                            重置
                        </button>
                    </div>
                </div>
            )}

            {/* 暂停状态提示 */}
            {isPaused && (
                <div className="command-input__config-notice" style={{ borderColor: 'rgba(139,92,246,0.4)' }}>
                    <div className="command-input__config-text" style={{ color: 'var(--accent-purple)' }}>
                        ⏸️ 执行已暂停。您可以调整团队配置，然后恢复执行。
                    </div>
                    <div className="command-input__config-actions">
                        <button
                            className="command-input__start-btn"
                            onClick={handleUnpause}
                        >
                            ▶️ 恢复执行
                        </button>
                        <button
                            className="command-input__reset"
                            onClick={handleReset}
                        >
                            重置
                        </button>
                    </div>
                </div>
            )}

            {/* 等待董事长决策状态 */}
            {isWaitingDecision && (
                <DecisionPanel
                    onResolve={(idx, customText) => {
                        resolveDecisionAction({
                            proposalIndex: idx,
                            customText,
                            dispatch,
                            getSnapshot,
                            getRunnerImpl: getRunner,
                        });
                    }}
                />
            )}

            {/* 正常输入状态 */}
            {!isWaitingConfig && !isWaitingHuman && !isWaitingDecision && !isPaused && (
                <>
                    <div className="command-input__wrapper">
                        <input
                            className="command-input__field"
                            type="text"
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="输入战略目标... (例如: 开发一个电商小程序)"
                            disabled={isRunning}
                            id="strategic-objective-input"
                        />
                        <button
                            className="command-input__btn"
                            onClick={handleSubmit}
                            disabled={isRunning || !input.trim()}
                            id="submit-objective-btn"
                        >
                            {isRunning ? '执行中...' : '发布'}
                        </button>
                        {(isRunning || isCompleted) && (
                            <>
                                {isRunning && (
                                    <button
                                        className="command-input__reset"
                                        onClick={handlePause}
                                        style={{ background: 'rgba(139,92,246,0.15)', borderColor: 'rgba(139,92,246,0.3)', color: 'var(--accent-purple)' }}
                                    >
                                        ⏸️ 暂停
                                    </button>
                                )}
                                <button
                                    className="command-input__reset"
                                    onClick={handleReset}
                                    id="reset-btn-2"
                                >
                                    重置
                                </button>
                            </>
                        )}
                    </div>
                    {!isRunning && !isCompleted && (
                        <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
                            {examples.map(ex => (
                                <button
                                    key={ex}
                                    className="filter-btn"
                                    onClick={() => setInput(ex)}
                                    style={{ fontSize: '0.7rem' }}
                                >
                                    {ex}
                                </button>
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
