import React, { useState, useMemo } from 'react';
import { addDocument, removeDocument, getKnowledgeStats, clearKnowledge } from '../engine/ragEngine';

/**
 * 知识库管理面板
 * 支持上传文档、查看列表、删除和清空
 */
export default function KnowledgePanel() {
    const [refreshKey, setRefreshKey] = useState(0);
    const [showUpload, setShowUpload] = useState(false);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');

    const stats = useMemo(() => getKnowledgeStats(), [refreshKey]);

    const handleUpload = () => {
        if (!title.trim() || !content.trim()) return;
        const result = addDocument(title.trim(), content.trim());
        setTitle('');
        setContent('');
        setShowUpload(false);
        setRefreshKey(k => k + 1);
    };

    const handleFileUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            setTitle(file.name.replace(/\.[^.]+$/, ''));
            setContent(ev.target.result);
            setShowUpload(true);
        };
        reader.readAsText(file);
    };

    const inputStyle = {
        width: '100%', padding: '6px 10px', background: 'var(--bg-tertiary)',
        border: '1px solid var(--border-primary)', borderRadius: '6px',
        color: 'var(--text-primary)', fontSize: '0.8rem',
    };

    return (
        <div className="panel__content" style={{ padding: '10px' }}>
            {/* 统计信息 */}
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginBottom: '12px', padding: '8px 12px',
                background: 'var(--bg-secondary)', borderRadius: '8px',
                border: '1px solid var(--border-primary)',
            }}>
                <div style={{ fontSize: '0.85rem' }}>
                    📚 {stats.documentCount} 篇文档 · {stats.chunkCount} 个分段
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                    <label style={{
                        padding: '4px 10px', background: 'var(--accent-blue)', color: 'white',
                        borderRadius: '6px', cursor: 'pointer', fontSize: '0.75rem',
                    }}>
                        📁 上传文件
                        <input type="file" accept=".txt,.md,.text" onChange={handleFileUpload} style={{ display: 'none' }} />
                    </label>
                    <button onClick={() => setShowUpload(!showUpload)} style={{
                        padding: '4px 10px', background: 'var(--bg-tertiary)',
                        border: '1px solid var(--border-primary)', borderRadius: '6px',
                        color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.75rem',
                    }}>✏️ 手动输入</button>
                </div>
            </div>

            {/* 上传表单 */}
            {showUpload && (
                <div style={{
                    padding: '10px', background: 'var(--bg-secondary)',
                    borderRadius: '8px', marginBottom: '10px',
                    border: '1px solid var(--border-primary)',
                }}>
                    <input
                        type="text" placeholder="文档标题" value={title}
                        onChange={e => setTitle(e.target.value)}
                        style={{ ...inputStyle, marginBottom: '6px' }}
                    />
                    <textarea
                        placeholder="文档内容（支持 Markdown / 纯文本）"
                        value={content} onChange={e => setContent(e.target.value)}
                        rows={6}
                        style={{ ...inputStyle, resize: 'vertical' }}
                    />
                    <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                        <button onClick={handleUpload} style={{
                            padding: '6px 16px', background: 'var(--accent-green)', color: 'white',
                            border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem',
                        }}>添加到知识库</button>
                        <button onClick={() => setShowUpload(false)} style={{
                            padding: '6px 16px', background: 'transparent',
                            border: '1px solid var(--border-primary)', borderRadius: '6px',
                            color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem',
                        }}>取消</button>
                    </div>
                </div>
            )}

            {/* 文档列表 */}
            {stats.documents.length === 0 ? (
                <div className="empty-state">
                    <div className="empty-state__icon">📚</div>
                    <div className="empty-state__title">知识库为空</div>
                    <div className="empty-state__text">上传文档后，Agent 将自动检索相关内容辅助回答</div>
                </div>
            ) : (
                <>
                    {stats.documents.map(doc => (
                        <div key={doc.id} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: '6px',
                            marginBottom: '4px', border: '1px solid var(--border-primary)',
                        }}>
                            <div>
                                <div style={{ fontSize: '0.85rem', fontWeight: 500 }}>{doc.title}</div>
                                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                    {doc.charCount} 字 · {new Date(doc.addedAt).toLocaleDateString('zh-CN')}
                                </div>
                            </div>
                            <button
                                onClick={() => { removeDocument(doc.id); setRefreshKey(k => k + 1); }}
                                style={{
                                    background: 'transparent', border: 'none',
                                    color: 'var(--accent-red)', cursor: 'pointer',
                                }}
                            >🗑️</button>
                        </div>
                    ))}
                    <button onClick={() => { clearKnowledge(); setRefreshKey(k => k + 1); }} style={{
                        width: '100%', marginTop: '8px', padding: '8px', borderRadius: '6px',
                        background: 'transparent', border: '1px solid var(--border-primary)',
                        color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem',
                    }}>🗑️ 清空知识库</button>
                </>
            )}
        </div>
    );
}
