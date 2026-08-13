/**
 * 单租户就绪检查：发布/开始执行前缺什么，用一句人话列出。
 */

export function buildReadiness({
    agents = [],
    systemStatus = 'idle',
    gatewayProbe = null,
} = {}) {
    const ceo = agents.find(agent => agent.name === 'CEO');
    const team = agents.filter(agent => agent.name !== 'CEO');
    const missingTeam = team.filter(agent => !agent.model);
    const issues = [];

    if (gatewayProbe?.mode === 'gateway') {
        if (gatewayProbe.reason === 'missing_config') {
            issues.push({ id: 'gw-config', label: 'Gateway 未填 URL/Token', tab: 'config' });
        } else if (gatewayProbe.reason === 'unreachable') {
            issues.push({ id: 'gw-down', label: 'Gateway 连不上（先 npm run gateway）', tab: 'config' });
        } else if (gatewayProbe.reason === 'unauthorized') {
            issues.push({ id: 'gw-auth', label: 'Gateway Token 无效', tab: 'config' });
        } else if (gatewayProbe.reason === 'no_provider_key') {
            issues.push({ id: 'gw-key', label: 'Gateway 进程未配置供应商 Key', tab: 'config' });
        }
    }

    if (!ceo?.model) {
        issues.push({ id: 'ceo-model', label: '请先为 CEO 选择模型', tab: 'agents' });
    }

    if (systemStatus === 'waiting_for_config' && missingTeam.length > 0) {
        issues.push({
            id: 'team-models',
            label: `成员未选模型：${missingTeam.map(agent => agent.name).join('、')}`,
            tab: 'agents',
        });
    }

    return {
        ready: issues.length === 0,
        issues,
        ceoHasModel: !!ceo?.model,
        missingTeam,
        mode: gatewayProbe?.mode || 'direct',
    };
}

export default { buildReadiness };
