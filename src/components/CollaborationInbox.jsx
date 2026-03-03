import React, { useMemo, useState } from 'react';
import { useStore } from '../store/store';

export default function CollaborationInbox() {
    const inbox = useStore(s => s.inbox);
    const dispatch = useStore(s => s.dispatch);
    const [replyMap, setReplyMap] = useState({});

    const grouped = useMemo(() => {
        return inbox.slice().reverse();
    }, [inbox]);

    if (grouped.length === 0) {
        return (
            <div className="panel__content">
                <div className="empty-state">
                    <div className="empty-state__icon">📨</div>
                    <div className="empty-state__title">暂无协作请求</div>
                    <div className="empty-state__text">团队间的 @ 协作会出现在这里</div>
                </div>
            </div>
        );
    }

    const handleCopy = (item) => {
        if (navigator?.clipboard) {
            navigator.clipboard.writeText(item.content.join('\n'));
        }
    };

    const handleForwardCEO = (item) => {
        dispatch({
            type: 'ADD_MESSAGE',
            payload: {
                role: '协作转交',
                state: 'info',
                current_task: '',
                progress: 0,
                collaborators: [],
                dialogue: [`转交给 CEO：来自 ${item.from} -> ${item.to}`, ...item.content],
                next_step: [],
                agentId: 'inbox-forward',
                timestamp: new Date().toISOString(),
                source: 'system',
            },
        });
    };

    const handleCreateSubtask = (idx, item) => {
        const text = (replyMap[idx] || '').trim();
        if (!text) return;
        const payload = {
            role: '董事长指令',
            state: 'planning',
            current_task: `新子任务：${text}`,
            progress: 0,
            collaborators: [item.from, item.to].filter(Boolean),
            dialogue: [`基于协作请求生成新子任务：${text}`],
            next_step: [],
            agentId: 'chairman',
            timestamp: new Date().toISOString(),
            source: 'manual',
        };
        dispatch({ type: 'ADD_MESSAGE', payload });
        dispatch({ type: 'MARK_INBOX_READ', payload: { index: inbox.length - 1 - idx } });
    };

    const handleReply = (idx, item) => {
        const text = (replyMap[idx] || '').trim();
        if (!text) return;
        const reply = {
            role: '董事长回复',
            state: 'info',
            current_task: `回复 ${item.from} → ${item.to}`,
            progress: 0,
            collaborators: [item.from, item.to].filter(Boolean),
            dialogue: [text],
            next_step: [],
            agentId: 'chairman',
            timestamp: new Date().toISOString(),
            source: 'manual',
        };
        dispatch({ type: 'ADD_MESSAGE', payload: reply });
        dispatch({ type: 'MARK_INBOX_READ', payload: { index: inbox.length - 1 - idx } });
        setReplyMap(prev => ({ ...prev, [idx]: '' }));
    };

    return (
        <div className="panel__content inbox-list">
            {grouped.map((item, idx) => (
                <div key={idx} className="inbox-item">
                    <div className="inbox-item__header">
                        <span className="inbox-item__from">{item.from}</span>
                        <span className="inbox-item__arrow">→</span>
                        <span className="inbox-item__to">{item.to}</span>
                        <span className={`badge ${item.source === 'llm' ? 'badge-llm' : 'badge-fallback'}`} style={{ marginLeft: 8 }}>
                            {item.source === 'llm' ? 'LLM' : '模板'}
                        </span>
                        <span className="inbox-item__time">{new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                    </div>
                    <div className="inbox-item__topic">{item.topic}</div>
                    <div className="inbox-item__content">
                        {item.content && item.content.map((line, i) => (
                            <p key={i}>{line}</p>
                        ))}
                    </div>
                    <div className="inbox-item__actions">
                        <button onClick={() => dispatch({ type: 'MARK_INBOX_READ', payload: { index: inbox.length - 1 - idx } })}>
                            {item.read ? '已读' : '标记已读'}
                        </button>
                        <button onClick={() => handleCopy(item)}>复制</button>
                        <button onClick={() => handleForwardCEO(item)}>转交 CEO</button>
                        <button onClick={() => handleReply(idx, item)}>回复</button>
                        <button onClick={() => handleCreateSubtask(idx, item)}>转为子任务</button>
                    </div>
                    <div style={{ marginTop: 6 }}>
                        <textarea
                            rows={2}
                            style={{ width: '100%', background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)', borderRadius: 6, padding: 6, resize: 'vertical' }}
                            placeholder={`回复 ${item.from || '协作者'} ...`}
                            value={replyMap[idx] || ''}
                            onChange={e => setReplyMap(prev => ({ ...prev, [idx]: e.target.value }))}
                        />
                    </div>
                </div>
            ))}
        </div>
    );
}
