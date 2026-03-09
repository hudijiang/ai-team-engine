import React from 'react';
import useTimelineStore from '../store/timelineStore';

/**
 * 任务执行回放 - 时间线播放器
 */
export default function TimelinePlayer() {
    const events = useTimelineStore(s => s.events);
    const playbackIndex = useTimelineStore(s => s.playbackIndex);
    const isPlaying = useTimelineStore(s => s.isPlaying);
    const setPlaybackIndex = useTimelineStore(s => s.setPlaybackIndex);
    const startPlayback = useTimelineStore(s => s.startPlayback);
    const pausePlayback = useTimelineStore(s => s.pausePlayback);
    const clearEvents = useTimelineStore(s => s.clearEvents);

    // 自动播放
    React.useEffect(() => {
        if (!isPlaying || events.length === 0) return;
        const timer = setInterval(() => {
            useTimelineStore.setState(state => {
                const next = state.playbackIndex + 1;
                if (next >= state.events.length) {
                    return { isPlaying: false };
                }
                return { playbackIndex: next };
            });
        }, 800);
        return () => clearInterval(timer);
    }, [isPlaying, events.length]);

    const typeIcons = {
        state_change: '🔄',
        message: '💬',
        decision: '🤔',
        collaboration: '🤝',
        tool_call: '🔧',
        qa_review: '✅',
    };

    if (events.length === 0) {
        return (
            <div className="panel__content">
                <div className="empty-state">
                    <div className="empty-state__icon">⏱️</div>
                    <div className="empty-state__title">暂无执行记录</div>
                    <div className="empty-state__text">执行任务后可在此回放完整过程</div>
                </div>
            </div>
        );
    }

    return (
        <div className="panel__content" style={{ padding: '8px' }}>
            {/* 控制条 */}
            <div style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '8px 12px', background: 'var(--bg-secondary)',
                borderRadius: '8px', marginBottom: '8px',
            }}>
                <button
                    onClick={() => isPlaying ? pausePlayback() : startPlayback()}
                    style={{
                        background: 'var(--accent-blue)', color: 'white',
                        border: 'none', borderRadius: '6px', padding: '4px 12px',
                        cursor: 'pointer', fontSize: '0.8rem',
                    }}
                >{isPlaying ? '⏸ 暂停' : '▶️ 回放'}</button>

                <input
                    type="range"
                    min={0}
                    max={Math.max(0, events.length - 1)}
                    value={playbackIndex}
                    onChange={e => setPlaybackIndex(parseInt(e.target.value))}
                    style={{ flex: 1 }}
                />

                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                    {playbackIndex + 1}/{events.length}
                </span>

                <button
                    onClick={clearEvents}
                    style={{
                        background: 'transparent', border: '1px solid var(--border-primary)',
                        borderRadius: '4px', padding: '2px 8px', cursor: 'pointer',
                        color: 'var(--text-muted)', fontSize: '0.7rem',
                    }}
                >清空</button>
            </div>

            {/* 时间线事件列表 */}
            {events.slice(0, playbackIndex + 1).reverse().map((event, idx) => (
                <div key={event.id} style={{
                    display: 'flex', gap: '8px', padding: '6px 8px',
                    borderLeft: `2px solid ${idx === 0 ? 'var(--accent-blue)' : 'var(--border-primary)'}`,
                    marginLeft: '8px', marginBottom: '2px',
                    opacity: idx === 0 ? 1 : 0.7,
                    fontSize: '0.8rem',
                }}>
                    <span>{typeIcons[event.type] || '📌'}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ fontWeight: idx === 0 ? 600 : 400 }}>
                                {event.agentName || 'System'}
                            </span>
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                                {new Date(event.timestamp).toLocaleTimeString('zh-CN')}
                            </span>
                        </div>
                        <div style={{
                            color: 'var(--text-secondary)', fontSize: '0.75rem',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                            {event.description || event.type}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}
