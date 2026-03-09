import React, { useState, useMemo } from 'react';
import { useStore } from '../store/store';

/**
 * Prompt 可视化调试面板
 * 展示每次 LLM 调用的完整 prompt、响应、耗时和 token 信息
 */
export default function PromptInspector() {
    const promptLogs = useStore(s => s.promptLogs) || [];
    const [expandedId, setExpandedId] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [filterAgent, setFilterAgent] = useState('all');

    // 获取所有 Agent 名称
    const agentNames = useMemo(() => {
        const names = new Set(promptLogs.map(l => l.agentName).filter(Boolean));
        return ['all', ...Array.from(names)];
    }, [promptLogs]);

    // 过滤
    const filtered = useMemo(() => {
        let logs = promptLogs.slice().reverse();
        if (filterAgent !== 'all') {
            logs = logs.filter(l => l.agentName === filterAgent);
        }
        if (searchTerm) {
            const lower = searchTerm.toLowerCase();
            logs = logs.filter(l =>
                (l.model || '').toLowerCase().includes(lower) ||
                (l.inputText || '').toLowerCase().includes(lower) ||
                (l.outputText || '').toLowerCase().includes(lower)
            );
        }
        return logs;
    }, [promptLogs, filterAgent, searchTerm]);

    const formatDuration = (ms) => {
        if (!ms) return '-';
        return ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
    };

    if (promptLogs.length === 0) {
        return (
            <div className="panel__content">
                <div className="empty-state">
                    <div className="empty-state__icon">🔍</div>
                    <div className="empty-state__title">暂无 LLM 调用记录</div>
                    <div className="empty-state__text">发布目标并执行任务后，所有 LLM 调用将在此展示</div>
                </div>
            </div>
        );
    }

    return (
        <div className="panel__content" style={{ padding: '8px' }}>
            {/* 搜索和过滤 */}
            <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
                <input
                    type="text"
                    placeholder="搜索 prompt / 响应..."
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    style={{
                        flex: 1, minWidth: '120px', padding: '6px 10px',
                        background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)',
                        borderRadius: '6px', color: 'var(--text-primary)', fontSize: '0.8rem',
                    }}
                />
                <select
                    value={filterAgent}
                    onChange={e => setFilterAgent(e.target.value)}
                    style={{
                        padding: '6px 8px', background: 'var(--bg-tertiary)',
                        border: '1px solid var(--border-primary)', borderRadius: '6px',
                        color: 'var(--text-primary)', fontSize: '0.8rem',
                    }}
                >
                    {agentNames.map(n => (
                        <option key={n} value={n}>{n === 'all' ? '全部 Agent' : n}</option>
                    ))}
                </select>
            </div>

            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
                共 {promptLogs.length} 次调用 · 显示 {filtered.length} 条
            </div>

            {/* 日志列表 */}
            {filtered.map((log, idx) => {
                const isOpen = expandedId === idx;
                return (
                    <div key={idx} style={{
                        background: 'var(--bg-secondary)', borderRadius: '8px',
                        marginBottom: '6px', border: '1px solid var(--border-primary)',
                        overflow: 'hidden',
                    }}>
                        <div
                            onClick={() => setExpandedId(isOpen ? null : idx)}
                            style={{
                                padding: '8px 12px', cursor: 'pointer', display: 'flex',
                                justifyContent: 'space-between', alignItems: 'center',
                                fontSize: '0.8rem',
                            }}
                        >
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flex: 1, minWidth: 0 }}>
                                <span style={{
                                    background: 'var(--accent-blue)', color: 'white', padding: '1px 6px',
                                    borderRadius: '4px', fontSize: '0.7rem', flexShrink: 0,
                                }}>{log.agentName || 'CEO'}</span>
                                <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{log.model}</span>
                                <span style={{
                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    color: 'var(--text-secondary)',
                                }}>
                                    {(log.outputText || '').slice(0, 60)}...
                                </span>
                            </div>
                            <div style={{ display: 'flex', gap: '8px', flexShrink: 0, marginLeft: '8px' }}>
                                <span style={{ color: 'var(--text-muted)' }}>{formatDuration(log.durationMs)}</span>
                                <span style={{ color: 'var(--accent-green)' }}>{log.totalTokens || '?'} tk</span>
                                <span>{isOpen ? '▼' : '▶'}</span>
                            </div>
                        </div>

                        {isOpen && (
                            <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border-primary)' }}>
                                <div style={{ marginBottom: '8px' }}>
                                    <div style={{ fontWeight: 600, fontSize: '0.75rem', marginBottom: '4px', color: 'var(--accent-blue)' }}>
                                        📤 Prompt（输入）
                                    </div>
                                    <pre style={{
                                        background: 'var(--bg-tertiary)', padding: '8px', borderRadius: '6px',
                                        fontSize: '0.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                                        maxHeight: '200px', overflow: 'auto', lineHeight: 1.5,
                                    }}>{log.inputText || '(无)'}</pre>
                                </div>
                                <div>
                                    <div style={{ fontWeight: 600, fontSize: '0.75rem', marginBottom: '4px', color: 'var(--accent-green)' }}>
                                        📥 Response（输出）
                                    </div>
                                    <pre style={{
                                        background: 'var(--bg-tertiary)', padding: '8px', borderRadius: '6px',
                                        fontSize: '0.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                                        maxHeight: '300px', overflow: 'auto', lineHeight: 1.5,
                                    }}>{log.outputText || '(无)'}</pre>
                                </div>
                                <div style={{
                                    display: 'flex', gap: '12px', marginTop: '8px',
                                    fontSize: '0.7rem', color: 'var(--text-muted)',
                                }}>
                                    <span>输入: {log.inputTokens || '?'} tk</span>
                                    <span>输出: {log.outputTokens || '?'} tk</span>
                                    <span>耗时: {formatDuration(log.durationMs)}</span>
                                    <span>费用: ${log.costUSD?.toFixed(5) || '?'}</span>
                                    <span>{log.timestamp ? new Date(log.timestamp).toLocaleTimeString('zh-CN') : ''}</span>
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
