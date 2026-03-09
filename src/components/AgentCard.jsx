import React from 'react';
import { useStore } from '../store/store';
import { STATE_LABELS, STATE_COLORS } from '../engine/agentEngine';

/**
 * Agent 卡片组件
 * 展示角色名称、职责、当前任务、模型选择下拉框、实时进度和状态指示
 */
export default function AgentCard({ agent }) {
    const selectedAgentId = useStore(s => s.selectedAgentId);
    const selectAgent = useStore(s => s.selectAgent);
    const dispatch = useStore(s => s.dispatch);
    const availableModels = useStore(s => s.availableModels);

    const isSelected = selectedAgentId === agent.id;
    const isCEO = agent.name === 'CEO';
    const stateColor = STATE_COLORS[agent.state] || STATE_COLORS.idle;
    const stateLabel = STATE_LABELS[agent.state] || agent.state;
    const isActive = ['planning', 'executing', 'reviewing'].includes(agent.state);
    // 允许在 waiting/planning 状态切换模型
    const isRunning = ['executing', 'reviewing'].includes(agent.state);

    // 合并所有供应商的动态模型列表
    const dynamicModels = Object.values(availableModels || {}).flat();
    const hasModels = dynamicModels.length > 0;

    // 获取角色首字
    const avatarText = isCEO ? '🎯' : agent.name.charAt(0);

    // 模型切换
    const handleModelChange = (e) => {
        e.stopPropagation();
        dispatch({
            type: 'UPDATE_AGENT_MODEL',
            payload: { id: agent.id, model: e.target.value },
        });
    };

    return (
        <div
            className={`agent-card ${isSelected ? 'agent-card--selected' : ''} ${isCEO ? 'agent-card--ceo' : ''}`}
            style={{ '--agent-color': agent.color || stateColor }}
            onClick={() => selectAgent(agent.id)}
            id={`agent-card-${agent.id}`}
        >
            <div className="agent-card__header">
                <div className="agent-card__name">
                    <div className="agent-card__avatar" style={{ background: agent.color }}>
                        {avatarText}
                    </div>
                    {agent.name}
                </div>
                <div
                    className="agent-card__state"
                    style={{
                        color: stateColor,
                        borderColor: `${stateColor}40`,
                        background: `${stateColor}15`,
                    }}
                >
                    <span
                        style={{
                            width: 6, height: 6, borderRadius: '50%',
                            background: stateColor, display: 'inline-block',
                            animation: isActive ? 'pulse-dot 1.5s ease-in-out infinite' : 'none',
                        }}
                    />
                    {stateLabel}
                </div>
            </div>

            <div className="agent-card__role">{agent.role}</div>

            {/* 模型下拉选择 */}
            <div className="agent-card__model" onClick={e => e.stopPropagation()}>
                <label className="agent-card__model-label">模型:</label>
                <select
                    className="agent-card__model-select"
                    value={agent.model || ''}
                    onChange={handleModelChange}
                    disabled={isRunning}
                    id={`model-select-${agent.id}`}
                >
                    <option value="">-- 选择模型 --</option>
                    {hasModels ? (
                        // 按供应商分组显示 API 动态获取的模型
                        Object.entries(availableModels || {}).map(([providerId, models]) => (
                            <optgroup key={providerId} label={providerId.toUpperCase()}>
                                {models.map(m => (
                                    <option key={m.id} value={m.id}>{m.name || m.id}</option>
                                ))}
                            </optgroup>
                        ))
                    ) : (
                        // 未配置任何 API Provider，引导用户
                        <option value="" disabled>请先在设置中配置 API Key</option>
                    )}
                </select>
            </div>

            <div className="agent-card__task">
                <span className="agent-card__task-label">任务:</span>
                {agent.currentTask || '无'}
            </div>

            <div className="progress-bar">
                <div
                    className={`progress-bar__fill ${isActive ? 'progress-bar__fill--animated' : ''}`}
                    style={{
                        width: `${(agent.progress || 0) * 100}%`,
                        background: agent.color || stateColor,
                    }}
                />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                <span className="text-sm text-muted">{agent.phase || ''}</span>
                <span className="text-sm text-mono text-muted">
                    {((agent.progress || 0) * 100).toFixed(0)}%
                </span>
            </div>
        </div>
    );
}
