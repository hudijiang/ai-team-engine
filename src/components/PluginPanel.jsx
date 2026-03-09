import React, { useState, useMemo } from 'react';
import { loadPlugins, togglePlugin } from '../engine/pluginSystem';
import performanceTracker from '../engine/performanceTracker';

/**
 * 插件与性能综合管理面板
 * 包含：插件启用/禁用 + Agent 性能评估排名
 */
export default function PluginPanel() {
    const [refreshKey, setRefreshKey] = useState(0);
    const [tab, setTab] = useState('plugins'); // 'plugins' | 'performance'

    const plugins = useMemo(() => loadPlugins(), [refreshKey]);
    const perfSummary = useMemo(() => performanceTracker.getSummary(), [refreshKey]);

    const handleToggle = (pluginId, enabled) => {
        togglePlugin(pluginId, enabled);
        setRefreshKey(k => k + 1);
    };

    const tabStyle = (active) => ({
        padding: '6px 14px', border: 'none', borderRadius: '6px',
        background: active ? 'var(--accent-blue)' : 'transparent',
        color: active ? 'white' : 'var(--text-muted)',
        cursor: 'pointer', fontSize: '0.8rem', fontWeight: active ? 600 : 400,
    });

    return (
        <div className="panel__content" style={{ padding: '10px' }}>
            {/* Tab 切换 */}
            <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
                <button style={tabStyle(tab === 'plugins')} onClick={() => setTab('plugins')}>🧩 插件</button>
                <button style={tabStyle(tab === 'performance')} onClick={() => setTab('performance')}>📈 性能</button>
            </div>

            {tab === 'plugins' && (
                <>
                    {plugins.map(plugin => (
                        <div key={plugin.id} style={{
                            padding: '10px 12px', background: 'var(--bg-secondary)',
                            borderRadius: '8px', marginBottom: '6px',
                            border: `1px solid ${plugin.enabled ? 'var(--accent-green)' : 'var(--border-primary)'}`,
                            opacity: plugin.enabled ? 1 : 0.7,
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                    <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{plugin.name}</div>
                                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>v{plugin.version}</div>
                                </div>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                                    <span style={{ fontSize: '0.75rem', color: plugin.enabled ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                                        {plugin.enabled ? '已启用' : '已禁用'}
                                    </span>
                                    <input
                                        type="checkbox" checked={plugin.enabled}
                                        onChange={e => handleToggle(plugin.id, e.target.checked)}
                                        style={{ cursor: 'pointer' }}
                                    />
                                </label>
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                                {plugin.description}
                            </div>
                            {plugin.roles?.length > 0 && (
                                <div style={{ display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' }}>
                                    {plugin.roles.map(r => (
                                        <span key={r.name} style={{
                                            padding: '2px 8px', borderRadius: '10px', fontSize: '0.7rem',
                                            background: `${r.color}20`, color: r.color, border: `1px solid ${r.color}40`,
                                        }}>{r.name}</span>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}
                </>
            )}

            {tab === 'performance' && (
                <>
                    {perfSummary.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-state__icon">📈</div>
                            <div className="empty-state__title">暂无性能数据</div>
                            <div className="empty-state__text">执行任务后将自动记录 Agent 性能指标</div>
                        </div>
                    ) : (
                        perfSummary.map((agent, idx) => (
                            <div key={agent.agentName} style={{
                                padding: '10px 12px', background: 'var(--bg-secondary)',
                                borderRadius: '8px', marginBottom: '6px',
                                border: '1px solid var(--border-primary)',
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <span style={{
                                            width: 24, height: 24, borderRadius: '50%',
                                            background: idx === 0 ? 'var(--accent-green)' : 'var(--bg-tertiary)',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            fontSize: '0.7rem', fontWeight: 700,
                                            color: idx === 0 ? 'white' : 'var(--text-muted)',
                                        }}>#{idx + 1}</span>
                                        <span style={{ fontWeight: 600 }}>{agent.agentName}</span>
                                    </div>
                                    <span style={{
                                        fontSize: '1.1rem', fontWeight: 700,
                                        color: agent.score >= 80 ? 'var(--accent-green)'
                                            : agent.score >= 50 ? 'var(--accent-amber)'
                                                : 'var(--accent-red)',
                                    }}>{agent.score}</span>
                                </div>
                                <div style={{
                                    display: 'flex', gap: '12px', marginTop: '6px',
                                    fontSize: '0.75rem', color: 'var(--text-muted)',
                                }}>
                                    <span>🎯 通过率 {agent.passRate}%</span>
                                    <span>⏱ 均时 {(agent.avgDurationMs / 1000).toFixed(1)}s</span>
                                    <span>📊 {agent.taskCount} 次</span>
                                </div>
                            </div>
                        ))
                    )}
                    {perfSummary.length > 0 && (
                        <button onClick={() => { performanceTracker.clear(); setRefreshKey(k => k + 1); }} style={{
                            width: '100%', marginTop: '8px', padding: '8px', borderRadius: '6px',
                            background: 'transparent', border: '1px solid var(--border-primary)',
                            color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem',
                        }}>🗑️ 清空数据</button>
                    )}
                </>
            )}
        </div>
    );
}
