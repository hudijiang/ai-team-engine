import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
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
    const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 });

    // 处理点击外部关闭菜单
    useEffect(() => {
        const handleClickOutside = () => setShowExportMenu(null);
        if (showExportMenu) {
            document.addEventListener('mousedown', handleClickOutside);
            window.addEventListener('scroll', handleClickOutside, true); // 捕获滚动事件以关闭弹窗，防止错位
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            window.removeEventListener('scroll', handleClickOutside, true);
        };
    }, [showExportMenu]);

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
                            <div className="deliverable-card__actions">
                                <button className={`btn-outline ${isMenuOpen ? 'active' : ''}`} onClick={(e) => {
                                    e.stopPropagation();
                                    if (isMenuOpen) {
                                        setShowExportMenu(null);
                                    } else {
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        setMenuPosition({
                                            top: rect.bottom + 6,
                                            right: window.innerWidth - rect.right
                                        });
                                        setShowExportMenu(item.id);
                                    }
                                }}>
                                    <span style={{ marginRight: '4px' }}>⬇️</span> 导出
                                </button>
                                {isMenuOpen && createPortal(
                                    <div
                                        className="export-dropdown-menu"
                                        style={{ position: 'fixed', top: menuPosition.top, right: menuPosition.right }}
                                        onClick={e => e.stopPropagation()}
                                        onMouseDown={e => e.stopPropagation()}
                                    >
                                        {[
                                            { key: 'md', icon: '📝', label: '导出 Markdown' },
                                            { key: 'html', icon: '🌐', label: '导出 HTML' },
                                            { key: 'pdf', icon: '📄', label: '导出 PDF' },
                                        ].map(fmt => (
                                            <button
                                                key={fmt.key}
                                                className="export-dropdown-item"
                                                onClick={(e) => { e.stopPropagation(); handleExport(item, fmt.key); }}
                                            >
                                                <span className="export-icon">{fmt.icon}</span>
                                                {fmt.label}
                                            </button>
                                        ))}
                                    </div>,
                                    document.body
                                )}
                                <button className="btn-outline" onClick={(e) => { e.stopPropagation(); toggle(item.id); }}>
                                    {isOpen ? '收起' : '展开'}
                                </button>
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
