import React, { useMemo } from 'react';
import tokenTracker from '../engine/tokenTracker';

/**
 * 成本与 Token 监控仪表盘
 */
export default function CostDashboard() {
    const summary = useMemo(() => tokenTracker.getSummary(), [tokenTracker.getRecords().length]);
    const records = tokenTracker.getRecords();

    if (records.length === 0) {
        return (
            <div className="panel__content">
                <div className="empty-state">
                    <div className="empty-state__icon">💰</div>
                    <div className="empty-state__title">暂无消耗记录</div>
                    <div className="empty-state__text">执行任务后将自动追踪 Token 消耗和费用</div>
                </div>
            </div>
        );
    }

    const cardStyle = {
        background: 'var(--bg-secondary)', borderRadius: '10px',
        padding: '12px 16px', border: '1px solid var(--border-primary)',
    };
    const labelStyle = { fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '2px' };
    const valueStyle = { fontSize: '1.3rem', fontWeight: 700 };

    // 排序：按 tokens 降序
    const agentEntries = Object.entries(summary.byAgent).sort((a, b) => b[1].tokens - a[1].tokens);
    const modelEntries = Object.entries(summary.byModel).sort((a, b) => b[1].tokens - a[1].tokens);
    const maxAgentTokens = agentEntries.length > 0 ? agentEntries[0][1].tokens : 1;
    const maxModelTokens = modelEntries.length > 0 ? modelEntries[0][1].tokens : 1;

    return (
        <div className="panel__content" style={{ padding: '10px' }}>
            {/* 汇总卡片 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '16px' }}>
                <div style={cardStyle}>
                    <div style={labelStyle}>总 Token</div>
                    <div style={{ ...valueStyle, color: 'var(--accent-blue)' }}>
                        {summary.totalTokens.toLocaleString()}
                    </div>
                </div>
                <div style={cardStyle}>
                    <div style={labelStyle}>预估费用</div>
                    <div style={{ ...valueStyle, color: 'var(--accent-green)' }}>
                        ${summary.totalCost.toFixed(4)}
                    </div>
                </div>
                <div style={cardStyle}>
                    <div style={labelStyle}>调用次数</div>
                    <div style={{ ...valueStyle, color: 'var(--accent-purple)' }}>
                        {summary.totalCalls}
                    </div>
                </div>
            </div>

            {/* 按 Agent 分布 */}
            <div style={{ marginBottom: '16px' }}>
                <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '8px' }}>👤 按 Agent 分布</div>
                {agentEntries.map(([name, data]) => (
                    <div key={name} style={{ marginBottom: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                            <span>{name}</span>
                            <span style={{ color: 'var(--text-muted)' }}>
                                {data.tokens.toLocaleString()} tk · ${data.cost.toFixed(4)} · {data.calls} 次
                            </span>
                        </div>
                        <div className="progress-bar">
                            <div className="progress-bar__fill" style={{
                                width: `${(data.tokens / maxAgentTokens) * 100}%`,
                                background: 'var(--accent-blue)',
                            }} />
                        </div>
                    </div>
                ))}
            </div>

            {/* 按 Model 分布 */}
            <div style={{ marginBottom: '16px' }}>
                <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: '8px' }}>🤖 按模型分布</div>
                {modelEntries.map(([model, data]) => (
                    <div key={model} style={{ marginBottom: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' }}>{model}</span>
                            <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                                {data.tokens.toLocaleString()} tk · ${data.cost.toFixed(4)}
                            </span>
                        </div>
                        <div className="progress-bar">
                            <div className="progress-bar__fill" style={{
                                width: `${(data.tokens / maxModelTokens) * 100}%`,
                                background: 'var(--accent-purple)',
                            }} />
                        </div>
                    </div>
                ))}
            </div>

            {/* 清空按钮 */}
            <button
                onClick={() => { tokenTracker.clear(); window.location.reload(); }}
                style={{
                    width: '100%', padding: '8px', borderRadius: '6px',
                    background: 'transparent', border: '1px solid var(--border-primary)',
                    color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem',
                }}
            >
                🗑️ 清空记录
            </button>
        </div>
    );
}
