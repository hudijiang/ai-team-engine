import React from 'react';
import { useStore } from '../store/store';
import AgentCard from './AgentCard';

/**
 * 组织架构图组件
 * 以树形结构展示 CEO 和团队 Agent 的层级关系
 */
export default function OrgChart() {
    const agents = useStore(s => s.agents);

    const ceoAgent = agents.find(a => a.name === 'CEO');
    const teamAgents = agents.filter(a => a.name !== 'CEO');

    return (
        <div className="org-chart">
            {/* CEO Agent */}
            {ceoAgent && (
                <>
                    <AgentCard agent={ceoAgent} />

                    {teamAgents.length > 0 && (
                        <>
                            <div className="connector-line" />
                            <div className="team-divider">
                                <div className="team-divider__line" />
                                <span className="team-divider__text">
                                    团队成员 ({teamAgents.length})
                                </span>
                                <div className="team-divider__line" />
                            </div>
                        </>
                    )}
                </>
            )}

            {/* 团队 Agents */}
            {teamAgents.map(agent => (
                <AgentCard key={agent.id} agent={agent} />
            ))}

            {/* 空状态 */}
            {teamAgents.length === 0 && (
                <div className="empty-state" style={{ padding: '24px' }}>
                    <div className="empty-state__icon">👥</div>
                    <div className="empty-state__text">
                        发布战略目标后，CEO 将自动创建团队
                    </div>
                </div>
            )}
        </div>
    );
}
