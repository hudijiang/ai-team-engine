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
 * 三栏布局：组织架构(可折叠) | 对话流+输入 | 状态面板(可折叠)
 */
export default function App() {
    useInboxSubscriber();
    const systemStatus = useStore(s => s.systemStatus);
    const agents = useStore(s => s.agents);
    const [rightTab, setRightTab] = useState('progress');
    const [rightCollapsed, setRightCollapsed] = useState(false);
    const [leftCollapsed, setLeftCollapsed] = useState(false);

    const statusText = {
        idle: '待命中',
        running: '运行中',
        completed: '已完成',
        waiting_for_config: '⏸ 待配置',
        waiting_for_human: '🚨 待协助',
        blocked: '⚠️ 阻塞',
    };

    const tabs = [
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
                {/* 左栏：组织架构（可折叠） */}
                <div className={`panel panel--left ${leftCollapsed ? 'panel--left-collapsed' : ''}`}>
                    <button
                        className="left-toggle"
                        onClick={() => setLeftCollapsed(!leftCollapsed)}
                        title={leftCollapsed ? '展开组织架构' : '折叠组织架构'}
                    >
                        {leftCollapsed ? '▶' : '◀'}
                    </button>

                    {leftCollapsed ? (
                        /* 折叠态：只显示 Agent 头像竖排 */
                        <div className="left-collapsed-content">
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
                        /* 展开态：完整的组织架构 */
                        <>
                            <div className="panel__header">
                                <span className="panel__title">🏗️ 组织架构</span>
                                <span className="text-sm text-muted">{agents.length} 人</span>
                            </div>
                            <div className="panel__content">
                                <OrgChart />
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
                            {tabs.map(t => (
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
                                {tabs.map(t => (
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
