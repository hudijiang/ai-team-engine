/**
 * DecisionPanel - 董事长决策面板
 * 当 Agent 间协作存在分歧时，展示多方案供董事长选择
 */
import React, { useState } from 'react';
import { useStore } from '../store/store';

export default function DecisionPanel({ onResolve }) {
    const pendingDecision = useStore(s => s.pendingDecision);
    const [selectedIdx, setSelectedIdx] = useState(null);
    const [customInput, setCustomInput] = useState('');
    const [showCustom, setShowCustom] = useState(false);

    if (!pendingDecision) return null;

    const { topic, agentA, agentB, summary, proposals, dialogueHistory } = pendingDecision;

    const handleResolve = () => {
        if (showCustom && customInput.trim()) {
            onResolve(-1, customInput.trim());
        } else if (selectedIdx !== null) {
            onResolve(selectedIdx);
        }
    };

    return (
        <div className="decision-panel">
            <div className="decision-panel__header">
                <span className="decision-panel__icon">⚖️</span>
                <h3>协作分歧 — 需要董事长决策</h3>
            </div>

            <div className="decision-panel__context">
                <div className="decision-panel__topic">
                    主题：<strong>{topic}</strong>
                </div>
                <div className="decision-panel__agents">
                    <span className="decision-panel__agent-tag">{agentA}</span>
                    <span className="decision-panel__vs">VS</span>
                    <span className="decision-panel__agent-tag">{agentB}</span>
                </div>
                <p className="decision-panel__summary">{summary}</p>
            </div>

            {/* 对话记录摘要 */}
            {dialogueHistory && dialogueHistory.length > 0 && (
                <div className="decision-panel__dialogue">
                    <div className="decision-panel__dialogue-title">讨论记录</div>
                    {dialogueHistory.slice(-4).map((d, i) => (
                        <div key={i} className="decision-panel__dialogue-item">
                            <span className="decision-panel__dialogue-from">[{d.from}]</span>
                            <span className="decision-panel__dialogue-content">
                                {d.content.length > 150 ? d.content.slice(0, 150) + '...' : d.content}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {/* 方案卡片 */}
            <div className="decision-panel__proposals">
                {proposals.map((p, idx) => (
                    <div
                        key={idx}
                        className={`proposal-card ${selectedIdx === idx ? 'proposal-card--selected' : ''}`}
                        onClick={() => { setSelectedIdx(idx); setShowCustom(false); }}
                    >
                        <div className="proposal-card__header">
                            <span className="proposal-card__index">方案 {idx + 1}</span>
                            <span className="proposal-card__title">{p.title}</span>
                        </div>
                        <p className="proposal-card__desc">{p.description}</p>
                        <div className="proposal-card__meta">
                            <span className="proposal-card__pros">✅ {p.pros}</span>
                            <span className="proposal-card__cons">⚠️ {p.cons}</span>
                        </div>
                    </div>
                ))}

                {/* 自定义方案 */}
                <div
                    className={`proposal-card proposal-card--custom ${showCustom ? 'proposal-card--selected' : ''}`}
                    onClick={() => { setShowCustom(true); setSelectedIdx(null); }}
                >
                    <div className="proposal-card__header">
                        <span className="proposal-card__index">💡</span>
                        <span className="proposal-card__title">自定义方案</span>
                    </div>
                    {showCustom && (
                        <textarea
                            className="proposal-card__custom-input"
                            placeholder="请输入您的决策方案..."
                            value={customInput}
                            onChange={e => setCustomInput(e.target.value)}
                            rows={3}
                            onClick={e => e.stopPropagation()}
                        />
                    )}
                </div>
            </div>

            <button
                className="decision-panel__confirm"
                disabled={selectedIdx === null && !(showCustom && customInput.trim())}
                onClick={handleResolve}
            >
                ✅ 确认决策
            </button>
        </div>
    );
}
