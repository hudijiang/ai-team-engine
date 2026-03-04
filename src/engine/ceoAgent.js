/**
 * CEO Agent - 核心协调引擎
 * 分析战略目标、拆解任务、创建团队、协调执行、监控进度
 */
import {
    createAgent,
    createStructuredMessage,
    AGENT_STATES,
    DIALOGUE_TEMPLATES,
    AI_MODELS,
} from './agentEngine';
import { decomposeWithLLM } from './taskDecomposer';
import messageBus from './messageBus';
import { sendChat, resolveProviderForModel } from './llmClient';
import { loadProviderConfigs } from './modelConfig';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';

/**
 * CEO Agent 运行器
 * 管理整个任务生命周期
 */
export class CEOAgentRunner {
    /**
     * @param {Function} dispatch - 状态分发函数（更新 Zustand Store）
     * @param {Function} getState - 获取当前状态
     */
    constructor(dispatch, getState) {
        this.dispatch = dispatch;
        this.getState = getState;
        this.timers = [];
        this.isRunning = false;
        this._aborted = false;
        this._pendingHumanInput = null;
        this._pendingExecution = null;
    }

    /**
     * 智能推荐模型
     * 根据角色职责自动匹配最合适的可用模型
     */
    _autoRecommendModel(roleName) {
        const state = this.getState();
        const availableModelsDict = state.availableModels || {};

        // 收集所有可用模型
        let allModels = [];
        for (const models of Object.values(availableModelsDict)) {
            allModels = allModels.concat(models);
        }

        if (allModels.length === 0) {
            // fallback 到内置静态模型列表
            allModels = AI_MODELS;
        }

        if (allModels.length === 0) return '';

        const lowerRole = roleName.toLowerCase();
        let recommended = null;

        // 1. 编程代码类 -> Sonnet 3.5 / GPT-4o / DeepSeek V3/R1
        if (['前端', '后端', '架构', '测试', '开发', '工程师', '代码'].some(k => lowerRole.includes(k))) {
            recommended = allModels.find(m => m.id.includes('sonnet') || m.id.includes('claude-3.5') || m.id.includes('gpt-4') || m.id.includes('deepseek'));
        }
        // 2. 创意内容/文案类 -> Opus / GPT-4o
        else if (['文案', '内容', '策划', '报告', '设计师', '创意'].some(k => lowerRole.includes(k))) {
            recommended = allModels.find(m => m.id.includes('opus') || m.id.includes('gpt-4'));
        }
        // 3. 数据分析/逻辑推理 -> DeepSeek R1 / o1 / Opus
        else if (['分析', '数据', '研究', '财务'].some(k => lowerRole.includes(k))) {
            recommended = allModels.find(m => m.id.includes('r1') || m.id.includes('o1') || m.id.includes('gpt-5') || m.id.includes('deepseek'));
        }

        return recommended ? recommended.id : allModels[0].id;
    }

    /**
     * 启动 CEO 处理战略目标
     * @param {string} objective - 董事长发布的战略目标
     */
    async start(objective) {
        if (this.isRunning) return;
        this._aborted = false;
        this.isRunning = true;
        // 每个任务目标一个独立日志文件
        const sessionTag = objective.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '').slice(0, 20);
        const sessionId = `${sessionTag}-${Date.now()}`;
        logger.startSession(sessionId);
        logger.info('CEO', `启动处理目标：「${objective}」`);

        const state = this.getState();
        const ceoAgent = state.agents.find(a => a.name === 'CEO');

        // 阶段 1：接收目标
        this.dispatch({
            type: 'UPDATE_AGENT',
            payload: {
                id: ceoAgent.id,
                state: AGENT_STATES.PLANNING,
                currentTask: `正在调用 AI 分析目标：${objective}`,
                progress: 0.05,
            },
        });

        this._emitCEOMessage(ceoAgent, [
            `【CEO】收到董事长战略目标：「${objective}」`,
            `正在调用 AI 深度分析目标，智能组建执行团队...`,
        ], ['调用 AI 分析目标', '智能拆解任务', '动态组建团队']);

        // 阶段 2：使用 LLM 拆解任务
        let decomposition;
        try {
            const latestCEO = this._getLatestAgent(ceoAgent.id) || ceoAgent;
            const ceoModel = latestCEO.model || state.defaultModel || '';
            const availableModels = state.availableModels || {};

            if (!ceoModel) {
                throw new Error('CEO 未配置模型，无法调用 AI 分析');
            }

            decomposition = await decomposeWithLLM(objective, ceoModel, availableModels);
        } catch (err) {
            logger.error('CEO', `LLM 目标分析失败: ${err.message}`);
            this._emitCEOMessage(ceoAgent, [
                `【CEO】⚠️ AI 分析目标失败：${err.message}`,
                `请检查 CEO 的模型配置和 API Key 是否正确，然后重新发布目标。`,
            ], []);
            this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
            this.isRunning = false;
            return;
        }

        logger.info('CEO', `AI 目标拆解完成：类型=${decomposition.type}，阶段=${decomposition.totalPhases}，角色=${decomposition.roles.map(r => r.name).join(',')}`);
        this.dispatch({
            type: 'SET_DECOMPOSITION',
            payload: decomposition,
        });

        this.dispatch({
            type: 'UPDATE_AGENT',
            payload: {
                id: ceoAgent.id,
                progress: 0.15,
                currentTask: 'AI 分析完成，组建团队',
            },
        });

        this._emitCEOMessage(ceoAgent, [
            `【CEO】🧠 AI 分析完毕，识别为「${decomposition.type}」类型项目。`,
            `将拆解为 ${decomposition.totalPhases} 个执行阶段，预计需要 ${decomposition.estimatedDuration} 个工作周期。`,
            `AI 智能组建以下角色团队：`,
            ...decomposition.roles.map(r => `  • ${r.name}：${r.role}`),
        ], ['创建团队成员', '分配具体任务', '启动执行流程']);

        await this._delay(2500);
        if (this._aborted) return;

        // 阶段 3：创建团队 Agent（优先复用已有成员）
        const teamAgents = [];
        const state2 = this.getState();
        for (const roleInfo of decomposition.roles) {
            const recommendedModel = this._autoRecommendModel(roleInfo.name);
            // 优先查找已有的同名 Agent 进行复用
            const existing = state2.agents.find(a => a.name === roleInfo.name && a.id !== ceoAgent.id);
            let agent;
            let isReused = false;

            if (existing) {
                // 复用已有 Agent：重置执行状态，保留 id 和已配置的 model
                agent = existing;
                isReused = true;
                this.dispatch({
                    type: 'UPDATE_AGENT',
                    payload: {
                        id: agent.id,
                        role: roleInfo.role,           // 更新为新目标对应的 role 描述
                        color: roleInfo.color || agent.color,
                        state: AGENT_STATES.IDLE,
                        currentTask: '',
                        currentSubtaskIndex: 0,
                        progress: 0,
                        outputs: [],
                        conversationHistory: [],
                        phase: '',
                        dependencies: [],
                        subtasks: [],
                        collaborators: [],
                    },
                });
            } else {
                // 新建 Agent
                agent = createAgent({
                    name: roleInfo.name,
                    role: roleInfo.role,
                    color: roleInfo.color,
                    parentId: ceoAgent.id,
                    model: roleInfo.model || recommendedModel,
                });
            }

            // 查找该角色对应的任务
            const task = decomposition.tasks.find(t => t.assignee === roleInfo.name);
            if (task) {
                const updates = {
                    id: agent.id,
                    phase: task.phase,
                    subtasks: task.subtasks,
                    currentTask: task.phase,
                    dependencies: task.dependencies,
                    collaborators: decomposition.roles
                        .filter(r => r.name !== roleInfo.name)
                        .map(r => r.name),
                };
                if (isReused) {
                    this.dispatch({ type: 'UPDATE_AGENT', payload: updates });
                } else {
                    Object.assign(agent, updates);
                }
            }

            teamAgents.push(isReused ? this._getLatestAgent(agent.id) : agent);
            if (!isReused) {
                this.dispatch({ type: 'ADD_AGENT', payload: agent });
            }

            this._emitCEOMessage(ceoAgent, [
                `【CEO】✅ ${isReused ? '复用' : '创建'}团队成员：${roleInfo.name}`,
                `  职责：${roleInfo.role}`,
                `  分配任务：${task ? task.phase : '待分配'}`,
            ], []);

            await this._delay(1000);
            if (this._aborted) return;
        }

        // ⏸️ 阶段 3.5：暂停等待董事长配置模型
        this.dispatch({
            type: 'UPDATE_AGENT',
            payload: {
                id: ceoAgent.id,
                state: AGENT_STATES.WAITING,
                currentTask: '等待董事长为团队成员分配模型',
                progress: 0.2,
            },
        });

        this._emitCEOMessage(ceoAgent, [
            `【CEO】✋ 团队组建完毕，共 ${teamAgents.length} 名成员。`,
            `⚠️ 请董事长为每位团队成员选择AI模型后，点击「开始执行」按钮。`,
            `请在左侧 Agent 卡片的下拉框中为每个成员选择合适的模型。`,
        ], ['等待董事长配置模型', '确认后启动执行']);

        this.dispatch({ type: 'SET_STATUS', payload: 'waiting_for_config' });

        // 保存待执行数据，等待用户确认后调用 resume()
        this._pendingExecution = { ceoAgent, teamAgents, decomposition };
        this.isRunning = false;
    }

    /**
     * 董事长确认模型配置后，恢复执行
     */
    async resume() {
        if (!this._pendingExecution) return;
        this._aborted = false;
        this.isRunning = true;

        const { ceoAgent, teamAgents, decomposition } = this._pendingExecution;
        this._pendingExecution = null;

        // 获取最新的 Agent 状态（可能已修改模型）
        const state = this.getState();
        const latestTeamAgents = teamAgents.map(a => {
            const latest = state.agents.find(ag => ag.id === a.id);
            return latest || a;
        });

        // ✅ 前置检查：验证所有 Agent 的 API Key 是否已配置
        const configs = loadProviderConfigs();
        const missingConfigs = [];
        for (const agent of latestTeamAgents) {
            if (!agent.model) continue;
            const providerId = resolveProviderForModel(agent.model, state.availableModels);
            const config = configs[providerId] || configs.custom || {};
            if (!config.apiUrl || !config.apiKey) {
                missingConfigs.push({ name: agent.name, model: agent.model, provider: providerId });
            }
        }

        if (missingConfigs.length > 0) {
            const errorLines = missingConfigs.map(m => `  ❌ ${m.name}（模型: ${m.model}）→ Provider「${m.provider}」未配置 API Key/URL`);
            this._emitCEOMessage(ceoAgent, [
                `【CEO】⚠️ 无法启动执行！以下成员的 AI 模型未完成配置：`,
                ...errorLines,
                `请先在右上角「⚙️ 设置」中配置对应 Provider 的 API Key 和 URL，然后重新点击「开始执行」。`,
            ], ['配置 API Key', '重新启动执行']);
            logger.error('CEO', `API Key 前置检查失败：${missingConfigs.map(m => `${m.name}/${m.provider}`).join(', ')}`);
            this.isRunning = false;
            // 保留 _pendingExecution 以便用户配置后重试
            this._pendingExecution = { ceoAgent, teamAgents, decomposition };
            return;
        }

        this.dispatch({
            type: 'UPDATE_AGENT',
            payload: {
                id: ceoAgent.id,
                state: AGENT_STATES.EXECUTING,
                currentTask: '协调团队执行',
                progress: 0.25,
            },
        });

        this.dispatch({ type: 'SET_STATUS', payload: 'running' });

        // 展示各成员选定的模型
        const modelLines = latestTeamAgents.map(a => {
            const modelText = a.model || '未指定（模拟模式）';
            return `  • ${a.name}：${modelText}`;
        });

        this._emitCEOMessage(ceoAgent, [
            `【CEO】✅ 董事长已确认团队配置！`,
            `各成员模型分配：`,
            ...modelLines,
            `正在启动执行流程，按依赖关系调度任务...`,
        ], ['监控各阶段进度', '协调团队协作', '处理阻塞问题']);

        await this._delay(1500);
        if (this._aborted) return;

        // 阶段 4：驱动团队执行
        await this._driveExecution(ceoAgent, latestTeamAgents, decomposition);

        this.isRunning = false;
    }

    /**
     * 驱动团队执行各阶段任务
     */
    async _driveExecution(ceoAgent, teamAgents, decomposition) {
        const tasks = decomposition.tasks;
        const validation = this._validateTasks(tasks);
        if (!validation.ok) {
            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: ceoAgent.id,
                    state: AGENT_STATES.BLOCKED,
                    currentTask: '任务依赖校验失败',
                },
            });
            this._emitCEOMessage(ceoAgent, [
                '【CEO】⚠️ 任务依赖校验未通过，已暂停执行。',
                ...validation.issues.map(i => `- ${i}`),
                '请调整目标或重置后重新发布。'
            ], []);
            this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
            return;
        }

        const completedPhases = new Set();
        let noProgressTicks = 0;
        const MAX_IDLE_TICKS = 40; // ~20s (40 * 500ms)

        // 按依赖关系调度
        while (completedPhases.size < tasks.length) {
            const doneBeforeLoop = completedPhases.size;
            for (const task of tasks) {
                if (completedPhases.has(task.phase)) continue;

                // 检查依赖是否满足
                const depsReady = task.dependencies.every(dep => completedPhases.has(dep));
                if (!depsReady) continue;

                const agent = teamAgents.find(a => a.name === task.assignee);
                if (!agent) continue;

                // 执行该阶段
                await this._executeAgentPhase(ceoAgent, agent, task, completedPhases);
                completedPhases.add(task.phase);

                // 更新 CEO 进度
                const overallProgress = 0.25 + (completedPhases.size / tasks.length) * 0.7;
                this.dispatch({
                    type: 'UPDATE_AGENT',
                    payload: {
                        id: ceoAgent.id,
                        progress: overallProgress,
                        currentTask: `监控执行进度 (${completedPhases.size}/${tasks.length})`,
                    },
                });
            }

            // 如果没有新进展（所有未完成的都有未满足的依赖），短暂等待
            await this._delay(500);
            if (this._aborted) return;

            const doneAfterLoop = completedPhases.size;
            if (doneAfterLoop === doneBeforeLoop) {
                noProgressTicks += 1;
            } else {
                noProgressTicks = 0;
            }

            if (noProgressTicks >= MAX_IDLE_TICKS) {
                // 依赖可能存在循环或永远无法满足，进入阻塞
                this.dispatch({
                    type: 'UPDATE_AGENT',
                    payload: {
                        id: ceoAgent.id,
                        state: AGENT_STATES.BLOCKED,
                        currentTask: '检测到依赖无法满足，已暂停，请检查任务依赖或重置',
                    },
                });
                this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });

                this._emitCEOMessage(ceoAgent, [
                    '【CEO】⚠️ 任务调度长时间无进展，可能存在循环/错误依赖。',
                    '请检查任务拆解或直接点击重置后重新发布目标。',
                ], []);

                this.isRunning = false;
                return;
            }
        }

        // 阶段 5：汇报阶段成果
        this.dispatch({
            type: 'UPDATE_AGENT',
            payload: {
                id: ceoAgent.id,
                state: AGENT_STATES.REVIEWING,
                currentTask: '审核项目成果',
                progress: 0.95,
            },
        });

        this._emitCEOMessage(ceoAgent, [
            `【CEO】🔍 所有阶段已完成，正在汇总项目成果...`,
            ...tasks.map(t => `  ✅ ${t.phase} - ${t.assignee} - 完成`),
        ], ['编写项目报告', '向董事长汇报']);

        await this._delay(2000);
        if (this._aborted) return;

        // 最终汇报
        this.dispatch({
            type: 'UPDATE_AGENT',
            payload: {
                id: ceoAgent.id,
                state: AGENT_STATES.COMPLETED,
                currentTask: '项目完成',
                progress: 1.0,
            },
        });

        // 生成详细交付报告，存入 deliverables
        const deliverable = this._buildDeliverable(decomposition, teamAgents, tasks);
        this.dispatch({ type: 'ADD_DELIVERABLE', payload: deliverable });

        // CEO 汇报附带各阶段成果摘要
        try {
            const state3 = this.getState();
            const outputSummaryLines = [];
            tasks.forEach(t => {
                const agentState = state3.agents.find(a => a.name === t.assignee);
                const outputs = agentState?.outputs || [];
                if (outputs.length > 0) {
                    outputSummaryLines.push(`📌 ${t.phase}（${t.assignee}）：`);
                    outputs.forEach(o => {
                        const firstLine = (o.content || '').split('\n').find(l => l.trim()) || '';
                        outputSummaryLines.push(`  • ${o.subtask} — ${firstLine.replace(/^#+\s*/, '').slice(0, 80)}`);
                    });
                }
            });

            const reportLines = [
                `【CEO】📋 向董事长汇报：`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `战略目标：「${decomposition.objective}」`,
                `项目类型：${decomposition.type}`,
                `执行阶段：${tasks.length} 个阶段全部完成`,
                `团队成员：${teamAgents.length} 人`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                ``,
                `### 成果概要`,
                ...outputSummaryLines,
                ``,
                `🎉 项目已圆满完成！详细报告已生成，请查看下方「交付物」面板。`,
            ];

            // 使用正确的位置参数调用 createStructuredMessage(agent, dialogue, nextStep, outputContent)
            const latestCEO = this._getLatestAgent(ceoAgent.id) || ceoAgent;
            const msg = createStructuredMessage(latestCEO, reportLines, [], deliverable.content);
            this.dispatch({ type: 'ADD_MESSAGE', payload: { ...msg, agentId: ceoAgent.id, timestamp: new Date().toISOString() } });
        } catch (err) {
            logger.error('CEO', `生成完成报告异常: ${err.message}`);
            // 即使报告生成失败，也要保证 completed 状态能设置
            this._emitCEOMessage(ceoAgent, [
                `【CEO】📋 项目已完成！交付物已生成。`,
                `🎉 所有 ${tasks.length} 个阶段执行完毕。`,
            ], []);
        }

        this.dispatch({ type: 'SET_STATUS', payload: 'completed' });
        logger.info('CEO', `项目完成：「${decomposition.objective}」，共 ${tasks.length} 阶段`);
    }

    /**
     * 执行单个 Agent 的任务阶段
     */
    async _executeAgentPhase(ceoAgent, agent, task, completedPhases) {
        const agentId = agent.id;

        // 检查前置等待
        if (task.dependencies.length > 0) {
            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: agentId,
                    state: AGENT_STATES.WAITING,
                    currentTask: `等待依赖：${task.dependencies.join(', ')}`,
                },
            });
            this._emitAgentMessage(agent,
                DIALOGUE_TEMPLATES.waiting(agent.name, task.dependencies.join(', ')),
                [`等待 ${task.dependencies.join(', ')} 完成`]
            );
            await this._delay(1000);
        }

        // 规划阶段
        this.dispatch({
            type: 'UPDATE_AGENT',
            payload: {
                id: agentId,
                state: AGENT_STATES.PLANNING,
                currentTask: `规划：${task.phase}`,
                progress: 0.1,
            },
        });
        this._emitAgentMessage(agent,
            DIALOGUE_TEMPLATES.planning(agent.name, task.subtasks),
            ['开始执行各子任务']
        );
        await this._delay(1500);

        // 执行子任务（使用升级后的 _executeSubtask）
        for (let i = 0; i < task.subtasks.length; i++) {
            const subtask = task.subtasks[i];
            const subtaskProgress = (i + 1) / task.subtasks.length;

            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: agentId,
                    state: AGENT_STATES.EXECUTING,
                    currentTask: subtask,
                    currentSubtaskIndex: i,
                    progress: subtaskProgress * 0.8,
                },
            });

            const streamClientId = uuidv4();
            let liveBuffer = '';
            const result = await this._executeSubtask(agent, subtask, subtaskProgress, (token) => {
                liveBuffer += token;
                this.dispatch({
                    type: 'UPSERT_MESSAGE',
                    payload: {
                        ...createStructuredMessage(agent, [liveBuffer], []),
                        agentId: agent.id,
                        timestamp: new Date().toISOString(),
                        source: 'llm-stream',
                        clientId: streamClientId,
                    },
                });
            });

            // 存储实质产出
            this.dispatch({
                type: 'UPDATE_AGENT_OUTPUTS',
                payload: {
                    id: agentId,
                    output: { subtask, content: result.content, source: result.source },
                },
            });

            // 用最终结果覆盖流式占位
            this._emitAgentMessage(agent,
                result.summary,
                i < task.subtasks.length - 1
                    ? [`继续执行：${task.subtasks[i + 1]}`]
                    : ['进入审核阶段'],
                result.source,
                streamClientId,
                result.content
            );

            // 检测是否需要董事长人工介入
            const needsHumanIntervention = ['登录', '验证码', '扫码', '确认账号', '支付', '人脸', '绑定'].some(k => subtask.includes(k));
            if (needsHumanIntervention) {
                const humanResult = await this._requestHumanIntervention(agent, subtask);
                if (humanResult === 'TIMEOUT_ABORT') return;
            }

            await this._delay(1500 + Math.random() * 1000);

            // 子任务完成
            this._emitAgentMessage(agent,
                DIALOGUE_TEMPLATES.subtaskComplete(agent.name, subtask),
                []
            );
        }

        // 审核阶段
        this.dispatch({
            type: 'UPDATE_AGENT',
            payload: {
                id: agentId,
                state: AGENT_STATES.REVIEWING,
                currentTask: `审核：${task.phase}`,
                progress: 0.9,
            },
        });
        this._emitAgentMessage(agent,
            DIALOGUE_TEMPLATES.reviewing(agent.name),
            ['提交最终成果']
        );
        await this._delay(1500);

        // 标记完成
        this.dispatch({
            type: 'UPDATE_AGENT',
            payload: {
                id: agentId,
                state: AGENT_STATES.COMPLETED,
                currentTask: `${task.phase} - 已完成`,
                progress: 1.0,
            },
        });
        this._emitAgentMessage(agent,
            DIALOGUE_TEMPLATES.completed(agent.name, task.phase),
            []
        );

        // CEO 确认
        this._emitCEOMessage(ceoAgent, [
            `【CEO】收到 ${agent.name} 报告：「${task.phase}」阶段已完成 ✅`,
        ], []);

        // ★ 阶段完成后，与下游依赖的 Agent 进行多轮协作共识
        const state = this.getState();
        const allTasks = state.decomposition?.tasks || [];
        const downstreamTasks = allTasks.filter(t =>
            t.dependencies.includes(task.phase)
        );
        for (const downTask of downstreamTasks) {
            const downAgent = state.agents.find(a => a.name === downTask.assignee);
            if (!downAgent || downAgent.id === agentId) continue;
            await this._conductCollaboration(ceoAgent, agent, downAgent, task.phase, 3);
            if (this._aborted) return;
        }

        await this._delay(800);
    }

    /**
     * 等待董事长的人工协助（如扫码/验证码等）
     */
    async _requestHumanIntervention(agent, currentSubtask) {
        return new Promise(resolve => {
            this._pendingHumanInput = resolve;

            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: agent.id,
                    state: AGENT_STATES.WAITING,
                    currentTask: `等待董事长协助：${currentSubtask}`,
                },
            });

            const state = this.getState();
            const ceoAgent = state.agents.find(a => a.name === 'CEO');

            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: ceoAgent.id,
                    state: AGENT_STATES.WAITING,
                    currentTask: `等待董事长协助 ${agent.name}`,
                },
            });

            this.dispatch({ type: 'SET_STATUS', payload: 'waiting_for_human' });

            this._emitCEOMessage(ceoAgent, [
                `【CEO】🚨 遇到需要董事长协助的步骤！`,
                `团队成员 ${agent.name} 在执行「${currentSubtask}」时被拦截。`,
                `请董事长在上方输入框提供协助信息（扫码/短信验证码/确认等），然后点击继续。`
            ], ['等待董事长输入协助内容', '恢复团队执行']);

            // 超时提醒：2 分钟未响应自动提示，可跳过或中止
            const timeout = setTimeout(() => {
                if (!this._pendingHumanInput) return;
                this._emitCEOMessage(ceoAgent, [
                    '【CEO】⏳ 等待协助已超过 2 分钟。',
                    '您可以在输入框提供信息，或点击“跳过此步”。',
                ], []);
            }, 120000);
            this.timers.push(timeout);
        });
    }

    /**
     * 提供董事长的人工干预输入，系统恢复
     */
    provideHumanInput(input) {
        if (this._pendingHumanInput) {
            const resolve = this._pendingHumanInput;
            this._pendingHumanInput = null;

            const state = this.getState();
            const ceoAgent = state.agents.find(a => a.name === 'CEO');

            this.dispatch({ type: 'SET_STATUS', payload: 'running' });

            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: ceoAgent.id,
                    state: AGENT_STATES.EXECUTING,
                    currentTask: '协调协作，驱动执行',
                },
            });

            this._emitCEOMessage(ceoAgent, [
                `【CEO】✅ 已收到董事长的协助输入：「${input}」`,
                `通知团队恢复执行！`
            ], ['继续调度后续阶段']);

            resolve(input);
        }
    }

    /**
     * 跳过当前人工协助步骤，继续执行
     */
    skipHumanInput(reason = 'SKIPPED_BY_USER') {
        if (this._pendingHumanInput) {
            const resolve = this._pendingHumanInput;
            this._pendingHumanInput = null;

            const state = this.getState();
            const ceoAgent = state.agents.find(a => a.name === 'CEO');

            this.dispatch({ type: 'SET_STATUS', payload: 'running' });
            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: ceoAgent.id,
                    state: AGENT_STATES.EXECUTING,
                    currentTask: '跳过人工步骤，继续执行',
                },
            });

            this._emitCEOMessage(ceoAgent, [
                `【CEO】已按董事长指示跳过当前人工协助步骤（原因：${reason}），继续执行。`,
            ], []);

            resolve(reason);
        }
    }

    /**
     * 发送 CEO 结构化消息
     */
    _emitCEOMessage(ceoAgent, dialogue, nextStep) {
        const updatedAgent = this._getLatestAgent(ceoAgent.id);
        const msg = createStructuredMessage(
            updatedAgent || ceoAgent,
            dialogue,
            nextStep
        );
        this.dispatch({ type: 'ADD_MESSAGE', payload: { ...msg, agentId: ceoAgent.id, timestamp: new Date().toISOString() } });
        messageBus.broadcastEvent('ceo-message', msg);
    }

    /**
     * 构建前次会话上下文摘要，用于注入 LLM prompt
     * 包含：sessionHistory 中的历史目标+关键产出 + 当前会话中其他 Agent 已完成的产出
     */
    _buildSessionContext() {
        const state = this.getState();
        const parts = [];

        // 1. 从 sessionHistory 获取历史会话的目标和关键产出
        const history = state.sessionHistory || [];
        if (history.length > 0) {
            // 只取最近 2 个历史会话
            const recent = history.slice(-2);
            recent.forEach((session, idx) => {
                parts.push(`【历史会话${idx + 1}】目标：${session.objective}`);
                // 从历史消息中提取关键产出摘要（取含 outputContent 的消息）
                const outputs = (session.messages || [])
                    .filter(m => m.outputContent)
                    .slice(0, 4)
                    .map(m => `  - [${m.role}] ${m.outputContent.slice(0, 150).replace(/\n/g, ' ')}`)
                    .join('\n');
                if (outputs) parts.push(outputs);
            });
        }

        // 2. 当前会话中其他 Agent 已完成的产出
        const currentAgentOutputs = state.agents
            .filter(a => a.name !== 'CEO' && (a.outputs || []).length > 0)
            .slice(0, 3)
            .map(a => {
                const summary = a.outputs.slice(-2)
                    .map(o => `  - ${o.subtask}: ${(o.content || '').slice(0, 120).replace(/\n/g, ' ')}`)
                    .join('\n');
                return `【${a.name}已完成】\n${summary}`;
            })
            .join('\n');
        if (currentAgentOutputs) parts.push(currentAgentOutputs);

        return parts.join('\n');
    }

    /**
     * 执行子任务并生成实质产出（替代旧的 _generateDialogue）
     */
    async _executeSubtask(agent, subtask, progress, onStream) {
        const state = this.getState();
        const availableModels = state.availableModels;
        const latestAgent = this._getLatestAgent(agent.id) || agent;
        const prevOutputs = (latestAgent.outputs || [])
            .slice(-3)
            .map(o => `- ${o.subtask}: ${(o.content || '').slice(0, 200)}`)
            .join('\n');

        // 构建会话上下文
        const sessionContext = this._buildSessionContext();
        const currentObjective = state.currentObjective || '';

        const systemPrompt = [
            `你是团队成员「${agent.name}」，角色：${agent.role}。`,
            `当前项目目标：「${currentObjective}」`,
            sessionContext ? `\n### 项目背景与上下文\n${sessionContext}\n` : '',
            '你正在执行一个具体的工作子任务。请直接输出实质性工作成果。',
            '要求：Markdown 格式，200-500 字中文，具体可用，不是概述。',
            '重要：请结合以上项目背景和上下文来理解当前任务，不要脱离上下文给出泛泛的通用回答。',
        ].filter(Boolean).join('\n');

        const userPrompt = [
            `当前子任务：「${subtask}」`,
            `整体进度：${(progress * 100).toFixed(0)}%`,
            prevOutputs ? `\n已有产出：\n${prevOutputs}` : '',
            '\n请直接输出该子任务的工作成果：',
        ].join('\n');

        try {
            const content = await this._callLLMWithRetry({
                model: agent.model || state.defaultModel || '',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                availableModels,
                stream: true,
                onToken: (t) => onStream && onStream(t),
            });

            if (content) {
                const lines = content.split('\n').filter(Boolean);
                const summaryLines = [
                    `【${agent.name}】已完成：${subtask}`,
                    lines[0] ? `📄 ${lines[0].replace(/^#+\s*/, '').slice(0, 80)}...` : '',
                ].filter(Boolean);

                this.dispatch({
                    type: 'UPDATE_AGENT_HISTORY',
                    payload: {
                        id: agent.id,
                        entry: { role: 'assistant', content: `[${subtask}] ${content.slice(0, 300)}` },
                    },
                });

                return { summary: summaryLines, content, source: 'llm' };
            }
        } catch (e) {
            logger.warn('LLM', `子任务执行失败：${subtask} - ${e.message}`);
        }

        const fallbackLines = DIALOGUE_TEMPLATES.executing(agent.name, subtask, progress * 0.8);
        return { summary: fallbackLines, content: fallbackLines.join('\n'), source: 'template' };
    }

    /**
     * 多轮协作对话 + 共识判定
     */
    async _conductCollaboration(ceoAgent, agentA, agentB, topic, maxRounds = 3) {
        const state = this.getState();
        const availableModels = state.availableModels;
        const latestA = this._getLatestAgent(agentA.id) || agentA;
        const aOutputs = (latestA.outputs || [])
            .map(o => `${o.subtask}: ${(o.content || '').slice(0, 300)}`)
            .join('\n---\n');

        this._emitCEOMessage(ceoAgent, [
            `【CEO】📢 启动跨阶段协作：${agentA.name} ↔ ${agentB.name}`,
            `主题：「${topic}」阶段成果衔接`,
        ], []);

        const dialogueHistory = [];

        const sessionContext = this._buildSessionContext();
        const currentObjective = state.currentObjective || '';

        for (let round = 0; round < maxRounds; round++) {
            if (this._aborted) return;

            // Agent A 发言
            const contextBlock = sessionContext ? `\n项目背景：\n目标：「${currentObjective}」\n${sessionContext}\n` : '';
            const aPrompt = round === 0
                ? `你是「${agentA.name}」，刚完成「${topic}」。${contextBlock}成果摘要：\n${aOutputs}\n\n需要向「${agentB.name}」（${agentB.role}）交接。说明产出要点和建议，100-200字中文。请紧密结合项目背景来交接。`
                : `你是「${agentA.name}」，讨论记录：\n${dialogueHistory.map(d => `[${d.from}]: ${d.content}`).join('\n')}\n\n请回应对方意见，100-200字。`;

            let aResp = '';
            try {
                aResp = await this._callLLMWithRetry({
                    model: agentA.model || '',
                    messages: [{ role: 'user', content: aPrompt }],
                    availableModels,
                }) || '';
            } catch (_e) {
                aResp = `关于「${topic}」的成果已就绪，请 ${agentB.name} 参考执行。`;
            }

            dialogueHistory.push({ from: agentA.name, content: aResp, round });
            this._emitAgentMessage(agentA,
                [`【${agentA.name}】→ @${agentB.name}：${aResp}`],
                [], 'collaboration'
            );
            messageBus.sendAgentMessage(agentA.id, agentB.name, {
                from: agentA.name, to: agentB.name, content: [aResp], topic, source: 'collaboration',
            });

            await this._delay(1000);
            if (this._aborted) return;

            // Agent B 回复
            const bPrompt = `你是「${agentB.name}」（${agentB.role}），即将开始工作。\n「${agentA.name}」交接了「${topic}」成果。讨论记录：\n${dialogueHistory.map(d => `[${d.from}]: ${d.content}`).join('\n')}\n\n回复你的理解、疑问或建议。同意可表达"同意"，有异议请明确说明。100-200字中文。`;

            let bResp = '';
            try {
                bResp = await this._callLLMWithRetry({
                    model: agentB.model || '',
                    messages: [{ role: 'user', content: bPrompt }],
                    availableModels,
                }) || '';
            } catch (_e) {
                bResp = `收到，我会基于 ${agentA.name} 的成果继续推进。`;
            }

            dialogueHistory.push({ from: agentB.name, content: bResp, round });
            this._emitAgentMessage(agentB,
                [`【${agentB.name}】→ @${agentA.name}：${bResp}`],
                [], 'collaboration'
            );
            messageBus.sendAgentMessage(agentB.id, agentA.name, {
                from: agentB.name, to: agentA.name, content: [bResp], topic, source: 'collaboration',
            });

            await this._delay(1000);
            if (this._aborted) return;

            // 共识判定
            const consensus = await this._checkConsensus(dialogueHistory, agentA.name, agentB.name, topic);

            if (consensus.agreed) {
                this._emitCEOMessage(ceoAgent, [
                    `【CEO】✅ ${agentA.name} 与 ${agentB.name} 在「${topic}」上达成共识`,
                    `📋 共识要点：${consensus.summary}`,
                ], []);
                const entry = { role: 'system', content: `[共识] ${topic}: ${consensus.summary}` };
                this.dispatch({ type: 'UPDATE_AGENT_HISTORY', payload: { id: agentA.id, entry } });
                this.dispatch({ type: 'UPDATE_AGENT_HISTORY', payload: { id: agentB.id, entry } });
                return;
            }

            if (round < maxRounds - 1) {
                this._emitCEOMessage(ceoAgent, [
                    `【CEO】💬 第 ${round + 1} 轮协作未达成共识，继续讨论...`,
                    `分歧点：${consensus.summary}`,
                ], []);
            }
        }

        // 超过最大轮次 -> 上报分歧
        await this._escalateDisagreement(ceoAgent, agentA, agentB, topic, dialogueHistory);
    }

    /**
     * LLM 共识判定
     */
    async _checkConsensus(dialogueHistory, nameA, nameB, topic) {
        const state = this.getState();
        const availableModels = state.availableModels;
        const ceoAgent = state.agents.find(a => a.name === 'CEO');

        const prompt = `以下是「${nameA}」和「${nameB}」关于「${topic}」的对话：\n\n${dialogueHistory.map(d => `[${d.from}]: ${d.content}`).join('\n\n')}\n\n判断是否达成共识。返回 JSON：\n{"agreed": true/false, "summary": "共识要点或分歧描述", "proposals": ["方案1", "方案2"]}\nagreed=true 时 proposals 为空数组。只返回 JSON。`;

        try {
            const raw = await this._callLLMWithRetry({
                model: ceoAgent?.model || '',
                messages: [{ role: 'user', content: prompt }],
                availableModels,
            });
            const jsonMatch = (raw || '').match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            logger.warn('Consensus', `共识判定失败：${e.message}`);
        }

        return { agreed: true, summary: '按现有方案继续执行', proposals: [] };
    }

    /**
     * 分歧上报：暂停执行，多方案供董事长决策
     */
    async _escalateDisagreement(ceoAgent, agentA, agentB, topic, dialogueHistory) {
        const state = this.getState();
        const availableModels = state.availableModels;

        const prompt = `作为项目 CEO，两位成员在「${topic}」上未达成共识：\n\n${dialogueHistory.map(d => `[${d.from}]: ${d.content}`).join('\n\n')}\n\n请：1.总结分歧 2.给 2-3 个方案（含标题、描述、优势、风险）\n返回 JSON：{"summary":"...", "proposals":[{"title":"...", "description":"...", "pros":"...", "cons":"..."}]}\n只返回 JSON。`;

        let proposals = [
            { title: `采纳 ${agentA.name} 方案`, description: `按 ${agentA.name} 建议执行`, pros: '保持上游一致性', cons: '可能忽略下游需求' },
            { title: `采纳 ${agentB.name} 方案`, description: `按 ${agentB.name} 建议执行`, pros: '满足下游需求', cons: '可能需要返工' },
            { title: '折中方案', description: '综合双方意见', pros: '平衡兼顾', cons: '可能两边不完全满意' },
        ];
        let summary = `${agentA.name} 和 ${agentB.name} 在「${topic}」上存在分歧`;

        try {
            const raw = await this._callLLMWithRetry({
                model: ceoAgent?.model || '',
                messages: [{ role: 'user', content: prompt }],
                availableModels,
            });
            const jsonMatch = (raw || '').match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.proposals?.length) proposals = parsed.proposals;
                if (parsed.summary) summary = parsed.summary;
            }
        } catch (_e) {
            logger.warn('Escalation', '分歧方案生成失败，使用默认方案');
        }

        this._emitCEOMessage(ceoAgent, [
            '【CEO】⚠️ 协作分歧上报',
            `${agentA.name} 与 ${agentB.name} 在「${topic}」上经 3 轮讨论未达成共识`,
            `分歧要点：${summary}`,
            `已生成 ${proposals.length} 个备选方案，请董事长决策。`,
        ], ['等待董事长选择方案']);

        this.dispatch({
            type: 'SET_PENDING_DECISION',
            payload: { topic, agentA: agentA.name, agentB: agentB.name, summary, proposals, dialogueHistory },
        });
        this.dispatch({ type: 'SET_STATUS', payload: 'waiting_for_decision' });

        // 挂起等待董事长决策
        await new Promise(resolve => {
            this._pendingDecisionResolve = resolve;
        });
    }

    /**
     * 董事长做出决策，恢复执行
     */
    resolveDecision(proposalIndex, customInput = '') {
        const state = this.getState();
        const ceoAgent = state.agents.find(a => a.name === 'CEO');
        const decision = state.pendingDecision;
        if (!decision) return;

        const chosenText = customInput || decision.proposals[proposalIndex]?.title || `方案 ${proposalIndex + 1}`;

        this.dispatch({ type: 'SET_STATUS', payload: 'running' });
        this.dispatch({ type: 'RESOLVE_DECISION' });

        this._emitCEOMessage(ceoAgent, [
            `【CEO】✅ 董事长已做出决策：「${chosenText}」`,
            '按此方案继续执行后续阶段。',
        ], ['恢复执行流程']);

        const entry = { role: 'system', content: `[董事长决策] ${decision.topic}: ${chosenText}` };
        const aAgent = state.agents.find(a => a.name === decision.agentA);
        const bAgent = state.agents.find(a => a.name === decision.agentB);
        if (aAgent) this.dispatch({ type: 'UPDATE_AGENT_HISTORY', payload: { id: aAgent.id, entry } });
        if (bAgent) this.dispatch({ type: 'UPDATE_AGENT_HISTORY', payload: { id: bAgent.id, entry } });

        if (this._pendingDecisionResolve) {
            this._pendingDecisionResolve();
            this._pendingDecisionResolve = null;
        }
    }

    /**
     * 发送团队 Agent 结构化消息
     * @param {object} agent
     * @param {string[]} dialogue
     * @param {string[]} nextStep
     * @param {string} source
     * @param {string|null} clientId - 流式消息覆盖 ID
     * @param {string|null} outputContent - 实质产出内容
     */
    _emitAgentMessage(agent, dialogue, nextStep, source = 'template', clientId = null, outputContent = null) {
        const updatedAgent = this._getLatestAgent(agent.id);
        const msg = createStructuredMessage(
            updatedAgent || agent,
            dialogue,
            nextStep,
            outputContent
        );
        const payload = { ...msg, agentId: agent.id, timestamp: new Date().toISOString(), source };
        if (clientId) payload.clientId = clientId;
        this.dispatch({ type: clientId ? 'UPSERT_MESSAGE' : 'ADD_MESSAGE', payload });
        messageBus.broadcastEvent('agent-message', msg);
    }

    /**
     * 校验任务依赖，检测缺失/环
     */
    _validateTasks(tasks) {
        const phases = new Set(tasks.map(t => t.phase));
        const issues = [];

        // 缺失负责人
        tasks.forEach(t => {
            if (!t.assignee) issues.push(`阶段「${t.phase}」缺少负责人`);
        });

        // 依赖不存在
        tasks.forEach(t => {
            (t.dependencies || []).forEach(dep => {
                if (!phases.has(dep)) issues.push(`阶段「${t.phase}」的依赖「${dep}」不存在`);
            });
        });

        // 环检测（依赖图 dep -> phase）
        const graph = {};
        phases.forEach(p => { graph[p] = []; });
        tasks.forEach(t => {
            (t.dependencies || []).forEach(dep => {
                graph[dep] = graph[dep] || [];
                graph[dep].push(t.phase);
            });
        });

        const visited = new Set();
        const stack = new Set();
        let hasCycle = false;

        const dfs = (node) => {
            if (stack.has(node)) { hasCycle = true; return; }
            if (visited.has(node)) return;
            visited.add(node);
            stack.add(node);
            (graph[node] || []).forEach(dfs);
            stack.delete(node);
        };
        phases.forEach(dfs);
        if (hasCycle) issues.push('检测到任务依赖环，请检查阶段依赖设置');

        return { ok: issues.length === 0, issues };
    }

    /**
     * LLM 调用带重试与退避（配置类错误不重试）
     */
    async _callLLMWithRetry(params, maxAttempts = 3) {
        let attempt = 0;
        let delay = 500;
        while (attempt < maxAttempts) {
            try {
                return await sendChat(params);
            } catch (err) {
                // 配置缺失类错误不重试，直接抛出
                if (err.message && err.message.includes('未配置')) {
                    throw err;
                }
                attempt += 1;
                if (attempt >= maxAttempts) throw err;
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
            }
        }
    }

    /**
     * 构建交付物报告（汇总各 Agent 实质产出）
     */
    _buildDeliverable(decomposition, teamAgents, tasks) {
        const now = new Date().toISOString();
        const state = this.getState();
        const lines = [];

        lines.push(`# 项目交付报告`);
        lines.push('');
        lines.push(`| 项目 | 详情 |`);
        lines.push(`|------|------|`);
        lines.push(`| 生成时间 | ${now} |`);
        lines.push(`| 战略目标 | ${decomposition.objective} |`);
        lines.push(`| 项目类型 | ${decomposition.type} |`);
        lines.push(`| 阶段数量 | ${tasks.length} |`);
        lines.push(`| 团队规模 | ${teamAgents.length} 人 |`);
        lines.push('');

        // 团队角色
        lines.push(`## 团队角色与模型`);
        teamAgents.forEach(a => {
            lines.push(`- **${a.name}**（${a.role}） — 模型：${a.model || '未指定'}`);
        });
        lines.push('');

        // 各阶段实质产出
        lines.push(`## 执行阶段与成果`);
        tasks.forEach((t, idx) => {
            lines.push(`### ${idx + 1}. ${t.phase}`);
            lines.push(`- **负责人**：${t.assignee}`);
            if (t.dependencies?.length) {
                lines.push(`- **依赖**：${t.dependencies.join(', ')}`);
            }
            lines.push('');

            // 从 state 中获取该 Agent 的实质产出
            const agentState = state.agents.find(a => a.name === t.assignee);
            const outputs = agentState?.outputs || [];
            if (outputs.length > 0) {
                outputs.forEach(o => {
                    lines.push(`#### ${o.subtask}`);
                    lines.push(o.content || '（模板产出）');
                    lines.push('');
                });
            } else {
                t.subtasks?.forEach((st, i) => lines.push(`${i + 1}. ${st}`));
                lines.push('');
            }
        });

        // 协作记录摘要
        const collabMessages = (state.messages || []).filter(m => m.source === 'collaboration');
        if (collabMessages.length > 0) {
            lines.push(`## 协作对话记录`);
            collabMessages.forEach(m => {
                const line = (m.dialogue || []).join(' ');
                lines.push(`- ${line.slice(0, 200)}`);
            });
            lines.push('');
        }

        lines.push(`## 总结`);
        lines.push(`所有 ${tasks.length} 个阶段已完成，共产出 ${state.agents.reduce((s, a) => s + (a.outputs?.length || 0), 0)} 项工作成果。`);
        lines.push(`如需继续迭代，请在底部输入框直接下达新指令。`);

        return {
            id: uuidv4(),
            title: `交付物 - ${decomposition.objective.slice(0, 30)}`,
            timestamp: now,
            content: lines.join('\n'),
        };
    }

    /**
     * 获取最新的 Agent 状态
     */
    _getLatestAgent(agentId) {
        const state = this.getState();
        return state.agents.find(a => a.id === agentId);
    }

    /**
     * 延迟执行
     */
    _delay(ms) {
        return new Promise((resolve, reject) => {
            if (this._aborted) { resolve(); return; }
            const timer = setTimeout(resolve, ms);
            this.timers.push(timer);
        });
    }

    /**
     * 停止执行
     */
    stop() {
        this._aborted = true;
        this.isRunning = false;
        this.timers.forEach(t => clearTimeout(t));
        this.timers = [];
        this._pendingExecution = null;
        this._pendingHumanInput = null;
    }
}

export default CEOAgentRunner;
