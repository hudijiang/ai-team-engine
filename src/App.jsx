import React, { useState } from 'react';
import OrgChart from './components/OrgChart';
import DialoguePanel from './components/DialoguePanel';
import ProgressDashboard from './components/ProgressDashboard';
import SystemLog from './components/SystemLog';
import ModelConfigPanel from './components/ModelConfigPanel';
import CollaborationInbox from './components/CollaborationInbox';
import DeliverablesPanel from './components/DeliverablesPanel';
import useInboxSubscriber from './hooks/useInboxSubscriber';
import CommandInput from './components/CommandInput';
import { useStore } from './store/store';

/**
 * 主应用组件
 * 三栏布局：对话列表+组织架构(可折叠) | 对话流+输入 | 状态面板(可折叠)
 */
export default function App() {
    useInboxSubscriber();
    const systemStatus = useStore(s => s.systemStatus);
    const agents = useStore(s => s.agents);
    const sessionHistory = useStore(s => s.sessionHistory) || [];
    const currentObjective = useStore(s => s.currentObjective);
    const currentSessionId = useStore(s => s.currentSessionId);
    const dispatch = useStore(s => s.dispatch);

    const [rightTab, setRightTab] = useState('progress');
    const [rightCollapsed, setRightCollapsed] = useState(false);
    const [leftCollapsed, setLeftCollapsed] = useState(false);
    const [leftTab, setLeftTab] = useState('chats'); // 'chats' | 'agents'

    const statusText = {
        idle: '待命中',
        running: '运行中',
        completed: '已完成',
        waiting_for_config: '⏸ 待配置',
        waiting_for_human: '🚨 待协助',
        blocked: '⚠️ 阻塞',
    };

    const rightTabs = [
        { key: 'progress', icon: '📊', label: '进度' },
        { key: 'log', icon: '📜', label: '日志' },
        { key: 'inbox', icon: '📨', label: '协作' },
        { key: 'deliverables', icon: '📄', label: '报告' },
        { key: 'config', icon: '⚙️', label: '配置' },
    ];

    const layoutClasses = [
        'app-layout',
        rightCollapsed ? 'app-layout--collapsed' : '',
        leftCollapsed ? 'app-layout--left-collapsed' : '',
    ].filter(Boolean).join(' ');

    // 新建对话
    const handleNewChat = () => {
        if (systemStatus === 'running') return;
        dispatch({ type: 'RESET' });
    };

    // 切换到历史对话
    const handleSwitchSession = (sessionId) => {
        if (systemStatus === 'running') return;
        dispatch({ type: 'RESTORE_SESSION', payload: sessionId });
    };

    return (
        <>
            {/* 顶部导航 */}
            <header className="app-header">
                <div className="app-header__logo">
                    <div className="app-header__icon">🏢</div>
                    <div>
                        <div className="app-header__title">AI Team Engine</div>
                        <div className="app-header__subtitle">多 Agent 智能协调系统</div>
                    </div>
                </div>
                <div className="app-header__status">
                    <span className="text-sm text-muted">
                        {agents.length} 个 Agent
                    </span>
                    <span className={`status-badge status-badge--${systemStatus}`}>
                        <span className="status-dot" />
                        {statusText[systemStatus] || systemStatus}
                    </span>
                </div>
            </header>

            {/* 主布局 */}
            <div className={layoutClasses}>
                {/* 左栏：对话列表 + 组织架构（可折叠） */}
                <div className={`panel panel--left ${leftCollapsed ? 'panel--left-collapsed' : ''}`}>
                    <button
                        className="left-toggle"
                        onClick={() => setLeftCollapsed(!leftCollapsed)}
                        title={leftCollapsed ? '展开面板' : '折叠面板'}
                    >
                        {leftCollapsed ? '▶' : '◀'}
                    </button>

                    {leftCollapsed ? (
                        <div className="left-collapsed-content">
                            <button
                                className="left-icon-btn"
                                title="新建对话"
                                onClick={() => { setLeftCollapsed(false); handleNewChat(); }}
                            >
                                <span style={{ fontSize: 18 }}>➕</span>
                            </button>
                            <div style={{ width: '70%', borderTop: '1px solid var(--border-primary)', margin: '4px 0' }} />
                            {agents.map(a => (
                                <button
                                    key={a.id}
                                    className="left-icon-btn"
                                    title={`${a.name} — ${a.currentTask || '空闲'}`}
                                    onClick={() => setLeftCollapsed(false)}
                                >
                                    <div
                                        className="left-icon-btn__avatar"
                                        style={{ background: a.color || '#3B82F6' }}
                                    >
                                        {a.name === 'CEO' ? '🎯' : a.name.charAt(0)}
                                    </div>
                                </button>
                            ))}
                        </div>
                    ) : (
                        <>
                            {/* 左栏 tab 切换 */}
                            <div className="left-tabs">
                                <button
                                    className={`left-tab ${leftTab === 'chats' ? 'left-tab--active' : ''}`}
                                    onClick={() => setLeftTab('chats')}
                                >
                                    💬 对话
                                </button>
                                <button
                                    className={`left-tab ${leftTab === 'agents' ? 'left-tab--active' : ''}`}
                                    onClick={() => setLeftTab('agents')}
                                >
                                    🏗️ 团队 <span className="text-sm text-muted">({agents.length})</span>
                                </button>
                            </div>

                            <div className="panel__content">
                                {leftTab === 'chats' ? (
                                    /* 对话列表 */
                                    <div className="chat-list">
                                        {/* 新建对话按钮 */}
                                        <button
                                            className="chat-new-btn"
                                            onClick={handleNewChat}
                                            disabled={systemStatus === 'running'}
                                        >
                                            ➕ 新建对话
                                        </button>

                                        {/* 当前对话 */}
                                        {currentObjective && (
                                            <div className="chat-item chat-item--active">
                                                <div className="chat-item__icon">💬</div>
                                                <div className="chat-item__info">
                                                    <div className="chat-item__title">{currentObjective}</div>
                                                    <div className="chat-item__meta">
                                                        当前 · {agents.length} 个 Agent
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* 历史对话列表 */}
                                        {sessionHistory.slice().reverse().map((session) => (
                                            <div
                                                key={session.sessionId}
                                                className="chat-item"
                                                onClick={() => handleSwitchSession(session.sessionId)}
                                                title={session.objective || '未知目标'}
                                            >
                                                <div className="chat-item__icon">📋</div>
                                                <div className="chat-item__info">
                                                    <div className="chat-item__title">
                                                        {session.objective || '未知目标'}
                                                    </div>
                                                    <div className="chat-item__meta">
                                                        {session.messages?.length || 0} 条 · {new Date(session.timestamp).toLocaleDateString('zh-CN')}
                                                    </div>
                                                </div>
                                            </div>
                                        ))}

                                        {!currentObjective && sessionHistory.length === 0 && (
                                            <div className="chat-list__empty">
                                                <div style={{ fontSize: 28, marginBottom: 8 }}>💬</div>
                                                <div>暂无对话</div>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
                                                    在下方输入框发布目标开始第一次对话
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    /* 组织架构 */
                                    <OrgChart />
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* 中栏：对话流 + 底部输入 */}
                <div className="panel--center">
                    <DialoguePanel />
                    <div className="chatbar-inline">
                        <CommandInput />
                    </div>
                </div>

                {/* 右栏：状态面板（可折叠） */}
                <div className={`panel sidebar-panel ${rightCollapsed ? 'sidebar-panel--collapsed' : ''}`}>
                    <button
                        className="sidebar-toggle"
                        onClick={() => setRightCollapsed(!rightCollapsed)}
                        title={rightCollapsed ? '展开面板' : '折叠面板'}
                    >
                        {rightCollapsed ? '◀' : '▶'}
                    </button>

                    {rightCollapsed ? (
                        <div className="sidebar-icons">
                            {rightTabs.map(t => (
                                <button
                                    key={t.key}
                                    className={`sidebar-icon-btn ${rightTab === t.key ? 'sidebar-icon-btn--active' : ''}`}
                                    title={t.label}
                                    onClick={() => { setRightTab(t.key); setRightCollapsed(false); }}
                                >
                                    {t.icon}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <>
                            <div className="panel-tabs">
                                {rightTabs.map(t => (
                                    <button
                                        key={t.key}
                                        className={`panel-tab ${rightTab === t.key ? 'panel-tab--active' : ''}`}
                                        onClick={() => setRightTab(t.key)}
                                    >
                                        {t.icon} {t.label}
                                    </button>
                                ))}
                            </div>
                            <div className="panel__content">
                                {rightTab === 'progress' && <ProgressDashboard />}
                                {rightTab === 'log' && <SystemLog />}
                                {rightTab === 'inbox' && <CollaborationInbox />}
                                {rightTab === 'deliverables' && <DeliverablesPanel />}
                                {rightTab === 'config' && <ModelConfigPanel />}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </>
    );
}
