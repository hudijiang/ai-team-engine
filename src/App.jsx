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
 * 三栏布局：组织架构 | 对话流 | 状态面板
 */
export default function App() {
    useInboxSubscriber();
    const systemStatus = useStore(s => s.systemStatus);
    const agents = useStore(s => s.agents);
    const [rightTab, setRightTab] = useState('progress');

    const statusText = {
        idle: '待命中',
        running: '运行中',
        completed: '已完成',
        waiting_for_config: '⏸ 待配置',
        waiting_for_human: '🚨 待协助',
        blocked: '⚠️ 阻塞',
    };

    return (
        <>
            {/* 顶部导航 */}
            <header className="app-header">
                <div className="app-header__logo">
                    <div className="app-header__icon">🏢</div>
                    <div>
                        <div className="app-header__title">Multi-Agent 协作平台</div>
                        <div className="app-header__subtitle">企业组织结构 · 实时可视化</div>
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
            <div className="app-layout">
                {/* 左栏：组织架构 */}
                <div className="panel">
                    <div className="panel__header">
                        <span className="panel__title">🏗️ 组织架构</span>
                        <span className="text-sm text-muted">{agents.length} 人</span>
                    </div>
                    <div className="panel__content">
                        <OrgChart />
                    </div>
                </div>

                {/* 中栏：对话流 */}
                <DialoguePanel />

                {/* 右栏：状态面板 */}
                <div className="panel sidebar-panel">
                    <div className="panel-tabs">
                        <button
                            className={`panel-tab ${rightTab === 'progress' ? 'panel-tab--active' : ''}`}
                            onClick={() => setRightTab('progress')}
                        >
                            📊 进度
                        </button>
                        <button
                            className={`panel-tab ${rightTab === 'log' ? 'panel-tab--active' : ''}`}
                            onClick={() => setRightTab('log')}
                        >
                            📜 日志
                        </button>
                        <button
                            className={`panel-tab ${rightTab === 'inbox' ? 'panel-tab--active' : ''}`}
                            onClick={() => setRightTab('inbox')}
                        >
                            📨 协作
                        </button>
                        <button
                            className={`panel-tab ${rightTab === 'deliverables' ? 'panel-tab--active' : ''}`}
                            onClick={() => setRightTab('deliverables')}
                        >
                            📄 报告
                        </button>
                        <button
                            className={`panel-tab ${rightTab === 'config' ? 'panel-tab--active' : ''}`}
                            onClick={() => setRightTab('config')}
                        >
                            ⚙️ 配置
                        </button>
                    </div>
                    <div className="panel__content">
                        {rightTab === 'progress' && <ProgressDashboard />}
                        {rightTab === 'log' && <SystemLog />}
                        {rightTab === 'inbox' && <CollaborationInbox />}
                        {rightTab === 'deliverables' && <DeliverablesPanel />}
                        {rightTab === 'config' && <ModelConfigPanel />}
                    </div>
                </div>
            </div>

            {/* 底部聊天输入栏 */}
            <div className="chatbar">
                <CommandInput />
            </div>
        </>
    );
}
