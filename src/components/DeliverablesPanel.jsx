import React, { useState } from 'react';
import { useStore } from '../store/store';
import { exportAsMarkdown, exportAsHTML, exportAsPDF } from '../utils/exportUtils';
import MarkdownRenderer from './MarkdownRenderer';

/**
 * 交付物面板
 * 支持展开查看内容 + 多格式导出（Markdown / HTML / PDF）
 */
export default function DeliverablesPanel() {
    const deliverables = useStore(s => s.deliverables) || [];
    const [expanded, setExpanded] = useState(new Set());
    const [showExportMenu, setShowExportMenu] = useState(null);

    const toggle = (id) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleExport = (item, format) => {
        const title = (item.title || 'deliverable').replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_');
        switch (format) {
            case 'md': exportAsMarkdown(item.content || '', title); break;
            case 'html': exportAsHTML(item.content || '', title); break;
            case 'pdf': exportAsPDF(item.content || '', title); break;
        }
        setShowExportMenu(null);
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
                const isMenuOpen = showExportMenu === item.id;
                return (
                    <div key={item.id} className="deliverable-card">
                        <div className="deliverable-card__header" onClick={() => toggle(item.id)}>
                            <div>
                                <div className="deliverable-card__title">{item.title}</div>
                                <div className="deliverable-card__meta">{item.timestamp ? new Date(item.timestamp).toLocaleString('zh-CN', { hour12: false }) : ''}</div>
                            </div>
                            <div className="deliverable-card__actions" style={{ position: 'relative' }}>
                                <button onClick={(e) => {
                                    e.stopPropagation();
                                    setShowExportMenu(isMenuOpen ? null : item.id);
                                }}>⬇️ 导出</button>
                                {isMenuOpen && (
                                    <div style={{
                                        position: 'absolute', top: '100%', right: 0, zIndex: 100,
                                        background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
                                        borderRadius: '8px', padding: '4px', minWidth: '120px',
                                        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                                    }}>
                                        {[
                                            { key: 'md', icon: '📝', label: 'Markdown' },
                                            { key: 'html', icon: '🌐', label: 'HTML' },
                                            { key: 'pdf', icon: '📄', label: 'PDF' },
                                        ].map(fmt => (
                                            <button key={fmt.key} onClick={(e) => { e.stopPropagation(); handleExport(item, fmt.key); }}
                                                style={{
                                                    display: 'block', width: '100%', padding: '6px 12px',
                                                    background: 'transparent', border: 'none', color: 'var(--text-primary)',
                                                    textAlign: 'left', cursor: 'pointer', borderRadius: '4px',
                                                    fontSize: '0.8rem',
                                                }}
                                                onMouseEnter={e => e.target.style.background = 'var(--bg-tertiary)'}
                                                onMouseLeave={e => e.target.style.background = 'transparent'}
                                            >{fmt.icon} {fmt.label}</button>
                                        ))}
                                    </div>
                                )}
                                <button onClick={(e) => { e.stopPropagation(); toggle(item.id); }}>{isOpen ? '收起' : '展开'}</button>
                            </div>
                        </div>
                        {isOpen && (
                            <div className="deliverable-card__body">
                                <div style={{ background: 'var(--bg-tertiary)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-primary)' }}>
                                    <MarkdownRenderer text={item.content || ''} />
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
