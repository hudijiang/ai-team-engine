import React, { useMemo } from 'react';
import { useStore } from '../store/store';
import { STATE_LABELS, STATE_COLORS, AGENT_STATES } from '../engine/agentEngine';

/**
 * 进度监控仪表盘
 * 展示整体完成度、各 Agent 进度和状态统计
 */
export default function ProgressDashboard() {
    const agents = useStore(s => s.agents);
    const currentObjective = useStore(s => s.currentObjective);
    const systemStatus = useStore(s => s.systemStatus);
    const messages = useStore(s => s.messages);

    // 计算整体进度
    const overallProgress = useMemo(() => {
        if (agents.length === 0) return 0;
        const total = agents.reduce((sum, a) => sum + (a.progress || 0), 0);
        return total / agents.length;
    }, [agents]);

    // 状态统计
    const stateStats = useMemo(() => {
        const stats = {};
        Object.values(AGENT_STATES).forEach(s => { stats[s] = 0; });
        agents.forEach(a => {
            stats[a.state] = (stats[a.state] || 0) + 1;
        });
        return stats;
    }, [agents]);

    // SVG 圆环参数
    const radius = 50;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - overallProgress);

    // 健康概览
    const errorCount = useMemo(() => messages.filter(m => m.source === 'error').length, [messages]);
    const waitingAgents = useMemo(() => agents.filter(a => a.state === 'waiting'), [agents]);
    const waitingCount = waitingAgents.length;

    return (
        <div className="progress-dashboard">
            {/* 整体进度环 */}
            <div className="progress-dashboard__overall">
                <div className="progress-ring">
                    <svg className="progress-ring__svg" width="120" height="120" viewBox="0 0 120 120">
                        <defs>
                            <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stopColor="#3B82F6" />
                                <stop offset="100%" stopColor="#8B5CF6" />
                            </linearGradient>
                        </defs>
                        <circle
                            className="progress-ring__circle-bg"
                            cx="60" cy="60" r={radius}
                        />
                        <circle
                            className="progress-ring__circle-fill"
                            cx="60" cy="60" r={radius}
                            strokeDasharray={circumference}
                            strokeDashoffset={offset}
                        />
                    </svg>
                    <div className="progress-ring__text">
                        <span className="progress-ring__percentage">
                            {(overallProgress * 100).toFixed(0)}%
                        </span>
                        <span className="progress-ring__label">整体进度</span>
                    </div>
                </div>

                {currentObjective && (
                    <>
                        <div className="progress-dashboard__title">当前目标</div>
                        <div className="progress-dashboard__objective">{currentObjective}</div>
                    </>
                )}
            </div>

            {/* Agent 进度列表 */}
            <div className="agent-progress-list">
                {agents.map(agent => {
                    const stateColor = STATE_COLORS[agent.state] || STATE_COLORS.idle;
                    return (
                        <div key={agent.id} className="agent-progress-item">
                            <div className="agent-progress-item__header">
                                <span className="agent-progress-item__name">
                                    <span
                                        className="agent-progress-item__dot"
                                        style={{ background: stateColor }}
                                    />
                                    {agent.name}
                                </span>
                                <span className="agent-progress-item__percentage">
                                    {((agent.progress || 0) * 100).toFixed(0)}%
                                </span>
                            </div>
                            <div className="progress-bar">
                                <div
                                    className={`progress-bar__fill ${['planning', 'executing'].includes(agent.state) ? 'progress-bar__fill--animated' : ''}`}
                                    style={{
                                        width: `${(agent.progress || 0) * 100}%`,
                                        background: agent.color || stateColor,
                                    }}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* 状态统计 */}
            <div className="state-stats">
                {Object.entries(stateStats)
                    .filter(([_, count]) => count > 0)
                    .map(([state, count]) => (
                        <div key={state} className="state-stat">
                            <span
                                className="state-stat__dot"
                                style={{ background: STATE_COLORS[state] }}
                            />
                            <div className="state-stat__info">
                                <div className="state-stat__label">
                                    {STATE_LABELS[state]}
                                </div>
                                <div className="state-stat__count">{count}</div>
                            </div>
                        </div>
                    ))}
                <div className="state-stat">
                    <span className="state-stat__dot" style={{ background: errorCount > 0 ? 'var(--accent-red)' : 'var(--text-muted)' }} />
                    <div className="state-stat__info">
                        <div className="state-stat__label">错误/重试</div>
                        <div className="state-stat__count">{errorCount}</div>
                    </div>
                </div>
                <div className="state-stat">
                    <span className="state-stat__dot" style={{ background: waitingCount > 0 ? 'var(--accent-amber)' : 'var(--text-muted)' }} />
                    <div className="state-stat__info">
                        <div className="state-stat__label">等待中</div>
                        <div className="state-stat__count">{waitingCount}</div>
                    </div>
                </div>
            </div>

            {waitingCount > 0 && (
                <div className="waiting-list">
                    <div className="waiting-list__title">等待中的阶段</div>
                    {waitingAgents.map(a => (
                        <div key={a.id} className="waiting-list__item">
                            <span className="waiting-list__name">{a.name}</span>
                            <span className="waiting-list__task">{a.currentTask}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
