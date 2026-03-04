import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from '../store/store';
import { CEOAgentRunner } from '../engine/ceoAgent';
import DecisionPanel from './DecisionPanel';

/**
 * 董事长指令输入组件
 * 提供战略目标输入、一键发布、模型配置后确认执行
 */
export default function CommandInput() {
    const [input, setInput] = useState('');
    const runnerRef = useRef(null);
    const dispatch = useStore(s => s.dispatch);
    const getSnapshot = useStore(s => s.getSnapshot);
    const reset = useStore(s => s.reset);
    const systemStatus = useStore(s => s.systemStatus);

    // 组件卸载时清理 runner
    useEffect(() => {
        return () => {
            if (runnerRef.current) {
                runnerRef.current.stop();
                runnerRef.current = null;
            }
        };
    }, []);

    const isRunning = systemStatus === 'running';
    const isCompleted = systemStatus === 'completed';
    const isWaitingConfig = systemStatus === 'waiting_for_config';
    const isWaitingHuman = systemStatus === 'waiting_for_human';
    const isBlocked = systemStatus === 'blocked';
    const isWaitingDecision = systemStatus === 'waiting_for_decision';

    const [humanInput, setHumanInput] = useState('');

    const handleSubmit = useCallback(() => {
        const objective = input.trim();
        // 只在正在运行或等待配置/人工时禁用
        if (!objective || isRunning || isWaitingConfig || isWaitingHuman) return;

        // 如果当前已完成或有残留状态，先归档当前会话再开新会话
        if (isCompleted || isBlocked) {
            dispatch({ type: 'RESET' });
            // 清理旧 runner
            if (runnerRef.current) {
                runnerRef.current.stop();
                runnerRef.current = null;
            }
        }

        // 设置目标
        dispatch({ type: 'SET_OBJECTIVE', payload: objective });
        dispatch({
            type: 'ADD_MESSAGE',
            payload: {
                role: '董事长',
                state: 'idle',
                current_task: '发布战略目标',
                progress: 1.0,
                collaborators: ['CEO'],
                dialogue: [`📢 战略目标发布：「${objective}」`, '请CEO分析并组织执行。'],
                next_step: [],
                agentId: 'chairman',
                timestamp: new Date().toISOString(),
            },
        });

        // 启动新的 CEO Agent
        const runner = new CEOAgentRunner(dispatch, getSnapshot);
        runnerRef.current = runner;
        runner.start(objective);

        setInput('');
    }, [input, isRunning, isCompleted, isBlocked, isWaitingConfig, isWaitingHuman, dispatch, getSnapshot]);

    /**
     * 董事长确认模型配置，恢复 CEO 执行
     */
    const handleStartExecution = useCallback(() => {
        if (runnerRef.current) {
            runnerRef.current.resume();
        }
    }, []);

    /**
     * 董事长提供人工输入
     */
    const handleHumanSubmit = useCallback(() => {
        if (!humanInput.trim() || !runnerRef.current) return;
        runnerRef.current.provideHumanInput(humanInput.trim());
        setHumanInput('');
    }, [humanInput]);

    const handleReset = useCallback(() => {
        if (runnerRef.current) {
            runnerRef.current.stop();
            runnerRef.current = null;
        }
        reset();
        setInput('');
        setHumanInput('');
    }, [reset]);

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
                            onClick={() => runnerRef.current?.skipHumanInput?.('FORCE_CONTINUE')}
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

            {/* 等待董事长决策状态 */}
            {isWaitingDecision && (
                <DecisionPanel
                    onResolve={(idx, customText) => {
                        if (runnerRef.current) {
                            runnerRef.current.resolveDecision(idx, customText);
                        }
                    }}
                />
            )}

            {/* 正常输入状态 */}
            {!isWaitingConfig && !isWaitingHuman && !isWaitingDecision && (
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
                            <button
                                className="command-input__reset"
                                onClick={handleReset}
                                id="reset-btn-2"
                            >
                                重置
                            </button>
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
