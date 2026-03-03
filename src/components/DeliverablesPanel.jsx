import React, { useState } from 'react';
import { useStore } from '../store/store';

export default function DeliverablesPanel() {
    const deliverables = useStore(s => s.deliverables) || [];
    const [expanded, setExpanded] = useState(new Set());

    const toggle = (id) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleDownload = (item) => {
        const blob = new Blob([item.content || ''], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${item.title || 'deliverable'}.md`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    if (deliverables.length === 0) {
        return (
            <div className="panel__content">
                <div className="empty-state">
                    <div className="empty-state__icon">📄</div>
                    <div className="empty-state__title">暂无交付物</div>
                    <div className="empty-state__text">任务完成后将自动生成报告并出现在这里</div>
                </div>
            </div>
        );
    }

    return (
        <div className="panel__content deliverables-list">
            {deliverables.slice().reverse().map(item => {
                const isOpen = expanded.has(item.id);
                return (
                    <div key={item.id} className="deliverable-card">
                        <div className="deliverable-card__header" onClick={() => toggle(item.id)}>
                            <div>
                                <div className="deliverable-card__title">{item.title}</div>
                                <div className="deliverable-card__meta">{item.timestamp ? new Date(item.timestamp).toLocaleString('zh-CN', { hour12: false }) : ''}</div>
                            </div>
                            <div className="deliverable-card__actions">
                                <button onClick={(e) => { e.stopPropagation(); handleDownload(item); }}>下载</button>
                                <button onClick={(e) => { e.stopPropagation(); toggle(item.id); }}>{isOpen ? '收起' : '展开'}</button>
                            </div>
                        </div>
                        {isOpen && (
                            <div className="deliverable-card__body">
                                <pre>{item.content}</pre>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
