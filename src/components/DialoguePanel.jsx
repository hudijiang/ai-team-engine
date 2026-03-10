import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useStore } from '../store/store';
import { STATE_COLORS } from '../engine/agentEngine';
import MarkdownRenderer from './MarkdownRenderer';

/**
 * 对话流面板
 * 实时展示所有 Agent 的结构化消息
 */
export default function DialoguePanel() {
    const messages = useStore(s => s.messages);
    const agents = useStore(s => s.agents);
    const currentObjective = useStore(s => s.currentObjective);
    const decomposition = useStore(s => s.decomposition);
    const [filter, setFilter] = useState('all');
    const [expandedJson, setExpandedJson] = useState(new Set());
    const [expandedDetails, setExpandedDetails] = useState(new Set());
    const [expandedSessions, setExpandedSessions] = useState(new Set());
    const sessionHistory = useStore(s => s.sessionHistory) || [];
    const dispatch = useStore(s => s.dispatch);
    const scrollRef = useRef(null);

    // 获取 Agent 颜色映射
    const agentColorMap = useMemo(() => {
        const map = { chairman: '#F59E0B' };
        agents.forEach(a => {
            map[a.id] = a.color || '#3B82F6';
        });
        return map;
    }, [agents]);

    // 获取所有角色列表（用于过滤）
    const roles = useMemo(() => {
        const set = new Set(messages.map(m => m.role));
        return ['all', ...Array.from(set)];
    }, [messages]);

    // 过滤消息
    const filteredMessages = useMemo(() => {
        if (filter === 'all') return messages;
        return messages.filter(m => m.role === filter);
    }, [messages, filter]);

    // 自动滚动到底部
    useEffect(() => {
        if (scrollRef.current) {
            const el = scrollRef.current;
            // 仅在接近底部时自动滚动
            const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
            if (isNearBottom) {
                requestAnimationFrame(() => {
                    el.scrollTop = el.scrollHeight;
                });
            }
        }
    }, [filteredMessages.length]);

    const toggleJson = (idx) => {
        setExpandedJson(prev => {
            const next = new Set(prev);
            if (next.has(idx)) {
                next.delete(idx);
            } else {
                next.add(idx);
            }
            return next;
        });
    };

    const toggleDetails = (idx) => {
        setExpandedDetails(prev => {
            const next = new Set(prev);
            if (next.has(idx)) {
                next.delete(idx);
            } else {
                next.add(idx);
            }
            return next;
        });
    };

    const formatTime = (ts) => {
        if (!ts) return '';
        const d = new Date(ts);
        return d.toLocaleTimeString('zh-CN', { hour12: false });
    };

    const handleExport = () => {
        const payload = {
            exported_at: new Date().toISOString(),
            objective: currentObjective,
            decomposition,
            agents,
            messages,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `agent-session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="dialogue-panel panel">
            <div className="panel__header">
                <span className="panel__title">📋 对话流</span>
                <span className="text-sm text-muted">{messages.length} 条消息 | {sessionHistory.length} 历史会话</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {sessionHistory.length > 0 && (
                        <button className="export-btn" onClick={() => dispatch({ type: 'CLEAR_HISTORY' })} style={{ color: 'var(--accent-red)' }}>🗑️ 清空历史</button>
                    )}
                    <button className="export-btn" onClick={handleExport}>⬇️ 导出记录</button>
                </div>
            </div>

            {/* 角色过滤 */}
            {roles.length > 1 && (
                <div className="filter-bar">
                    {roles.map(role => (
                        <button
                            key={role}
                            className={`filter-btn ${filter === role ? 'filter-btn--active' : ''}`}
                            onClick={() => setFilter(role)}
                        >
                            {role === 'all' ? '全部' : role}
                        </button>
                    ))}
                </div>
            )}

            <div className="panel__content" ref={scrollRef}>
                {/* 历史会话记录 */}
                {sessionHistory.length > 0 && sessionHistory.slice().reverse().map((session, sIdx) => {
                    const isOpen = expandedSessions.has(sIdx);
                    return (
                        <div key={session.sessionId || sIdx} className="session-history-card">
                            <div
                                className="session-history-card__header"
                                onClick={() => setExpandedSessions(prev => {
                                    const next = new Set(prev);
                                    next.has(sIdx) ? next.delete(sIdx) : next.add(sIdx);
                                    return next;
                                })}
                            >
                                <span className="session-history-card__icon">{isOpen ? '▼' : '▶'}</span>
                                <span className="session-history-card__objective">
                                    {session.objective || '未知目标'}
                                </span>
                                <span className="session-history-card__meta">
                                    {session.messages?.length || 0} 条 · {new Date(session.timestamp).toLocaleString('zh-CN')}
                                </span>
                                <button
                                    className="session-restore-btn"
                                    title="重新加载此会话"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (confirm(`确认加载会话「${session.objective || '未知目标'}」？\n当前会话将被自动归档。`)) {
                                            dispatch({ type: 'RESTORE_SESSION', payload: session.sessionId });
                                        }
                                    }}
                                >
                                    🔄
                                </button>
                            </div>
                            {isOpen && (
                                <div className="session-history-card__messages">
                                    {(session.messages || []).slice(0, 50).map((msg, mIdx) => (
                                        <div key={mIdx} className="session-history-card__msg">
                                            <span style={{ color: agentColorMap[msg.agentId] || '#3B82F6', fontWeight: 600 }}>
                                                [{msg.role}]
                                            </span>
                                            <span>{(msg.dialogue || []).join(' ').slice(0, 120)}</span>
                                        </div>
                                    ))}
                                    {(session.messages?.length || 0) > 50 && (
                                        <div className="text-sm text-muted" style={{ padding: '4px 0' }}>... 还有 {session.messages.length - 50} 条消息</div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}

                {/* 当前会话分隔线 */}
                {sessionHistory.length > 0 && filteredMessages.length > 0 && (
                    <div className="session-divider">
                        <span>📌 当前会话：{currentObjective || '进行中'}</span>
                    </div>
                )}

                {filteredMessages.length === 0 && sessionHistory.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state__icon">💬</div>
                        <div className="empty-state__title">暂无消息</div>
                        <div className="empty-state__text">
                            发布战略目标后，所有 Agent 的通信将在此实时展示
                        </div>
                    </div>
                ) : (
                    filteredMessages.map((msg, idx) => {
                        const msgKey = msg.clientId || `${msg.agentId}-${msg.timestamp}-${idx}`;
                        const msgColor = agentColorMap[msg.agentId] || '#3B82F6';
                        const stateColor = STATE_COLORS[msg.state] || msgColor;
                        const showJson = expandedJson.has(idx);
                        const showDetails = !expandedDetails.has(idx); // 默认展开，点击收起

                        // 判断是否为该 Agent 的当期活跃消息（即最后一条且全局状态为运行中）
                        const agentData = agents.find(a => a.id === msg.agentId) || {};
                        const isLatestForAgent = filteredMessages.findLastIndex(m => m.agentId === msg.agentId) === idx;
                        const isCurrentlyActive = ['planning', 'executing', 'reviewing', 'tool_use'].includes(agentData.state) && isLatestForAgent;

                        // 构建符合要求的结构化 JSON
                        const structuredJson = {
                            role: msg.role,
                            state: msg.state,
                            current_task: msg.current_task,
                            progress: msg.progress,
                            collaborators: msg.collaborators,
                            dialogue: msg.dialogue,
                            next_step: msg.next_step,
                        };

                        return (
                            <div
                                key={msgKey}
                                className="message-bubble"
                                style={{ '--msg-color': msgColor }}
                            >
                                <div className="message-bubble__header">
                                    <span className="message-bubble__role">
                                        {msg.role}
                                        {isCurrentlyActive && (
                                            <span
                                                className="pulse-indicator"
                                                style={{ backgroundColor: stateColor }}
                                                title="正在执行..."
                                            />
                                        )}
                                    </span>
                                    <div className="message-bubble__meta">
                                        <span className={`message-bubble__state ${isCurrentlyActive ? 'state-active' : ''}`} style={{ color: stateColor }}>
                                            {msg.state}
                                        </span>
                                        <span className="message-bubble__time">
                                            {formatTime(msg.timestamp)}
                                        </span>
                                        <div style={{ display: 'flex', gap: '6px' }}>
                                            <button
                                                className="message-bubble__json-toggle"
                                                onClick={() => toggleJson(idx)}
                                            >
                                                {showJson ? '隐藏JSON' : 'JSON'}
                                            </button>
                                            <button
                                                className="message-bubble__json-toggle"
                                                onClick={() => toggleDetails(idx)}
                                            >
                                                {showDetails ? '收起详情' : '展开详情'}
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* 对话内容 */}
                                <div className="message-bubble__dialogue">
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: msg.dialogue?.length ? 4 : 0 }}>
                                        {msg.source === 'llm' && <span className="badge badge-llm">LLM</span>}
                                        {msg.source === 'llm-stream' && <span className="badge badge-llm">流</span>}
                                        {msg.source === 'template' && <span className="badge badge-fallback">模板</span>}
                                        {msg.source === 'error' && <span className="badge badge-error">错误</span>}
                                    </div>
                                    {msg.dialogue && (
                                        <MarkdownRenderer text={msg.dialogue.join('\n')} />
                                    )}
                                    {/* 多模态：图片渲染 */}
                                    {msg.imageUrl && (
                                        <div style={{ marginTop: '8px' }}>
                                            <img
                                                src={msg.imageUrl}
                                                alt="Agent 产出图片"
                                                style={{
                                                    maxWidth: '100%', borderRadius: '8px',
                                                    border: '1px solid var(--border-primary)',
                                                }}
                                            />
                                        </div>
                                    )}
                                </div>

                                {/* 结构化 JSON 展示 */}
                                {showJson && (
                                    <div className="message-bubble__json">
                                        {JSON.stringify(structuredJson, null, 2)}
                                    </div>
                                )}

                                {/* 详情展示：完整任务/协作内容 */}
                                {showDetails && (
                                    <div className="message-bubble__json">
                                        <div style={{ fontWeight: 600, marginBottom: 4 }}>详情</div>
                                        <div style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
                                            <div>任务: {msg.current_task || '—'}</div>
                                            <div>协作: {(msg.collaborators || []).join(', ') || '—'}</div>
                                            <div>进度: {((msg.progress || 0) * 100).toFixed(0)}%</div>
                                        </div>

                                        {/* 实质产出内容 */}
                                        {msg.outputContent && (
                                            <div className="output-expand" style={{ marginTop: 8 }}>
                                                <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--accent-green)' }}>
                                                    📄 工作成果
                                                </div>
                                                <pre className="output-expand__content">{msg.outputContent}</pre>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* 下一步计划 */}
                                {msg.next_step && msg.next_step.length > 0 && (
                                    <div className="message-bubble__next-steps">
                                        <div className="message-bubble__next-steps-label">⏭ 下一步</div>
                                        <ul className="message-bubble__next-steps-list">
                                            {msg.next_step.map((step, i) => (
                                                <li key={i} className="message-bubble__next-step-item">{step}</li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
