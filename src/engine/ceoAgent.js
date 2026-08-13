/**
 * CEO Agent - 核心协调引擎
 * 分析战略目标、拆解任务、创建团队、协调执行、监控进度
 */
import {
    createAgent,
    createStructuredMessage,
    AGENT_STATES,
    DIALOGUE_TEMPLATES,
} from './agentEngine.js';
import { decomposeWithLLM } from './taskDecomposer.js';
import messageBus from './messageBus.js';
import { sendChat, resolveProviderForModel, isCancelError } from './llmClient.js';
import { ensureProviderConfigsHydrated, PROVIDERS, fetchModelsFromAPI, getCachedModels } from './modelConfig.js';
import { parseToolCalls } from './toolRegistry.js';
import {
    loadExecutionCapabilities,
    shouldUseToolLoop,
    executeCapabilityTool,
    summarizeToolCall,
} from './capabilityRuntime.js';
import { v4 as uuidv4 } from 'uuid';
import { formatMemoryContext, saveMemory } from './agentMemory.js';
import performanceTracker from './performanceTracker.js';
import logger from '../utils/logger.js';
import {
    ABORT_REASON,
    createAsyncMutex,
    createPauseBarrier,
    selectParallelReadyTasks,
    shouldMarkPhaseComplete,
} from './executionControl.js';
import { createGateController } from './gateController.js';
import { recordTimelineEvent, clearTimelineEvents } from './timelineRecorder.js';
import {
    buildRunningExecutionCheckpoint,
    inferNextSubtaskIndex,
    isSubtaskOutputPresent,
    normalizeInFlight,
    patchRunningCheckpointProgress,
    removeInFlight,
    summarizeRunningCheckpoint,
    upsertInFlight,
} from './workflowCheckpoint.js';
import {
    STEP_STATUS,
    normalizeSubtaskResult,
    isSuccessStatus,
    statusLabel,
} from './executionResult.js';
import {
    isHighRiskHumanTask,
    buildSafeHumanAssistContext,
    buildHumanAssistPublicMessage,
    redactSensitive,
} from '../utils/sensitiveData.js';
import { DEFAULT_TOOL_POLICY } from './capabilityRuntime.js';
import { createGatewayRun, patchGatewayRun } from './gatewayRuns.js';

const DEFAULT_DEPENDENCIES = Object.freeze({
    decomposeWithLLM,
    sendChat,
    resolveProviderForModel,
    ensureProviderConfigsHydrated,
    loadExecutionCapabilities,
    shouldUseToolLoop,
    executeCapabilityTool,
    summarizeToolCall,
    parseToolCalls,
    formatMemoryContext,
    saveMemory,
    recordPerformance: performanceTracker.record.bind(performanceTracker),
    createGatewayRun,
    patchGatewayRun,
});

/** 人工协助：仅提醒，高风险超时不再自动跳过（fail-closed） */
const HUMAN_INTERVENTION_WARN_MS = 2 * 60 * 1000;
const HUMAN_INTERVENTION_ESCALATE_MS = 10 * 60 * 1000;

/**
 * CEO Agent 运行器
 * 管理整个任务生命周期
 */
export class CEOAgentRunner {
    /**
     * @param {Function} dispatch - 状态分发函数（更新 Zustand Store）
     * @param {Function} getState - 获取当前状态
     */
    constructor(dispatch, getState, dependencies = {}) {
        this._rawDispatch = dispatch;
        this.dispatch = (action) => {
            this._rawDispatch(action);
            if (action?.type === 'SET_STATUS' && typeof action.payload === 'string') {
                this._syncGatewayRun({ status: action.payload });
            }
        };
        this.getState = getState;
        this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
        this._gatewayRunId = null;
        this.timers = [];
        this.isRunning = false;
        this._aborted = false;
        this._paused = false;
        this._pendingHumanInput = null;
        this._pendingExecution = null;
        this._pendingDecisionResolve = null;
        /** @type {import('./executionControl.js').createPauseBarrier extends Function ? ReturnType<typeof createPauseBarrier> : any} */
        this._pauseBarrier = createPauseBarrier();
        /**
         * 统一用户交互门禁（HITL + 决策共用一把锁）
         * 禁止并行阶段同时写入 systemStatus/workflowCheckpoint
         */
        this._userGate = createAsyncMutex();
        /** @deprecated 兼容别名 → _userGate */
        this._humanGate = this._userGate;
        /** @deprecated 兼容别名 → _userGate */
        this._decisionGate = this._userGate;
        /** @type {Array<{phase: string, reason: string}>} */
        this._phaseFailures = [];
        /** @type {AbortController|null} 本轮执行的取消控制器 */
        this._runAbortController = null;
        /** @type {Record<string, {status: string, qa?: string, reason?: string}>} */
        this._phaseResults = {};
        /**
         * 门禁 generation + gateId 所有权（抽出为 GateController）。
         * stop/reset/_beginRunAbortScope 时 bump，使活动中的 escalate/HITL 写状态作废。
         */
        this._gates = createGateController({ createId: uuidv4 });
    }

    get _gateGeneration() {
        return this._gates.generation;
    }

    set _gateGeneration(value) {
        this._gates.generation = value;
    }

    get _runGateId() {
        return this._gates.runGateId;
    }

    set _runGateId(value) {
        this._gates.runGateId = value;
    }

    /**
     * 开启本轮执行的 Abort 作用域（会取消上一轮未结束的 LLM 请求）
     */
    _beginRunAbortScope() {
        this._gates.bump({ rotateRunId: true });
        if (this._runAbortController) {
            try {
                this._runAbortController.abort();
            } catch (_) { /* ignore */ }
        }
        this._runAbortController = new AbortController();
        return this._runAbortController.signal;
    }

    _captureGateToken() {
        return this._gates.captureToken();
    }

    _rollbackOwnedGate(gateId, gateType) {
        this._gates.rollbackOwned(this.dispatch, gateId, gateType);
    }

    /**
     * 测试/嵌入方可能提供精简 dispatch；生产 store 使用 ROLLBACK_GATE 做原子 CAS，
     * 这里的后备路径仍只按精确 gateId 清理，绝不按 waiting 类型误删新门禁。
     */
    _rollbackOwnedGateCompat(gateId, gateType) {
        this._gates.rollbackOwnedCompat({
            dispatch: this.dispatch,
            getState: this.getState,
            clearCheckpoint: () => this._clearWorkflowCheckpoint(),
        }, gateId, gateType);
    }

    /** 门禁 generation 是否仍有效（且未 abort） */
    _isGateGenerationAlive(gen) {
        return this._gates.isAlive(gen, {
            aborted: this._aborted,
            signal: this._getRunSignal(),
        });
    }

    /**
     * 若 generation 已作废则返回 true（调用方应立即中止写状态）
     */
    _gateInvalidated(gen) {
        return this._gates.invalidated(gen, {
            aborted: this._aborted,
            signal: this._getRunSignal(),
        });
    }

    _getRunSignal() {
        return this._runAbortController?.signal || null;
    }

    _endRunAbortScope() {
        // 不在这里 abort：正常结束无需取消；stop() 负责 abort
        this._runAbortController = null;
    }

    /**
     * 持久化运行中检查点（阶段 + 子任务 inFlight）
     * @param {object} [options]
     * @param {object} [options.upsertInFlight] 更新进行中阶段的子任务进度
     * @param {string} [options.removeInFlightPhase] 移除某阶段 inFlight
     * @param {InFlightPhase[]} [options.replaceInFlight] 全量替换 inFlight
     */
    _persistRunningCheckpoint(ceoAgent, teamAgents, decomposition, completedPhases, options = {}) {
        if (!ceoAgent || !decomposition) return;
        const existing = this.getState().workflowCheckpoint;
        const teamAgentIds = Array.from(teamAgents ?? [], a => a.id).filter(Boolean);
        const completed = [...(completedPhases ?? [])];
        const failures = [...(this._phaseFailures ?? [])];

        // 门禁检查点优先：并行阶段不得覆盖 waiting_for_*，否则刷新后无法恢复 HITL
        const gateTypes = new Set(['waiting_for_human', 'waiting_for_decision', 'waiting_for_config']);
        if (existing?.type && gateTypes.has(existing.type)) {
            const snapshotInFlight = existing.runningSnapshot?.inFlight;
            const gateInFlight = snapshotInFlight === undefined
                ? existing.inFlight
                : snapshotInFlight;
            let sideInFlight = normalizeInFlight(gateInFlight);
            if (options.upsertInFlight) {
                sideInFlight = upsertInFlight(sideInFlight, options.upsertInFlight);
            }
            if (options.removeInFlightPhase) {
                sideInFlight = removeInFlight(sideInFlight, options.removeInFlightPhase);
            }
            if (options.replaceInFlight !== undefined) {
                sideInFlight = normalizeInFlight(options.replaceInFlight);
            }
            this._setWorkflowCheckpoint({
                ...existing,
                // 保留门禁 type 与 HITL 字段；进度写入 runningSnapshot
                runningSnapshot: {
                    ceoAgentId: ceoAgent.id,
                    teamAgentIds,
                    decomposition,
                    completedPhases: completed,
                    phaseFailures: failures,
                    inFlight: sideInFlight,
                    updatedAt: new Date().toISOString(),
                },
                updatedAt: new Date().toISOString(),
            });
            return;
        }

        if (existing?.type === 'running_execution' && options.replaceInFlight === undefined) {
            const patched = patchRunningCheckpointProgress(existing, {
                completedPhases: completed,
                phaseFailures: failures,
                upsert: options.upsertInFlight ?? null,
                removePhase: options.removeInFlightPhase ?? null,
                teamAgentIds,
            });
            // 上面的类型检查已保证 helper 一定返回 running checkpoint。
            patched.decomposition = decomposition;
            patched.ceoAgentId = ceoAgent.id;
            this._setWorkflowCheckpoint(patched);
            return;
        }

        // running_execution + 未指定 replace 已在上方走增量 patch 返回；
        // 走到这里时应以显式 replacement（若有）或空列表重建，不能再继承旧快照。
        let inFlight = normalizeInFlight(options.replaceInFlight);

        if (options.upsertInFlight) {
            inFlight = upsertInFlight(inFlight, options.upsertInFlight);
        }
        if (options.removeInFlightPhase) {
            inFlight = removeInFlight(inFlight, options.removeInFlightPhase);
        }

        this._setWorkflowCheckpoint(buildRunningExecutionCheckpoint({
            ceoAgentId: ceoAgent.id,
            teamAgentIds,
            decomposition,
            completedPhases: completed,
            phaseFailures: failures,
            inFlight,
            existing: null,
        }));
    }

    /**
     * 智能推荐模型（LLM 动态驱动）
     * 根据角色职责，调用 LLM 从可用模型中推荐最合适的模型
     */
    async _autoRecommendModel(roleName) {
        const state = this.getState();
        const availableModelsDict = state.availableModels || {};

        // 收集所有可用模型
        let allModels = [];
        for (const models of Object.values(availableModelsDict)) {
            allModels = allModels.concat(models);
        }

        if (allModels.length === 0) return '';

        // 尝试 LLM 推荐
        try {
            const recommended = await this._llmRecommendModel(roleName, allModels);
            if (recommended) return recommended;
        } catch (e) {
            logger.warn('CEO', `LLM 模型推荐失败(${roleName}): ${e.message}，使用 fallback`);
        }

        // fallback：返回第一个可用模型
        return allModels[0].id;
    }

    /**
     * 调用 LLM 为角色推荐最佳模型
     * @param {string} roleName - 角色名称
     * @param {Array} allModels - 所有可用模型列表
     * @returns {Promise<string|null>} 推荐的模型 ID
     */
    async _llmRecommendModel(roleName, allModels) {
        const state = this.getState();
        const ceoAgent = state.agents.find(a => a.name === 'CEO');
        const ceoModel = ceoAgent?.model || state.defaultModel || '';
        if (!ceoModel) return null;

        const modelList = allModels.map(m => `- ${m.id}（${m.provider || '未知供应商'}）`).join('\n');

        const prompt = `你是项目 CEO，需要为团队成员推荐最合适的 AI 模型。

角色名称：「${roleName}」

可用模型列表：
${modelList}

请根据角色的工作性质（如编程需要代码能力强的模型，创意文案需要生成能力强的模型，数据分析需要推理能力强的模型），从以上可用模型中选择最合适的一个。

只返回模型 ID，不要返回其他任何文字。`;

        const result = await this._callLLMWithRetry({
            model: ceoModel,
            messages: [{ role: 'user', content: prompt }],
            availableModels: state.availableModels,
        });

        const modelId = (result || '').trim();
        // 验证返回的模型 ID 确实在可用列表中
        const matched = allModels.find(m => m.id === modelId);
        if (matched) {
            logger.info('CEO', `LLM 为「${roleName}」推荐模型：${modelId}`);
            return matched.id;
        }

        // 模糊匹配：LLM 可能返回的格式与列表略有不同
        const fuzzyMatch = allModels.find(m => modelId.includes(m.id) || m.id.includes(modelId));
        if (fuzzyMatch) {
            logger.info('CEO', `LLM 为「${roleName}」推荐模型（模糊匹配）：${fuzzyMatch.id}`);
            return fuzzyMatch.id;
        }

        logger.warn('CEO', `LLM 推荐的模型「${modelId}」不在可用列表中`);
        return null;
    }

    /**
     * 判断子任务是否需要人工介入（双通道 + fail-closed）
     * 1) 关键词/角色命中 → 立即拦截（中英混合模式，不依赖 LLM）
     * 2) 未命中且有 CEO 模型 → LLM 只答 YES/NO；不可解析或调用失败 → 要求介入
     * 3) 无模型 → 对「操作/注册/提交」等保守词要求介入
     * 英文绕写、未见过的说法仍可能漏拦。
     * @param {object} agent - 当前 Agent
     * @param {string} subtask - 子任务描述
     * @returns {Promise<boolean>}
     */
    async _checkHumanInterventionNeeded(agent, subtask) {
        // 关键词 fail-closed：高风险任务直接要求人工，不依赖 LLM
        if (isHighRiskHumanTask(subtask) || isHighRiskHumanTask(agent?.role || '')) {
            logger.info('CEO', `关键词判定子任务「${subtask}」需要人工介入（fail-closed）`);
            return true;
        }

        const state = this.getState();
        const ceoAgent = state.agents.find(a => a.name === 'CEO');
        const ceoModel = ceoAgent?.model || state.defaultModel || '';
        // 无模型时：对不确定任务保守要求人工
        if (!ceoModel) {
            logger.warn('CEO', '无 CEO 模型，保守要求人工确认非纯分析任务');
            return /操作|执行|注册|发布|提交|创建账号|对接|调用接口/i.test(subtask);
        }

        try {
            const prompt = `判断以下子任务在自动化执行时，是否需要暂停并请求人类用户手动操作或介入。

需要人工介入的典型场景包括但不限于：
- 需要登录账号、扫码、输入验证码
- 需要人脸识别、指纹验证等生物认证
- 需要支付、转账、确认订单等金融操作
- 需要绑定手机、邮箱等个人信息
- 需要 OAuth 授权、第三方登录
- 需要物理世界操作（如拍照、签名）

子任务：「${subtask}」
执行者：${agent.name}（${agent.role}）

只返回 "YES" 或 "NO"，不要返回其他任何文字。`;

            const result = await this._callLLMWithRetry({
                model: ceoModel,
                messages: [{ role: 'user', content: prompt }],
                availableModels: state.availableModels,
            });

            const answer = (result || '').trim().toUpperCase();
            // 无法解析 → fail-closed 要求人工
            if (!answer.includes('YES') && !answer.includes('NO')) {
                logger.warn('CEO', `人工介入判断返回不可解析，默认要求介入: ${answer.slice(0, 40)}`);
                return true;
            }
            const needsIntervention = answer.includes('YES');
            if (needsIntervention) {
                logger.info('CEO', `LLM 判断子任务「${subtask}」需要人工介入`);
            }
            return needsIntervention;
        } catch (e) {
            // 商用 fail-closed：判断失败则要求人工，不得静默放行
            logger.warn('CEO', `LLM 人工介入判断失败: ${e.message}，默认要求介入`);
            return true;
        }
    }

    /**
     * 启动 CEO 处理战略目标
     * @param {string} objective - 董事长发布的战略目标
     */
    async start(objective) {
        if (this.isRunning) return;
        this._aborted = false;
        this._paused = false;
        this._phaseFailures = [];
        this._phaseResults = {};
        this._pauseBarrier.forceRelease();
        this._beginRunAbortScope();
        this.isRunning = true;
        clearTimelineEvents();

        // 会话标识不得从用户目标派生，否则目标中的凭据会进入日志文件名/元数据
        const sessionId = `session-${uuidv4()}`;
        logger.startSession(sessionId);
        logger.info('CEO', `启动处理目标：「${objective}」`);
        recordTimelineEvent('state_change', { agentName: 'CEO', detail: `启动目标：${objective}` });

        try {
            const state = this.getState();
            const ceoAgent = state.agents.find(a => a.name === 'CEO');
            if (!ceoAgent) {
                throw new Error('系统缺少 CEO Agent，无法启动');
            }

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
            const latestCEO = this._getLatestAgent(ceoAgent.id);
            const ceoModel = latestCEO.model || state.defaultModel || '';
                const availableModels = state.availableModels || {};

                if (!ceoModel) {
                    throw new Error('CEO 未配置模型，无法调用 AI 分析');
                }

                decomposition = await this.dependencies.decomposeWithLLM(
                    objective,
                    ceoModel,
                    availableModels,
                    this._getRunSignal()
                );
            } catch (err) {
                if (isCancelError(err) || this._aborted) {
                    logger.info('CEO', '目标分析已取消');
                    return;
                }
                logger.error('CEO', `LLM 目标分析失败: ${err.message}`);
                this._emitCEOMessage(ceoAgent, [
                    `【CEO】⚠️ AI 分析目标失败：${err.message}`,
                    `请检查 CEO 的模型配置和 API Key 是否正确，然后重新发布目标。`,
                ], []);
                this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
                return;
            }

            if (this._aborted) return;

            logger.info('CEO', `AI 目标拆解完成：类型=${decomposition.type}，阶段=${decomposition.totalPhases}，角色=${decomposition.roles.map(r => r.name).join(',')}`);
            try {
                const record = await this.dependencies.createGatewayRun?.({
                    objective,
                    status: 'running',
                    sessionId,
                });
                if (record?.id) {
                    this._gatewayRunId = record.id;
                    this._rawDispatch({ type: 'SET_GATEWAY_RUN_ID', payload: record.id });
                }
            } catch (_) { /* Gateway 不可用时继续本地编排 */ }
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
                const recommendedModel = await this._autoRecommendModel(roleInfo.name);
                // 模型推荐是异步边界；stop 可能在返回后使本轮失效。
                if (this._aborted) return;
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
                            role: roleInfo.role,
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
                    agent = createAgent({
                        name: roleInfo.name,
                        role: roleInfo.role,
                        color: roleInfo.color,
                        parentId: ceoAgent.id,
                        model: roleInfo.model || recommendedModel,
                    });
                }

                // 绑定该角色的全部阶段（不仅是第一个），供 UI 展示
                const roleTasks = decomposition.tasks.filter(t => t.assignee === roleInfo.name);
                const primaryTask = roleTasks[0];
                if (primaryTask) {
                    const updates = {
                        id: agent.id,
                        phase: primaryTask.phase,
                        subtasks: primaryTask.subtasks,
                        currentTask: roleTasks.length > 1
                            ? `${primaryTask.phase} 等 ${roleTasks.length} 个阶段`
                            : primaryTask.phase,
                        dependencies: primaryTask.dependencies,
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
                    `  分配任务：${roleTasks.length ? roleTasks.map(t => t.phase).join('、') : '待分配'}`,
                ], []);
                recordTimelineEvent('state_change', {
                    agentName: roleInfo.name,
                    detail: isReused ? '复用成员' : '创建成员',
                });

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

            const configGate = this._captureGateToken();
            if (this._gateInvalidated(configGate.generation)) return;

            this._emitCEOMessage(ceoAgent, [
                `【CEO】✋ 团队组建完毕，共 ${teamAgents.length} 名成员。`,
                `⚠️ 请董事长为每位团队成员选择AI模型后，点击「开始执行」按钮。`,
                `请在左侧 Agent 卡片的下拉框中为每个成员选择合适的模型。`,
            ], ['等待董事长配置模型', '确认后启动执行']);
            if (this._gateInvalidated(configGate.generation)) return;

            this.dispatch({ type: 'SET_STATUS', payload: 'waiting_for_config' });
            if (this._gateInvalidated(configGate.generation)) {
                const stateAfterStop = this.getState();
                if (stateAfterStop?.systemStatus === 'waiting_for_config'
                    && !stateAfterStop?.workflowCheckpoint) {
                    this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
                }
                return;
            }
            this._setWorkflowCheckpoint({
                type: 'waiting_for_config',
                gateId: configGate.gateId,
                gateGeneration: configGate.generation,
                ceoAgentId: ceoAgent.id,
                teamAgentIds: teamAgents.map(agent => agent.id),
                decomposition,
                createdAt: new Date().toISOString(),
            });
            if (this._gateInvalidated(configGate.generation)) {
                this._rollbackOwnedGateCompat(configGate.gateId, 'waiting_for_config');
                return;
            }

            // 保存待执行数据，等待用户确认后调用 resume()
            this._pendingExecution = { ceoAgent, teamAgents, decomposition };
            if (this._gateInvalidated(configGate.generation)) {
                this._pendingExecution = null;
                this._rollbackOwnedGateCompat(configGate.gateId, 'waiting_for_config');
                return;
            }
            recordTimelineEvent('state_change', { agentName: 'CEO', detail: '等待模型配置' });
        } catch (err) {
            logger.error('CEO', `启动流程异常: ${err.message}`);
            this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
            try {
                const ceoAgent = this.getState().agents.find(a => a.name === 'CEO');
                if (ceoAgent) {
                    this._emitCEOMessage(ceoAgent, [
                        `【CEO】⚠️ 启动失败：${err.message}`,
                        '请重置后重新发布目标。',
                    ], ['重新发布目标']);
                }
            } catch (_) { /* ignore */ }
        } finally {
            // start 在 waiting_for_config 时也会落到此处；执行权交给 resume()
            this.isRunning = false;
        }
    }

    /**
     * 董事长确认模型配置后，恢复执行
     */
    async resume() {
        if (!this._pendingExecution) {
            this.restorePendingExecution();
        }
        if (!this._pendingExecution) return;
        if (this.isRunning) return;

        this._aborted = false;
        this._paused = false;
        this._phaseFailures = [];
        this._phaseResults = {};
        this._pauseBarrier.forceRelease();
        this._beginRunAbortScope();
        this.isRunning = true;

        const pending = this._pendingExecution;
        this._pendingExecution = null;
        const { ceoAgent, teamAgents, decomposition } = pending;

        try {
            // 获取最新的 Agent 状态（可能已修改模型 / 热重组）
            let latestTeamAgents = this._refreshTeamAgents(teamAgents);
            const state = this.getState();

            // ✅ 前置检查：验证所有 Agent 的 API Key 是否已配置
            const configs = await this.dependencies.ensureProviderConfigsHydrated();
            if (this._aborted || this._getRunSignal()?.aborted) return;

            const missingConfigs = [];
            for (const agent of latestTeamAgents) {
                if (!agent.model) continue;
                const providerId = this.dependencies.resolveProviderForModel(agent.model, state.availableModels);
                    const config = configs[providerId] ?? configs.custom ?? {};
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
                // 保留 _pendingExecution 以便用户配置后重试
                this._pendingExecution = { ceoAgent, teamAgents: latestTeamAgents, decomposition };
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

            // waiting_for_config 必须先替换为可恢复的 running_execution，
            // 禁止在真正开始调度前制造“运行中但无检查点”的恢复空窗。
            const configCheckpoint = state.workflowCheckpoint?.type === 'waiting_for_config'
                ? state.workflowCheckpoint
                : { type: 'waiting_for_config' };
            this._promoteGateCheckpointToRunning(configCheckpoint, {
                ceoAgent,
                teamAgents: latestTeamAgents,
                decomposition,
                completedPhases: new Set(),
                phaseFailures: [],
                inFlight: [],
            });
            this.dispatch({ type: 'SET_STATUS', payload: 'running' });

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
            recordTimelineEvent('state_change', { agentName: 'CEO', detail: '开始执行' });

            await this._delay(1500);
            if (this._aborted) return;

            await this._driveExecution(ceoAgent, latestTeamAgents, decomposition);
        } catch (err) {
            logger.error('CEO', `执行流程异常: ${err.message}`);
            this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
            try {
                this._emitCEOMessage(ceoAgent, [
                    `【CEO】⚠️ 执行异常中断：${err.message}`,
                    '请检查模型配置或重置后重试。',
                ], ['重置后重新发布']);
            } catch (_) { /* ignore */ }
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * 驱动团队执行各阶段任务
     */
    async _driveExecution(ceoAgent, teamAgents, decomposition, options = {}) {
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

        const completedPhases = new Set(options.completedPhases || []);
        let activeTeam = this._refreshTeamAgents(teamAgents);
        let noProgressTicks = 0;
        const MAX_IDLE_TICKS = 40;

        const failedPhaseSet = () => new Set(this._phaseFailures.map(f => f.phase));

        const cascadeFailedDependencies = () => {
            const failed = failedPhaseSet();
            let changed = true;
            while (changed) {
                changed = false;
                for (const task of tasks) {
                    if (completedPhases.has(task.phase) || failed.has(task.phase)) continue;
                    const deps = task.dependencies || [];
                    const blockedByFailure = deps.some(dep => failed.has(dep));
                    if (blockedByFailure) {
                        this._phaseFailures.push({
                            phase: task.phase,
                            reason: `依赖阶段失败：${deps.filter(d => failed.has(d)).join(', ')}`,
                        });
                        failed.add(task.phase);
                        changed = true;
                    }
                }
            }
        };

        // 并行调度：每轮找出依赖已满足且 assignee 不冲突的任务
        while (completedPhases.size + failedPhaseSet().size < tasks.length) {
            if (this._aborted) return;

            const doneBeforeLoop = completedPhases.size + this._phaseFailures.length;
            cascadeFailedDependencies();
            const failed = failedPhaseSet();

            const candidateTasks = tasks.filter(task => !completedPhases.has(task.phase) && !failed.has(task.phase));
            const readyTasks = selectParallelReadyTasks(candidateTasks, completedPhases);

            if (readyTasks.length > 0) {
                if (readyTasks.length > 1) {
                    this._emitCEOMessage(ceoAgent, [
                        `【CEO】⚡ 检测到 ${readyTasks.length} 个可并行阶段，启动并行执行：`,
                        ...readyTasks.map(t => `  🚀 ${t.assignee} → ${t.phase}`),
                    ], ['并行执行任务']);
                }

                activeTeam = this._refreshTeamAgents(activeTeam);

                const results = await Promise.all(readyTasks.map(async (task) => {
                    const agent = activeTeam.find(a => a.name === task.assignee);
                    if (!agent) {
                        logger.error('CEO', `阶段「${task.phase}」找不到负责人「${task.assignee}」`);
                        return {
                            phase: task.phase,
                            success: false,
                            aborted: false,
                            reason: `找不到负责人 ${task.assignee}`,
                        };
                    }
                    try {
                        const success = await this._executeAgentPhase(
                            ceoAgent, agent, task, completedPhases, activeTeam
                        );
                        return {
                            phase: task.phase,
                            success: !!success,
                            aborted: this._aborted,
                            reason: success ? '' : '阶段未成功完成',
                        };
                    } catch (err) {
                        logger.error('CEO', `阶段「${task.phase}」异常: ${err.message}`);
                        return {
                            phase: task.phase,
                            success: false,
                            aborted: this._aborted,
                            reason: err.message,
                        };
                    }
                }));

                for (const result of results) {
                    if (shouldMarkPhaseComplete(result)) {
                        completedPhases.add(result.phase);
                        recordTimelineEvent('state_change', {
                            agentName: result.phase,
                            detail: '阶段完成',
                        });
                    } else if (!result.aborted) {
                        this._phaseFailures.push({
                            phase: result.phase,
                            reason: result.reason,
                        });
                        recordTimelineEvent('state_change', {
                            agentName: result.phase,
                            detail: `阶段失败：${result.reason}`,
                        });
                    }
                }

                // 热重组后刷新团队视图
                activeTeam = this._refreshTeamAgents(activeTeam);

                // 阶段级检查点：每轮调度后持久化，支持刷新续跑
                if (!this._aborted) {
                    this._persistRunningCheckpoint(
                        ceoAgent,
                        activeTeam,
                        decomposition,
                        completedPhases
                    );
                }

                const overallProgress = 0.25 + (completedPhases.size / Math.max(tasks.length, 1)) * 0.7;
                this.dispatch({
                    type: 'UPDATE_AGENT',
                    payload: {
                        id: ceoAgent.id,
                        progress: overallProgress,
                        currentTask: `监控执行进度 (${completedPhases.size}/${tasks.length} 完成` +
                            (this._phaseFailures.length ? `，${this._phaseFailures.length} 失败` : '') + ')',
                    },
                });
            }

            await this._delay(500);
            if (this._aborted) return;

            cascadeFailedDependencies();

            const doneAfterLoop = completedPhases.size + this._phaseFailures.length;
            if (doneAfterLoop === doneBeforeLoop) {
                noProgressTicks += 1;
            } else {
                noProgressTicks = 0;
            }

            if (noProgressTicks >= MAX_IDLE_TICKS) {
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
                return;
            }
        }

        // 阶段 5：汇报阶段成果（支持部分成功）
        const failed = failedPhaseSet();
        const allSucceeded = failed.size === 0 && completedPhases.size === tasks.length;

        this.dispatch({
            type: 'UPDATE_AGENT',
            payload: {
                id: ceoAgent.id,
                state: AGENT_STATES.REVIEWING,
                currentTask: allSucceeded ? '审核项目成果' : '汇总部分成果',
                progress: 0.95,
            },
        });

        this._emitCEOMessage(ceoAgent, [
            allSucceeded
                ? `【CEO】🔍 所有阶段已完成，正在汇总项目成果...`
                : `【CEO】🔍 执行结束（成功 ${completedPhases.size}/${tasks.length}），正在汇总已完成成果...`,
            ...tasks.map(t => {
                if (completedPhases.has(t.phase)) return `  ✅ ${t.phase} - ${t.assignee} - 完成`;
                if (failed.has(t.phase)) {
                    const reason = this._phaseFailures.find(f => f.phase === t.phase).reason;
                    return `  ❌ ${t.phase} - ${t.assignee} - ${reason}`;
                }
                return `  ⏳ ${t.phase} - ${t.assignee} - 未完成`;
            }),
        ], ['编写项目报告', '向董事长汇报']);

        await this._delay(2000);
        if (this._aborted) return;

        this.dispatch({
            type: 'UPDATE_AGENT',
            payload: {
                id: ceoAgent.id,
                state: allSucceeded ? AGENT_STATES.COMPLETED : AGENT_STATES.BLOCKED,
                currentTask: allSucceeded ? '项目完成' : '部分阶段失败',
                progress: 1.0,
            },
        });

        const deliverable = this._buildDeliverable(decomposition, activeTeam, tasks, {
            completedPhases,
            phaseFailures: this._phaseFailures,
            phaseResults: this._phaseResults,
        });
        this.dispatch({ type: 'ADD_DELIVERABLE', payload: deliverable });

        try {
            const state3 = this.getState();
            const outputSummaryLines = [];
            tasks.forEach(t => {
                const agentState = state3.agents.find(a => a.name === t.assignee);
                const outputs = (agentState?.outputs || []).filter(o => o.phase === t.phase);
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
                `战略目标：「${redactSensitive(decomposition.objective)}」`,
                `项目类型：${redactSensitive(decomposition.type)}`,
                `执行阶段：成功 ${completedPhases.size}/${tasks.length}` +
                    (failed.size ? `，失败 ${failed.size}` : ''),
                `团队成员：${activeTeam.length} 人`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                ``,
                `### 成果概要`,
                ...outputSummaryLines.map(line => redactSensitive(line)),
                ``,
                allSucceeded
                    ? `🎉 项目已圆满完成！详细报告已生成，请查看下方「交付物」面板。`
                    : `⚠️ 项目部分完成。失败阶段请见上方列表；可重置后针对未完成部分重新发布。`,
            ];

                const latestCEO = this._getLatestAgent(ceoAgent.id);
            const msg = createStructuredMessage(latestCEO, reportLines, [], deliverable.content);
            this.dispatch({ type: 'ADD_MESSAGE', payload: { ...msg, agentId: ceoAgent.id, timestamp: new Date().toISOString() } });
        } catch (err) {
            logger.error('CEO', `生成完成报告异常: ${redactSensitive(err.message)}`);
            this._emitCEOMessage(ceoAgent, [
                `【CEO】📋 项目执行结束，交付物已生成。`,
                `完成 ${completedPhases.size}/${tasks.length} 个阶段。`,
            ], []);
        }

        this.dispatch({ type: 'SET_STATUS', payload: allSucceeded ? 'completed' : 'blocked' });
        // 终态清理运行检查点
        this._clearWorkflowCheckpoint();
        recordTimelineEvent('state_change', {
            agentName: 'CEO',
            detail: allSucceeded ? '项目完成' : '部分失败结束',
        });
        logger.info('CEO', `项目结束：成功 ${completedPhases.size}/${tasks.length}`);
    }

    /**
     * 从 running_execution 检查点恢复（页面刷新后）
     * 支持：已完成阶段跳过 + inFlight 子任务续跑
     */
    async resumeFromExecutionCheckpoint(checkpoint = null) {
        if (this.isRunning) return false;

        const saved = checkpoint || this.getState().workflowCheckpoint;
        if (!saved || saved.type !== 'running_execution') {
            return false;
        }

        const context = this._restoreCheckpointContext(saved);
        if (!context) {
            this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
            this._clearWorkflowCheckpoint();
            return false;
        }

        const { ceoAgent, teamAgents, decomposition, completedPhases, phaseFailures, inFlight: restoredInFlight } = context;
        this._aborted = false;
        this._paused = false;
        this._phaseFailures = Array.isArray(phaseFailures) && phaseFailures.length
            ? [...phaseFailures]
            : (Array.isArray(saved.phaseFailures) ? [...saved.phaseFailures] : []);
        this._pauseBarrier.forceRelease();
        this._beginRunAbortScope();
        this.isRunning = true;

        const executeRecovery = async () => {
            // 原子提升为 running_execution，避免「先清空再执行」的无检查点窗口
            this._promoteGateCheckpointToRunning(saved, {
                ceoAgent,
                teamAgents,
                decomposition,
                completedPhases,
                phaseFailures: this._phaseFailures,
                inFlight: restoredInFlight,
            });

            const summary = summarizeRunningCheckpoint({
                ...saved,
                completedPhases: [...completedPhases],
                inFlight: restoredInFlight,
                phaseFailures: this._phaseFailures,
            }, decomposition);
            this.dispatch({ type: 'SET_STATUS', payload: 'running' });
            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: ceoAgent.id,
                    state: AGENT_STATES.EXECUTING,
                    currentTask: `从检查点恢复：${summary.label}`,
                },
            });
            this._emitCEOMessage(ceoAgent, [
                '【CEO】▶️ 已从检查点恢复执行（阶段 + 子任务级）。',
                `已完成阶段：${completedPhases.size ? [...completedPhases].join('、') : '无'}`,
                ...(summary.inFlightLines.length
                    ? [`进行中：${summary.inFlightLines.join('；')}`]
                    : ['无进行中阶段，将调度剩余阶段。']),
                this._phaseFailures.length
                    ? `历史失败：${this._phaseFailures.map(f => f.phase).join('、')}`
                    : '',
            ].filter(Boolean), ['继续执行剩余工作']);
            recordTimelineEvent('state_change', {
                agentName: 'CEO',
                detail: `检查点恢复：${summary.label}`,
            });

            let activeTeam = this._refreshTeamAgents(teamAgents);

            // 1) 先恢复 inFlight 阶段（含 runningSnapshot 合并结果）
            const inFlight = normalizeInFlight(restoredInFlight);
            for (const flight of inFlight) {
                if (this._aborted) return false;
                if (completedPhases.has(flight.phase)) continue;

                const task = decomposition.tasks.find(t => t.phase === flight.phase);
                if (!task) {
                    this._phaseFailures.push({ phase: flight.phase, reason: '检查点阶段在任务列表中不存在' });
                    continue;
                }

                const agent = activeTeam.find(a => a.id === flight.agentId)
                    || activeTeam.find(a => a.name === flight.agentName || a.name === task.assignee);
                if (!agent) {
                    this._phaseFailures.push({ phase: flight.phase, reason: `找不到负责人 ${task.assignee}` });
                    continue;
                }

                const latestAgent = this._getLatestAgent(agent.id);
                const inferred = inferNextSubtaskIndex(latestAgent, task);
                const startIndex = Math.max(flight.nextSubtaskIndex || 0, inferred);

                this._emitCEOMessage(ceoAgent, [
                    `【CEO】续跑阶段「${flight.phase}」：从子任务 ${startIndex + 1}/${task.subtasks.length || '?'} 继续`,
                ], []);

                const ok = await this._executeAgentPhase(
                    ceoAgent,
                    latestAgent,
                    task,
                    completedPhases,
                    activeTeam,
                    {
                        startIndex,
                        phaseStartedAt: flight.phaseStartedAt || new Date().toISOString(),
                        skipPlanning: startIndex > 0,
                    }
                );

                if (ok && !this._aborted) {
                    completedPhases.add(flight.phase);
                } else if (!this._aborted) {
                    this._phaseFailures.push({
                        phase: flight.phase,
                        reason: '续跑未成功完成',
                    });
                }

                activeTeam = this._refreshTeamAgents(activeTeam);
                this._persistRunningCheckpoint(ceoAgent, activeTeam, decomposition, completedPhases, {
                    removeInFlightPhase: flight.phase,
                });
            }

            if (this._aborted) return false;

            // 2) 再调度其余未完成阶段
            await this._driveExecution(ceoAgent, activeTeam, decomposition, {
                completedPhases,
            });
            return true;
        };

        let outcome = false;
        try {
            outcome = await executeRecovery();
        } catch (err) {
            if (isCancelError(err) || this._aborted) {
                logger.info('CEO', '检查点恢复执行已取消');
            } else {
                logger.error('CEO', `检查点恢复失败: ${err.message}`);
                this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
                this._emitCEOMessage(ceoAgent, [
                    `【CEO】⚠️ 检查点恢复失败：${err.message}`,
                    '请重置后重新发布目标。',
                ], ['重新发布目标']);
            }
        }
        this.isRunning = false;
        return outcome;
    }

    /**
     * 从 store 刷新团队列表，支持暂停期间热重组
     */
    _refreshTeamAgents(teamAgents = []) {
        const state = this.getState();
        const agents = state.agents || [];
        const byId = new Map(agents.map(a => [a.id, a]));
        const refreshed = [];
        const seen = new Set();

        for (const agent of teamAgents) {
            const latest = byId.get(agent.id) || agents.find(a => a.name === agent.name && a.name !== 'CEO');
            if (latest && !seen.has(latest.id)) {
                refreshed.push(latest);
                seen.add(latest.id);
            }
        }

        // 纳入热重组新增的非 CEO 成员
        for (const agent of agents) {
            if (agent.name === 'CEO') continue;
            if (!seen.has(agent.id)) {
                refreshed.push(agent);
                seen.add(agent.id);
            }
        }

        return refreshed;
    }

    hasPendingExecution() {
        return !!this._pendingExecution;
    }

    restorePendingExecution(checkpoint = null) {
        const savedCheckpoint = checkpoint || this.getState().workflowCheckpoint;
        if (!savedCheckpoint || savedCheckpoint.type !== 'waiting_for_config') {
            return false;
        }

        const context = this._restoreCheckpointContext(savedCheckpoint);
        if (!context) return false;
        const { ceoAgent, teamAgents, decomposition } = context;

        this._aborted = false;
        this._paused = false;
        this._pendingExecution = { ceoAgent, teamAgents, decomposition };
        return true;
    }

    _setWorkflowCheckpoint(payload) {
        this.dispatch({ type: 'SET_WORKFLOW_CHECKPOINT', payload });
        this._syncGatewayRun({
            checkpointType: payload?.type || null,
            currentPhase: payload?.currentPhase || null,
            completedPhases: Array.isArray(payload?.completedPhases) ? payload.completedPhases : undefined,
        });
    }

    _syncGatewayRun(patch = {}) {
        const id = this._gatewayRunId || this.getState?.()?.gatewayRunId;
        if (!id || typeof this.dependencies.patchGatewayRun !== 'function') return;
        void Promise.resolve(this.dependencies.patchGatewayRun(id, patch)).catch(() => {});
    }

    _clearWorkflowCheckpoint() {
        this.dispatch({ type: 'CLEAR_WORKFLOW_CHECKPOINT' });
    }

    _restoreCheckpointContext(checkpoint = null) {
        const state = this.getState();
        const savedCheckpoint = checkpoint || state.workflowCheckpoint;
        if (!savedCheckpoint) return null;

        // 合并门禁期间并行写入的 runningSnapshot（不得丢失 completed/inFlight/failures）
        const snap = savedCheckpoint.runningSnapshot && typeof savedCheckpoint.runningSnapshot === 'object'
            ? savedCheckpoint.runningSnapshot
            : null;

        const ceoAgentId = savedCheckpoint.ceoAgentId || snap?.ceoAgentId;
        const ceoAgent = state.agents.find(a => a.id === ceoAgentId)
            || state.agents.find(a => a.name === 'CEO');
        const decomposition = savedCheckpoint.decomposition
            || snap?.decomposition
            || state.decomposition;

        const teamIds = (savedCheckpoint.teamAgentIds?.length
            ? savedCheckpoint.teamAgentIds
            : snap?.teamAgentIds) || [];
        const teamAgents = teamIds
            .map(agentId => state.agents.find(agent => agent.id === agentId))
            .filter(Boolean);

        if (!ceoAgent || !decomposition || teamAgents.length === 0) {
            return null;
        }

        const topCompleted = savedCheckpoint.completedPhases || [];
        const snapCompleted = snap?.completedPhases || [];
        const completedPhases = new Set([...topCompleted, ...snapCompleted]);

        const topFailures = Array.isArray(savedCheckpoint.phaseFailures)
            ? savedCheckpoint.phaseFailures
            : [];
        const snapFailures = Array.isArray(snap?.phaseFailures) ? snap.phaseFailures : [];
        const phaseFailures = [...topFailures];
        for (const f of snapFailures) {
            if (!phaseFailures.some(x => x.phase === f.phase)) phaseFailures.push(f);
        }

        const topInFlight = normalizeInFlight(savedCheckpoint.inFlight);
        const snapInFlight = normalizeInFlight(snap?.inFlight);
        // snap 更新更新，同 phase 以 snap 为准
        let inFlight = topInFlight;
        for (const item of snapInFlight) {
            inFlight = upsertInFlight(inFlight, item);
        }

        return {
            state,
            ceoAgent,
            decomposition,
            teamAgents,
            completedPhases,
            phaseFailures,
            inFlight,
            checkpoint: savedCheckpoint,
        };
    }

    /**
     * 将门禁检查点原子提升为 running_execution（避免清空后无检查点窗口）
     */
    _promoteGateCheckpointToRunning(checkpoint, context, extras = {}) {
        const payload = buildRunningExecutionCheckpoint({
            ceoAgentId: context.ceoAgent.id,
            teamAgentIds: context.teamAgents.map(a => a.id),
            decomposition: context.decomposition,
            completedPhases: [...(context.completedPhases ?? [])],
            phaseFailures: context.phaseFailures ?? this._phaseFailures,
            inFlight: extras.inFlight ?? context.inFlight ?? [],
            existing: null,
        });
        // 保留原门禁元数据便于审计
        payload.promotedFrom = checkpoint?.type || null;
        payload.promotedAt = new Date().toISOString();
        const snap = checkpoint?.runningSnapshot;
        // runningSnapshot 已由恢复上下文合并到顶层。
        if (snap && Object.keys(snap).length) {
            // 已合并进顶层，不再嵌套
        }
        this._setWorkflowCheckpoint(payload);
        return payload;
    }

    /**
     * 执行单个 Agent 的任务阶段
     * @param {object} [options]
     * @param {number} [options.startIndex] 从第几个子任务开始
     * @param {string} [options.phaseStartedAt]
     * @param {boolean} [options.skipPlanning] 续跑时跳过规划动画
     * @returns {Promise<boolean>} 是否成功完成（含 QA）
     */
    async _executeAgentPhase(ceoAgent, agent, task, completedPhases, teamAgents, options = {}) {
        const agentId = agent.id;
        const phaseStartedAt = options.phaseStartedAt || new Date().toISOString();
        let startIndex = Math.max(0, options.startIndex || 0);
        const skipPlanning = options.skipPlanning || startIndex > 0;

        try {
            if (this._aborted) return false;

            // 幂等：按 outputs 对齐 startIndex
            const latestForInfer = this._getLatestAgent(agentId);
            startIndex = Math.max(startIndex, inferNextSubtaskIndex(latestForInfer, task));

            // 标记阶段进入 inFlight
            this._persistRunningCheckpoint(
                ceoAgent,
                teamAgents,
                this.getState().decomposition || { tasks: [task] },
                completedPhases,
                {
                    upsertInFlight: {
                        phase: task.phase,
                        agentId,
                        agentName: agent.name,
                        nextSubtaskIndex: startIndex,
                        phaseStartedAt,
                        totalSubtasks: task.subtasks.length,
                        currentSubtask: task.subtasks[startIndex] || '',
                    },
                }
            );

            // 检查前置等待（UI 提示；依赖已在调度层保证）
            if (!skipPlanning && (task.dependencies || []).length > 0) {
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
                if (this._aborted) return false;
            }

            // 规划阶段（续跑跳过）
            if (!skipPlanning) {
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
                if (this._aborted) return false;
            }

            const success = await this._runRemainingSubtasks(
                ceoAgent, agent, task, completedPhases, teamAgents, startIndex, phaseStartedAt
            );
            if (!success || this._aborted) return false;

            const finalized = await this._finalizeAgentPhase(
                ceoAgent, agent, task, completedPhases, teamAgents, phaseStartedAt
            );
            if (!finalized || this._aborted) {
                this._persistRunningCheckpoint(
                    ceoAgent,
                    teamAgents,
                    this.getState().decomposition,
                    completedPhases,
                    { removeInFlightPhase: task.phase }
                );
                return false;
            }

            // 阶段完成：移出 inFlight
            this._persistRunningCheckpoint(
                ceoAgent,
                teamAgents,
                this.getState().decomposition,
                completedPhases,
                { removeInFlightPhase: task.phase }
            );
            return true;
        } catch (err) {
            logger.error('CEO', `执行阶段「${task.phase}」失败: ${err.message}`);
            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: agentId,
                    state: AGENT_STATES.BLOCKED,
                    currentTask: `阶段失败：${task.phase}`,
                },
            });
            return false;
        }
    }

    async _runRemainingSubtasks(ceoAgent, agent, task, completedPhases, teamAgents, startIndex = 0, phaseStartedAt = new Date().toISOString()) {
        const agentId = agent.id;
        const subtasks = task.subtasks;
        const decomposition = this.getState().decomposition;

        for (let i = startIndex; i < subtasks.length; i++) {
            if (this._aborted) return false;

            const subtask = subtasks[i];
            const subtaskProgress = (i + 1) / Math.max(subtasks.length, 1);

            // 幂等：已有产出则跳过（避免刷新后重复烧 token）
            const latestAgent = this._getLatestAgent(agentId);
            if (isSubtaskOutputPresent(latestAgent, task.phase, subtask)) {
                this._emitAgentMessage(agent, [
                    `【${agent.name}】⏭ 子任务已有产出，跳过：${subtask}`,
                ], [], 'checkpoint-skip');
                this._persistRunningCheckpoint(ceoAgent, teamAgents, decomposition, completedPhases, {
                    upsertInFlight: {
                        phase: task.phase,
                        agentId,
                        agentName: agent.name,
                        nextSubtaskIndex: i + 1,
                        phaseStartedAt,
                        totalSubtasks: subtasks.length,
                        currentSubtask: subtask,
                    },
                });
                continue;
            }

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

            // 开始执行前写入进度（刷新后可从当前子任务续）
            this._persistRunningCheckpoint(ceoAgent, teamAgents, decomposition, completedPhases, {
                upsertInFlight: {
                    phase: task.phase,
                    agentId,
                    agentName: agent.name,
                    nextSubtaskIndex: i,
                    phaseStartedAt,
                    totalSubtasks: subtasks.length,
                    currentSubtask: subtask,
                },
            });

            // ★ HITL 前置门禁：敏感操作在执行前拦截，并串行化全局人工闸门
            let humanAssistContext = '';
            const needsHumanIntervention = await this._checkHumanInterventionNeeded(agent, subtask);
            if (this._aborted) return false;

            if (needsHumanIntervention) {
                recordTimelineEvent('decision', {
                    agentName: agent.name,
                    detail: `请求人工协助：${subtask}`,
                });
                let humanResult;
                try {
                    const gateEpoch = this._userGate.epoch();
                    humanResult = await this._userGate.runExclusive(
                        () => this._requestHumanIntervention(agent, subtask, {
                            ceoAgentId: ceoAgent.id,
                            teamAgentIds: teamAgents.map(teamAgent => teamAgent.id),
                            decomposition: this.getState().decomposition || null,
                            completedPhases: [...completedPhases],
                            currentPhase: task.phase,
                            currentAgentId: agent.id,
                            currentSubtaskIndex: i,
                            currentSubtask: subtask,
                            phaseStartedAt,
                            inFlight: [{
                                phase: task.phase,
                                agentId,
                                agentName: agent.name,
                                nextSubtaskIndex: i,
                                phaseStartedAt,
                                totalSubtasks: subtasks.length,
                                currentSubtask: subtask,
                            }],
                        }),
                        {
                            expectedEpoch: gateEpoch,
                            isAlive: () => !this._aborted,
                        }
                    );
                } catch (gateErr) {
                    if (gateErr?.code === ABORT_REASON.GATE_CANCELLED || this._aborted) {
                        return false;
                    }
                    throw gateErr;
                }

                if (
                    humanResult === ABORT_REASON.TIMEOUT_ABORT
                    || humanResult === ABORT_REASON.STOPPED
                    || humanResult === ABORT_REASON.RESET
                    || humanResult === ABORT_REASON.GATE_CANCELLED
                    || this._aborted
                ) {
                    return false;
                }

                if (humanResult === 'FORCE_CONTINUE' || humanResult === 'SKIPPED_BY_USER' || humanResult === 'TIMEOUT_SKIP') {
                    // 显式跳过：不计入成功，阶段失败
                    this._emitAgentMessage(agent, [
                        `【${agent.name}】子任务被显式跳过：${subtask}（不计为成功）`,
                    ], [], 'skipped');
                    this.dispatch({
                        type: 'UPDATE_AGENT_OUTPUTS',
                        payload: {
                            id: agentId,
                            output: {
                                phase: task.phase,
                                subtask,
                                content: `（已跳过：${humanResult}）`,
                                source: 'skipped',
                                status: STEP_STATUS.SKIPPED,
                            },
                        },
                    });
                    return false;
                }
                if (humanResult) {
                    humanAssistContext = buildSafeHumanAssistContext(humanResult, subtask);
                }
            }

            const streamClientId = uuidv4();
            let liveBuffer = '';
            const result = await this._executeSubtask(
                agent,
                subtask,
                subtaskProgress,
                (token) => {
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
                },
                humanAssistContext
            );

            if (this._aborted) return false;

            const normalized = normalizeSubtaskResult(result);
            // 模板/失败产出不得当作成功继续
            if (!isSuccessStatus(normalized.status) && normalized.status !== STEP_STATUS.SKIPPED) {
                this._emitAgentMessage(agent, [
                    `【${agent.name}】❌ 子任务失败：${subtask}`,
                    normalized.reason || `来源=${normalized.source}，状态=${statusLabel(normalized.status)}`,
                ], [], 'failed');
                this.dispatch({
                    type: 'UPDATE_AGENT_OUTPUTS',
                    payload: {
                        id: agentId,
                        output: {
                            phase: task.phase,
                            subtask,
                            content: normalized.content || normalized.reason || '（失败）',
                            source: normalized.source,
                            status: normalized.status,
                        },
                    },
                });
                return false;
            }

            // 存储实质产出（仅 success）
            this.dispatch({
                type: 'UPDATE_AGENT_OUTPUTS',
                payload: {
                    id: agentId,
                    output: {
                        phase: task.phase,
                        subtask,
                        content: normalized.content,
                        source: normalized.source,
                        status: normalized.status,
                    },
                },
            });

            this._emitAgentMessage(agent,
                normalized.summary,
                i < subtasks.length - 1
                    ? [`继续执行：${subtasks[i + 1]}`]
                    : ['进入审核阶段'],
                normalized.source,
                streamClientId,
                normalized.content
            );

            // 子任务完成后推进 nextSubtaskIndex
            this._persistRunningCheckpoint(ceoAgent, teamAgents, decomposition, completedPhases, {
                upsertInFlight: {
                    phase: task.phase,
                    agentId,
                    agentName: agent.name,
                    nextSubtaskIndex: i + 1,
                    phaseStartedAt,
                    totalSubtasks: subtasks.length,
                    currentSubtask: subtask,
                },
            });

            await this._delay(1500 + Math.random() * 1000);
            if (this._aborted) return false;

            this._emitAgentMessage(agent,
                DIALOGUE_TEMPLATES.subtaskComplete(agent.name, subtask),
                []
            );
        }

        return true;
    }

    /**
     * 阶段收尾：QA 必须 pass 才算完成
     * @returns {Promise<boolean>}
     */
    async _finalizeAgentPhase(ceoAgent, agent, task, completedPhases, teamAgents, phaseStartedAt = new Date().toISOString()) {
        const agentId = agent.id;

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

        const qaReview = await this._runPhaseQualityGate(ceoAgent, agent, task);
        const phaseContent = qaReview.finalContent || this._buildPhaseOutput(agent, task);

        // QA 未通过：不得标记 COMPLETED，不得解锁下游
        if (qaReview.result !== 'pass') {
            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: agentId,
                    state: AGENT_STATES.BLOCKED,
                    currentTask: `${task.phase} - QA 未通过`,
                    progress: 0.9,
                },
            });
            this._emitCEOMessage(ceoAgent, [
                `【CEO】❌ 「${task.phase}」质量门未通过，阶段不计为完成。`,
                qaReview.suggestion
                    ? `原因：${qaReview.suggestion}`
                    : '请修订产出或重置后重试。',
            ], ['阶段阻塞']);
            recordTimelineEvent('qa_review', {
                agentName: agent.name,
                detail: `${task.phase} — QA 未通过`,
            });
            this._recordPhasePerformance(agent, task, phaseStartedAt, qaReview, phaseContent);
            this._phaseResults[task.phase] = {
                status: STEP_STATUS.FAILED,
                qa: qaReview.result,
                reason: qaReview.suggestion || 'QA 未通过',
            };
            return false;
        }

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

        this._recordPhasePerformance(agent, task, phaseStartedAt, qaReview, phaseContent);
        this._phaseResults[task.phase] = {
            status: STEP_STATUS.SUCCESS,
            qa: 'pass',
        };

        // 持久化阶段经验，供后续会话注入
        try {
            const experience = (phaseContent || '').slice(0, 400).replace(/\s+/g, ' ');
            if (experience) {
                this.dependencies.saveMemory(agent.name, task.phase, experience);
            }
        } catch (e) {
            logger.warn('Memory', `保存记忆失败: ${e.message}`);
        }

        this._emitCEOMessage(ceoAgent, [
            `【CEO】收到 ${agent.name} 报告：「${task.phase}」阶段已完成 ✅`,
            '质量结论：QA 通过',
        ], []);
        recordTimelineEvent('qa_review', {
            agentName: agent.name,
            detail: `${task.phase} — QA 通过`,
        });

        // ★ 阶段完成后，与下游依赖的 Agent 进行多轮协作共识
        const state = this.getState();
        const allTasks = state.decomposition?.tasks ?? [];
        const downstreamTasks = allTasks.filter(t =>
            t.dependencies.includes(task.phase)
        );
        for (const downTask of downstreamTasks) {
            if (this._aborted) return false;
            const downAgent = state.agents.find(a => a.name === downTask.assignee);
            if (!downAgent || downAgent.id === agentId) continue;
            await this._conductCollaboration(ceoAgent, agent, downAgent, task.phase, 3, {
                ceoAgentId: ceoAgent.id,
                teamAgentIds: teamAgents.map(teamAgent => teamAgent.id),
                decomposition: state.decomposition,
                completedPhases: [...completedPhases],
                currentPhase: task.phase,
            });
            if (this._aborted) return false;
        }

        await this._delay(800);
        return true;
    }

    /**
     * 等待董事长的人工协助（如扫码/验证码等）
     * 调用方须通过 _humanGate 串行化，保证同一时刻仅一个挂起回调
     */
    async _requestHumanIntervention(agent, currentSubtask, checkpointPayload = null) {
        const { generation: gen, gateId } = this._captureGateToken();
        return new Promise(resolve => {
            if (this._gateInvalidated(gen)) {
                resolve(ABORT_REASON.GATE_CANCELLED);
                return;
            }

            const state = this.getState();
            const ceoAgent = state.agents.find(a => a.name === 'CEO');

            const cleanupTimers = (timers) => {
                timers.forEach(t => clearTimeout(t));
            };
            const localTimers = [];

            const finish = (value) => {
                if (this._pendingHumanInput !== finish) return;
                this._pendingHumanInput = null;
                cleanupTimers(localTimers);
                resolve(value);
            };

            this._pendingHumanInput = finish;
            // 赋值后再校验 generation，防止 stop 夹在检查与赋值之间
            if (this._gateInvalidated(gen)) {
                this._pendingHumanInput = null;
                cleanupTimers(localTimers);
                resolve(ABORT_REASON.GATE_CANCELLED);
                return;
            }

            const rollbackGate = () => {
                this._pendingHumanInput = null;
                try {
                    this._rollbackOwnedGateCompat(gateId, 'waiting_for_human');
                } catch (_) { /* ignore */ }
                cleanupTimers(localTimers);
                resolve(ABORT_REASON.GATE_CANCELLED);
            };

            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: agent.id,
                    state: AGENT_STATES.WAITING,
                    currentTask: `等待董事长协助：${currentSubtask}`,
                },
            });

            if (ceoAgent) {
                this.dispatch({
                    type: 'UPDATE_AGENT',
                    payload: {
                        id: ceoAgent.id,
                        state: AGENT_STATES.WAITING,
                        currentTask: `等待董事长协助 ${agent.name}`,
                    },
                });
            }

            if (this._gateInvalidated(gen)) {
                rollbackGate();
                return;
            }

            this.dispatch({ type: 'SET_STATUS', payload: 'waiting_for_human' });
            if (this._gateInvalidated(gen)) {
                rollbackGate();
                return;
            }

            if (checkpointPayload) {
                this._setWorkflowCheckpoint({
                    type: 'waiting_for_human',
                    ...checkpointPayload,
                    gateId,
                    gateGeneration: gen,
                    createdAt: new Date().toISOString(),
                });
            }
            if (this._gateInvalidated(gen)) {
                rollbackGate();
                return;
            }

            const highRisk = isHighRiskHumanTask(currentSubtask);
            if (ceoAgent) {
                this._emitCEOMessage(ceoAgent, [
                    `【CEO】🚨 遇到需要董事长协助的步骤！`,
                    `团队成员 ${agent.name} 在执行「${currentSubtask}」时被拦截（执行前安全门禁）。`,
                    highRisk
                        ? '本步骤涉及登录/支付/授权等敏感操作：验证码与凭据不会写入对话或 Prompt 原文。请确认已在外部完成操作后输入简要确认（如「已完成」），或显式点击跳过（将标记为跳过而非成功）。'
                        : '请董事长在上方输入框提供协助信息，然后点击继续。敏感内容将被脱敏。',
                ], ['等待董事长输入协助内容', '恢复团队执行']);
            }

            // 2 分钟提醒
            const warnTimer = setTimeout(() => {
                if (!this._pendingHumanInput || !ceoAgent) return;
                this._emitCEOMessage(ceoAgent, [
                    '【CEO】⏳ 等待协助已超过 2 分钟。',
                    '您可以提供确认信息，或点击“跳过此步”（将记为 skipped，不计为成功）。',
                    highRisk
                        ? '高风险步骤不会自动跳过，须人工确认或显式跳过。'
                        : '系统不会自动放行敏感步骤。',
                ], []);
            }, HUMAN_INTERVENTION_WARN_MS);
            localTimers.push(warnTimer);
            this.timers.push(warnTimer);

            // 超时仅升级告警，不再自动 skip（fail-closed）
            const escalateTimer = setTimeout(() => {
                if (!this._pendingHumanInput || !ceoAgent) return;
                this._emitCEOMessage(ceoAgent, [
                    '【CEO】⏰ 人工协助等待已超过 10 分钟，流程仍处于阻塞等待。',
                    '请确认协助、显式跳过该步，或重置任务。系统不会自动跳过。',
                ], ['提供协助', '跳过此步', '重置']);
            }, HUMAN_INTERVENTION_ESCALATE_MS);
            localTimers.push(escalateTimer);
            this.timers.push(escalateTimer);
        });
    }

    /**
     * 提供董事长的人工干预输入，系统恢复
     * 注意：不得先清空 _pendingHumanInput，finish 回调内部会做身份校验
     */
    provideHumanInput(input) {
        if (typeof this._pendingHumanInput === 'function') {
            const state = this.getState();
            const ceoAgent = state.agents.find(a => a.name === 'CEO');
            const cp = state.workflowCheckpoint;
            const subtask = cp?.currentSubtask || '';
            const publicMsg = buildHumanAssistPublicMessage(input, subtask);

            // 先原子提升检查点，再恢复内存链（禁止 clear 后 LLM 窗口）
            if (cp?.type === 'waiting_for_human' || cp?.type === 'waiting_for_decision') {
                const ctx = this._restoreCheckpointContext(cp);
                if (ctx) {
                    this._promoteGateCheckpointToRunning(cp, {
                        ceoAgent: ctx.ceoAgent,
                        teamAgents: ctx.teamAgents,
                        decomposition: ctx.decomposition,
                        completedPhases: ctx.completedPhases,
                        phaseFailures: ctx.phaseFailures || this._phaseFailures,
                        inFlight: ctx.inFlight,
                    });
                }
            }

            this.dispatch({ type: 'SET_STATUS', payload: 'running' });

            if (ceoAgent) {
                this.dispatch({
                    type: 'UPDATE_AGENT',
                    payload: {
                        id: ceoAgent.id,
                        state: AGENT_STATES.EXECUTING,
                        currentTask: '协调协作，驱动执行',
                    },
                });

                this._emitCEOMessage(ceoAgent, [
                    `【CEO】✅ ${publicMsg}`,
                    '通知团队恢复执行！',
                ], ['继续调度后续阶段']);
            }

            this._pendingHumanInput(input);
            return;
        }

        const checkpoint = this.getState().workflowCheckpoint;
        if (checkpoint?.type === 'waiting_for_human') {
            void this._resumeAfterHumanIntervention(checkpoint, input, { skipped: false });
        }
    }

    /**
     * 跳过当前人工协助步骤，继续执行
     */
    skipHumanInput(reason = 'SKIPPED_BY_USER') {
        if (typeof this._pendingHumanInput === 'function') {
            const state = this.getState();
            const ceoAgent = state.agents.find(a => a.name === 'CEO');
            // 跳过 = 失败路径：可清空门禁；不进入 running LLM
            this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
            this._clearWorkflowCheckpoint();
            if (ceoAgent) {
                this.dispatch({
                    type: 'UPDATE_AGENT',
                    payload: {
                        id: ceoAgent.id,
                        state: AGENT_STATES.BLOCKED,
                        currentTask: '人工步骤已跳过',
                    },
                });

                this._emitCEOMessage(ceoAgent, [
                    `【CEO】已按董事长指示跳过当前人工协助步骤（原因：${reason}），不计为成功。`,
                ], []);
            }

            this._pendingHumanInput(reason);
            return;
        }

        const checkpoint = this.getState().workflowCheckpoint;
        if (checkpoint?.type === 'waiting_for_human') {
            void this._resumeAfterHumanIntervention(checkpoint, reason, { skipped: true });
        }
    }

    async _resumeAfterHumanIntervention(checkpoint, input, { skipped = false } = {}) {
        const context = this._restoreCheckpointContext(checkpoint);
        const state = this.getState();
        const ceoAgent = context?.ceoAgent || state.agents.find(a => a.name === 'CEO');
        const failRecovery = (reason) => {
            this._clearWorkflowCheckpoint();
            this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
            if (ceoAgent) {
                this.dispatch({
                    type: 'UPDATE_AGENT',
                    payload: {
                        id: ceoAgent.id,
                        state: AGENT_STATES.BLOCKED,
                        currentTask: '人工协助恢复失败',
                    },
                });
                this._emitCEOMessage(ceoAgent, [
                    `【CEO】⚠️ ${reason}`,
                    '请重新发布目标启动新的执行流程。',
                ], ['重新发布目标']);
            }
        };

        if (!context) {
            failRecovery('未找到可恢复的人工协助上下文。');
            return;
        }

        const { decomposition, teamAgents, completedPhases } = context;
        const agent = state.agents.find(a => a.id === checkpoint.currentAgentId);
        const task = decomposition.tasks.find(t => t.phase === checkpoint.currentPhase);
        const interruptedSubtask = checkpoint.currentSubtask || task?.subtasks?.[checkpoint.currentSubtaskIndex];

        if (!agent || !task || !interruptedSubtask) {
            failRecovery('人工协助恢复时缺少必要的阶段信息。');
            return;
        }

        if (this.isRunning) {
            // 已有内存中的执行链在等待，优先走 provideHumanInput 路径
            logger.warn('CEO', '恢复人工协助时发现 runner 仍在运行，忽略重复恢复');
            return;
        }

        this._aborted = false;
        this._paused = false;
        this._pauseBarrier.forceRelease();
        this._beginRunAbortScope();
        this.isRunning = true;

        try {
            this.dispatch({ type: 'SET_STATUS', payload: 'running' });
            // 原子提升：合并 runningSnapshot，不先清空（避免刷新窗口丢检查点）
            this._phaseFailures = Array.isArray(context.phaseFailures)
                ? [...context.phaseFailures]
                : (this._phaseFailures || []);
            this._promoteGateCheckpointToRunning(checkpoint, {
                ceoAgent,
                teamAgents,
                decomposition,
                completedPhases,
                phaseFailures: this._phaseFailures,
                inFlight: context.inFlight || [],
            });

            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: ceoAgent.id,
                    state: AGENT_STATES.EXECUTING,
                    currentTask: skipped ? '跳过人工步骤，继续执行' : '协调协作，驱动执行',
                },
            });
            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: agent.id,
                    state: AGENT_STATES.EXECUTING,
                    currentTask: interruptedSubtask,
                    currentSubtaskIndex: checkpoint.currentSubtaskIndex,
                },
            });

            this._emitCEOMessage(ceoAgent, [
                skipped
                    ? `【CEO】已按董事长指示跳过当前人工协助步骤（将记为未成功），流程阻塞。`
                    : `【CEO】✅ ${buildHumanAssistPublicMessage(input, interruptedSubtask)}`,
                skipped ? '跳过不计为成功。' : '通知团队恢复执行！',
            ], ['继续调度后续阶段']);

            await this._delay(300);
            if (this._aborted) return;

            // HITL 前置后：中断点处的子任务尚未执行，应从当前 index 重新执行
            const resumeIndex = checkpoint.currentSubtaskIndex ?? 0;
            const activeTeam = this._refreshTeamAgents(teamAgents);

            // 将人工输入以脱敏安全上下文注入（不得原样传验证码）
            if (!skipped && input) {
                const humanAssistContext = buildSafeHumanAssistContext(input, interruptedSubtask);
                const streamClientId = uuidv4();
                let liveBuffer = '';
                const result = await this._executeSubtask(
                    agent,
                    interruptedSubtask,
                    (resumeIndex + 1) / Math.max((task.subtasks || []).length, 1),
                    (token) => {
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
                    },
                    humanAssistContext
                );
                if (this._aborted) return;

                const normalized = normalizeSubtaskResult(result);
                if (!isSuccessStatus(normalized.status)) {
                    this.dispatch({
                        type: 'UPDATE_AGENT_OUTPUTS',
                        payload: {
                            id: agent.id,
                            output: {
                                phase: task.phase,
                                subtask: interruptedSubtask,
                                content: normalized.content || normalized.reason || '（失败）',
                                source: normalized.source,
                                status: normalized.status,
                            },
                        },
                    });
                    this._emitAgentMessage(agent, [
                        `【${agent.name}】❌ 恢复执行子任务失败：${interruptedSubtask}`,
                        normalized.reason || statusLabel(normalized.status),
                    ], [], 'failed');
                    this._phaseFailures.push({
                        phase: task.phase,
                        reason: normalized.reason || '冷恢复子任务失败',
                    });
                    this.dispatch({
                        type: 'UPDATE_AGENT',
                        payload: {
                            id: agent.id,
                            state: AGENT_STATES.BLOCKED,
                            currentTask: `${task.phase} - 恢复失败`,
                        },
                    });
                    this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
                    return;
                }

                this.dispatch({
                    type: 'UPDATE_AGENT_OUTPUTS',
                    payload: {
                        id: agent.id,
                        output: {
                            phase: task.phase,
                            subtask: interruptedSubtask,
                            content: normalized.content,
                            source: normalized.source,
                            status: normalized.status,
                        },
                    },
                });
                this._emitAgentMessage(
                    agent,
                    normalized.summary,
                    [],
                    normalized.source,
                    streamClientId,
                    normalized.content
                );
            } else if (skipped) {
                // 显式跳过：阶段不计成功
                this._phaseFailures.push({
                    phase: task.phase,
                    reason: `人工跳过：${input || 'SKIPPED'}`,
                });
                this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
                return;
            }

            const success = await this._runRemainingSubtasks(
                ceoAgent,
                agent,
                task,
                completedPhases,
                activeTeam,
                resumeIndex + 1,
                checkpoint.phaseStartedAt || new Date().toISOString()
            );
            if (!success || this._aborted) {
                if (!this._aborted) {
                    this._phaseFailures.push({
                        phase: task.phase,
                        reason: '恢复后续子任务失败',
                    });
                    this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
                }
                return;
            }

            const finalized = await this._finalizeAgentPhase(
                ceoAgent,
                agent,
                task,
                completedPhases,
                activeTeam,
                checkpoint.phaseStartedAt || new Date().toISOString()
            );
            if (this._aborted) return;
            if (!finalized) {
                this._phaseFailures.push({
                    phase: task.phase,
                    reason: '恢复后 QA 未通过',
                });
                this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
                return;
            }

            // 仅在 finalize 成功后标记完成
            completedPhases.add(task.phase);
            await this._driveExecution(ceoAgent, activeTeam, decomposition, { completedPhases });
        } catch (err) {
            logger.error('CEO', `人工协助恢复异常: ${err.message}`);
            failRecovery(err.message);
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * 发送 CEO 结构化消息（对话边界统一脱敏）
     */
    _emitCEOMessage(ceoAgent, dialogue, nextStep) {
        const updatedAgent = this._getLatestAgent(ceoAgent.id);
        const safeDialogue = (dialogue || []).map(line => redactSensitive(String(line ?? '')));
        const safeNext = (nextStep || []).map(line => redactSensitive(String(line ?? '')));
        const msg = createStructuredMessage(
            updatedAgent || ceoAgent,
            safeDialogue,
            safeNext
        );
        // current_task 也可能含用户目标片段
        if (msg.current_task) {
            msg.current_task = redactSensitive(String(msg.current_task));
        }
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
     * @param {string} [humanAssistContext] 董事长提供的人工协助信息（HITL 前置通过后注入）
     */
    async _executeSubtask(agent, subtask, progress, onStream, humanAssistContext = '') {
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
        const capabilityQuery = [currentObjective, subtask, prevOutputs].filter(Boolean).join('\n');
        const capabilities = await this.dependencies.loadExecutionCapabilities(capabilityQuery);
        const toolLoopEnabled = this.dependencies.shouldUseToolLoop(`${currentObjective}\n${subtask}`, capabilities);

        // 注入 Agent 记忆上下文
        const memoryContext = this.dependencies.formatMemoryContext(agent.name);

        const systemPrompt = [
            `你是团队成员「${agent.name}」，角色：${agent.role}。`,
            `当前项目目标：「${currentObjective}」`,
            sessionContext ? `\n### 项目背景与上下文\n${sessionContext}\n` : '',
            capabilities.ragContext,
            memoryContext,
            toolLoopEnabled ? capabilities.toolPrompt : '',
            '你正在执行一个具体的工作子任务。请直接输出实质性工作成果。',
            '要求：Markdown 格式，200-500 字中文，具体可用，不是概述。',
            '重要：请结合以上项目背景和上下文来理解当前任务，不要脱离上下文给出泛泛的通用回答。',
            humanAssistContext
                ? `\n### 董事长人工协助（已脱敏）\n${humanAssistContext}\n不要复述任何验证码、密码或 Token。`
                : '',
        ].filter(Boolean).join('\n');

        const userPrompt = [
            `当前子任务：「${subtask}」`,
            `整体进度：${(progress * 100).toFixed(0)}%`,
            prevOutputs ? `\n已有产出：\n${prevOutputs}` : '',
            humanAssistContext ? `\n人工协助状态：${humanAssistContext}` : '',
            '\n请直接输出该子任务的工作成果：',
        ].join('\n');

        try {
            const model = agent.model || state.defaultModel || '';
            if (!model) {
                return normalizeSubtaskResult({
                    status: STEP_STATUS.FAILED,
                    source: 'config',
                    content: '',
                    summary: [`【${agent.name}】未配置模型，无法执行：${subtask}`],
                    reason: 'Agent 未配置模型',
                });
            }
            const baseMessages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ];
            const content = toolLoopEnabled
                ? await this._runToolAssistedSubtask(agent, {
                    model,
                    availableModels,
                    messages: baseMessages,
                    userPrompt,
                    subtask,
                    capabilities,
                }, onStream)
                : await this._callLLMWithRetry({
                    model,
                    messages: baseMessages,
                    availableModels,
                    agentName: agent.name,
                    dispatch: this.dispatch,
                    stream: true,
                    onToken: (t) => onStream && onStream(t),
                });

            if (content && String(content).trim()) {
                return this._buildSubtaskResult(agent, subtask, content, 'llm');
            }
            return normalizeSubtaskResult({
                status: STEP_STATUS.FAILED,
                source: 'llm',
                content: '',
                summary: [`【${agent.name}】LLM 返回空内容：${subtask}`],
                reason: '空响应',
            });
        } catch (e) {
            if (isCancelError(e) || this._aborted) {
                return normalizeSubtaskResult({
                    status: STEP_STATUS.BLOCKED,
                    source: 'cancelled',
                    content: '',
                    summary: [`【${agent.name}】执行已取消：${subtask}`],
                    reason: e.message,
                });
            }
            logger.warn('LLM', `子任务执行失败：${subtask} - ${e.message}`);
            return normalizeSubtaskResult({
                status: STEP_STATUS.FAILED,
                source: 'llm-error',
                content: '',
                summary: [`【${agent.name}】执行失败：${subtask}`, e.message],
                reason: e.message,
            });
        }
    }

    _buildSubtaskResult(agent, subtask, content, source = 'llm') {
        const safeContent = redactSensitive(content || '');
        const lines = safeContent.split('\n').filter(Boolean);
        const summaryLines = [
            `【${agent.name}】已完成：${subtask}`,
            lines[0] ? `📄 ${lines[0].replace(/^#+\s*/, '').slice(0, 80)}...` : '',
        ].filter(Boolean);

        this.dispatch({
            type: 'UPDATE_AGENT_HISTORY',
            payload: {
                id: agent.id,
                entry: { role: 'assistant', content: redactSensitive(`[${subtask}] ${safeContent.slice(0, 300)}`) },
            },
        });

        return normalizeSubtaskResult({
            status: STEP_STATUS.SUCCESS,
            source,
            content: safeContent,
            summary: summaryLines,
        });
    }

    async _runToolAssistedSubtask(agent, request, onStream) {
        const initialResponse = await this._callLLMWithRetry({
            model: request.model,
            messages: request.messages,
            availableModels: request.availableModels,
            agentName: agent.name,
            dispatch: this.dispatch,
        });
        const toolCalls = this.dependencies.parseToolCalls(initialResponse || '').slice(0, 3);
        if (toolCalls.length === 0) {
            return initialResponse;
        }

        const toolBlocks = [];
        const policy = request.capabilities.policy || DEFAULT_TOOL_POLICY;
        const toolFailures = [];
        for (const call of toolCalls) {
            const toolLabel = this.dependencies.summarizeToolCall(call.tool, call.params || {});
            this._emitAgentMessage(agent, [
                `【${agent.name}】调用工具：${redactSensitive(toolLabel)}`,
            ], [], 'tool_call');

            const toolResult = await this.dependencies.executeCapabilityTool(
                request.capabilities.toolMap,
                call.tool,
                call.params || {},
                policy
            );
            // 类型化结果：任何失败不得继续包装为成功交付
            if (!toolResult || toolResult.ok !== true) {
                const errText = toolResult?.error || '工具调用失败';
                toolFailures.push({ tool: call.tool, error: errText, status: toolResult?.status });
                this._emitAgentMessage(agent, [
                    `【工具失败】${call.tool}`,
                    redactSensitive(errText),
                ], [], 'tool_error');
                continue;
            }
            const toolResultText = toolResult.data || '';
            const preview = toolResultText.length > 240
                ? `${toolResultText.slice(0, 240)}...`
                : toolResultText;
            this._emitAgentMessage(agent, [
                `【工具结果】${call.tool}`,
                preview,
            ], [], 'tool_call');

            toolBlocks.push([
                `工具：${call.tool}`,
                `参数：${redactSensitive(JSON.stringify(call.params || {}))}`,
                `结果：\n${toolResultText}`,
            ].join('\n'));
        }

        // 任一工具失败：子任务直接失败，不得用 LLM 包装成成功交付
        if (toolFailures.length > 0) {
            const detail = toolFailures.map(f => `${f.tool}: ${f.error}`).join('; ');
            throw new Error(`工具调用失败，子任务中止：${detail}`);
        }
        const finalSystemPrompt = [
            request.messages[0].content,
            '你已经拿到工具返回结果。现在请直接输出最终工作成果，不要再输出 tool_call 代码块。',
            '若工具结果不足，明确说明限制，不要编造外部事实。',
        ].join('\n');
        const finalUserPrompt = [
            request.userPrompt,
            '',
            '以下是工具返回结果：',
            ...toolBlocks.map((block, index) => `### 工具结果 ${index + 1}\n${block}`),
            '',
            '请基于这些结果直接输出最终工作成果。',
        ].join('\n');

        return await this._callLLMWithRetry({
            model: request.model,
            messages: [
                { role: 'system', content: finalSystemPrompt },
                { role: 'user', content: finalUserPrompt },
            ],
            availableModels: request.availableModels,
            agentName: agent.name,
            dispatch: this.dispatch,
            stream: true,
            onToken: (t) => onStream && onStream(t),
        });
    }

    _getPhaseOutputs(agent, task) {
        const latestAgent = this._getLatestAgent(agent.id) || agent;
        const outputs = latestAgent.outputs || [];
        return outputs.filter(output =>
            output.phase === task.phase || task.subtasks.includes(output.subtask)
        );
    }

    _buildPhaseOutput(agent, task) {
        const outputs = this._getPhaseOutputs(agent, task);
        if (outputs.length === 0) return '';

        return outputs
            .map((output, index) => {
                const title = output.subtask || `${task.phase}-${index + 1}`;
                return `### ${title}\n${output.content || '（空）'}`;
            })
            .join('\n\n')
            .trim();
    }

    _collectPhaseMetrics(agentName, phaseStartedAt) {
        const phaseStart = Date.parse(phaseStartedAt || '') || 0;
        const promptLogs = this.getState().promptLogs || [];
        const relevantLogs = promptLogs.filter(log => {
            if (log.agentName !== agentName) return false;
            const logTime = Date.parse(log.timestamp || '') || 0;
            return logTime >= phaseStart;
        });

        return relevantLogs.reduce((acc, log) => ({
            durationMs: acc.durationMs + (log.durationMs || 0),
            tokenCount: acc.tokenCount + (log.totalTokens || 0),
        }), { durationMs: 0, tokenCount: 0 });
    }

    _recordPhasePerformance(agent, task, phaseStartedAt, qaReview, phaseContent) {
        const state = this.getState();
        const metrics = this._collectPhaseMetrics(agent.name, phaseStartedAt);

        this.dependencies.recordPerformance({
            agentName: agent.name,
            taskName: task.phase,
            durationMs: metrics.durationMs,
            tokenCount: metrics.tokenCount,
            outputLength: (phaseContent || '').length,
            qaResult: qaReview?.result || 'pass',
            sessionId: state.currentSessionId || logger.getSessionId() || '',
        });
    }

    async _runPhaseQualityGate(ceoAgent, agent, task) {
        const phaseOutput = this._buildPhaseOutput(agent, task);
        if (!phaseOutput) {
            return { result: 'pass', suggestion: '', finalContent: '', revised: false };
        }

        this._emitCEOMessage(ceoAgent, [
            `【CEO】🧪 正在对「${task.phase}」进行质量审核`,
        ], []);

        const firstReview = await this._qualityReview(agent, task.phase, phaseOutput);
        if (firstReview.result === 'pass') {
            this._emitCEOMessage(ceoAgent, [
                `【CEO】✅ 「${task.phase}」质量审核通过`,
            ], []);
            return { ...firstReview, finalContent: phaseOutput, revised: false };
        }

        this._emitCEOMessage(ceoAgent, [
            `【CEO】🛠 「${task.phase}」首轮审核未通过`,
            firstReview.suggestion
                ? `修改建议：${firstReview.suggestion}`
                : '当前产出还不够具体或不够贴合任务，已要求修订。',
        ], []);

        const revisedContent = await this._revisePhaseOutput(agent, task, phaseOutput, firstReview.suggestion);
        const secondReview = await this._qualityReview(agent, `${task.phase}（修订版）`, revisedContent);
        if (secondReview.result === 'pass') {
            this._emitCEOMessage(ceoAgent, [
                `【CEO】✅ 「${task.phase}」修订后审核通过`,
            ], []);
        } else {
            this._emitCEOMessage(ceoAgent, [
                `【CEO】⚠️ 「${task.phase}」修订后仍有改进空间`,
                secondReview.suggestion
                    ? `保留建议：${secondReview.suggestion}`
                    : '本轮先保留现有修订结果，建议后续继续优化。',
            ], []);
        }

        return {
            result: secondReview.result,
            suggestion: secondReview.suggestion || firstReview.suggestion || '',
            finalContent: revisedContent,
            revised: true,
        };
    }

    async _revisePhaseOutput(agent, task, phaseOutput, suggestion = '') {
        const state = this.getState();
        const availableModels = state.availableModels;
        const currentObjective = state.currentObjective || '';
        const sessionContext = this._buildSessionContext();
        const memoryContext = this.dependencies.formatMemoryContext(agent.name);

        const systemPrompt = [
            `你是团队成员「${agent.name}」，角色：${agent.role}。`,
            `当前项目目标：「${currentObjective}」`,
            sessionContext ? `\n### 项目背景与上下文\n${sessionContext}\n` : '',
            memoryContext,
            '请根据 QA 意见修订当前阶段成果，输出一份更具体、更可执行的阶段稿。',
        ].filter(Boolean).join('\n');

        const userPrompt = [
            `当前阶段：「${task.phase}」`,
            `原始阶段成果：\n${phaseOutput.slice(0, 2000)}`,
            suggestion ? `\nQA 修改建议：${suggestion}` : '',
            '\n请直接输出修订后的阶段成果，使用 Markdown，300-800 字中文，避免空话。',
        ].join('\n');

        try {
            const revisedContent = await this._callLLMWithRetry({
                model: agent.model || state.defaultModel || '',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                availableModels,
                agentName: agent.name,
                dispatch: this.dispatch,
            });

            if (!revisedContent) {
                return phaseOutput;
            }

            this.dispatch({
                type: 'UPDATE_AGENT_OUTPUTS',
                payload: {
                    id: agent.id,
                    output: {
                        phase: task.phase,
                        subtask: `${task.phase}（QA修订版）`,
                        content: revisedContent,
                        source: 'qa-revision',
                    },
                },
            });
            this.dispatch({
                type: 'UPDATE_AGENT_HISTORY',
                payload: {
                    id: agent.id,
                    entry: { role: 'assistant', content: `[${task.phase} QA修订] ${revisedContent.slice(0, 300)}` },
                },
            });
            this._emitAgentMessage(
                agent,
                [`【${agent.name}】已根据 QA 建议完成「${task.phase}」修订。`],
                ['等待 CEO 复审'],
                'qa-review',
                null,
                revisedContent
            );

            return revisedContent;
        } catch (e) {
            logger.warn('QA', `阶段修订失败：${task.phase} - ${e.message}`);
            return phaseOutput;
        }
    }

    /**
     * 质量自动审核 (QA Self-Review)
     * @returns {{result: 'pass'|'revise', suggestion: string}} 审核结果
     */
    async _qualityReview(agent, task, outputContent) {
        try {
            const state = this.getState();
            const ceoAgent = state.agents.find(a => a.name === 'CEO');
            const availableModels = state.availableModels;

            const prompt = [
                `你是质量审核员。请评审以下工作成果是否达标。`,
                `任务：${task}`,
                `执行者：${agent.name}（${agent.role}）`,
                `\n产出内容：\n${(outputContent || '').slice(0, 1500)}`,
                `\n评审标准：`,
                `1. 是否与任务直接相关（而非泛泛而谈）`,
                `2. 是否包含具体可执行的内容`,
                `3. 是否有合理的结构和格式`,
                `\n只回复 JSON：{"result": "pass"} 或 {"result": "revise", "suggestion": "具体修改建议"}`,
            ].join('\n');

            const response = await this._callLLMWithRetry({
                model: ceoAgent?.model || '',
                messages: [{ role: 'user', content: prompt }],
                availableModels,
                agentName: 'QA-Review',
                dispatch: this.dispatch,
            }, 2);

            const jsonMatch = response.match(/\{[\s\S]*?\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    result: parsed.result === 'pass' ? 'pass' : 'revise',
                    suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion.trim() : '',
                };
            }
            // 无法解析 → fail-closed：要求修订
            logger.warn('QA', '质量审核返回无法解析，默认 revise');
            return { result: 'revise', suggestion: '审核响应无法解析，请补充具体可执行内容后重试' };
        } catch (e) {
            logger.warn('QA', `质量审核异常：${e.message}`);
            // 商用 fail-closed：审核失败不得默认通过
            return { result: 'revise', suggestion: `质量审核服务异常：${e.message}` };
        }
    }

    /**
     * 多轮协作对话 + 共识判定
     */
    async _conductCollaboration(ceoAgent, agentA, agentB, topic, maxRounds = 3, executionContext = {}) {
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

        // 超过最大轮次 -> 上报分歧（与 HITL 共用 _userGate）
        try {
            const gateEpoch = this._userGate.epoch();
            await this._userGate.runExclusive(
                () => this._escalateDisagreement(ceoAgent, agentA, agentB, topic, dialogueHistory, executionContext),
                {
                    expectedEpoch: gateEpoch,
                    isAlive: () => !this._aborted,
                }
            );
        } catch (gateErr) {
            if (gateErr?.code === ABORT_REASON.GATE_CANCELLED || this._aborted) {
                return;
            }
            throw gateErr;
        }
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
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    agreed: !!parsed.agreed,
                    summary: parsed.summary || '',
                    proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
                };
            }
        } catch (e) {
            logger.warn('Consensus', `共识判定失败：${e.message}`);
        }

        // fail-closed：判定失败视为未达成共识，走分歧上报
        return {
            agreed: false,
            summary: '共识判定失败或响应无法解析，需董事长决策',
            proposals: [],
        };
    }

    /**
     * 分歧上报：暂停执行，多方案供董事长决策
     * 使用 _gateGeneration：进入临界区后每次写状态前校验，防止 stop 后复活
     */
    async _escalateDisagreement(ceoAgent, agentA, agentB, topic, dialogueHistory, executionContext = {}) {
        const { generation: gen, gateId } = this._captureGateToken();
        const state = this.getState();
        const availableModels = state.availableModels;

        const prompt = `作为项目 CEO，两位成员在「${topic}」上未达成共识：\n\n${dialogueHistory.map(d => `[${d.from}]: ${d.content}`).join('\n\n')}\n\n请：1.总结分歧 2.给 2-3 个方案（含标题、描述、优势、风险）\n返回 JSON：{"summary":"...", "proposals":[{"title":"...", "description":"...", "pros":"...", "cons":"..."}]}\n只返回 JSON。`;

        let proposals = [
            { title: `采纳 ${agentA.name} 方案`, description: `按 ${agentA.name} 建议执行`, pros: '保持上游一致性', cons: '可能忽略下游需求' },
            { title: `采纳 ${agentB.name} 方案`, description: `按 ${agentB.name} 建议执行`, pros: '满足下游需求', cons: '可能需要返工' },
            { title: '折中方案', description: '综合双方意见', pros: '平衡兼顾', cons: '可能两边不完全满意' },
        ];
        let summary = `${agentA.name} 和 ${agentB.name} 在「${topic}」上存在分歧`;

        const dead = () => this._gateInvalidated(gen);
        const abortCleanup = () => {
            try {
                this._rollbackOwnedGateCompat(gateId, 'waiting_for_decision');
            } catch (_) { /* ignore */ }
            return { aborted: true };
        };

        try {
            const raw = await this._callLLMWithRetry({
                model: ceoAgent?.model || '',
                messages: [{ role: 'user', content: prompt }],
                availableModels,
            });
            if (dead()) return abortCleanup();
            const jsonMatch = (raw || '').match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.proposals?.length) proposals = parsed.proposals;
                if (parsed.summary) summary = parsed.summary;
            }
        } catch (error) {
            if (isCancelError(error) || dead()) {
                return abortCleanup();
            }
            logger.warn('Escalation', '分歧方案生成失败，使用默认方案');
        }

        if (dead()) return abortCleanup();

        // 单点提交门禁状态：generation 无效则整段不写
        if (dead()) return abortCleanup();

        this._emitCEOMessage(ceoAgent, [
            '【CEO】⚠️ 协作分歧上报',
            `${agentA.name} 与 ${agentB.name} 在「${topic}」上经 3 轮讨论未达成共识`,
            `分歧要点：${summary}`,
            `已生成 ${proposals.length} 个备选方案，请董事长决策。`,
        ], ['等待董事长选择方案']);
        if (dead()) return abortCleanup();

        recordTimelineEvent('decision', {
            agentName: 'CEO',
            detail: `分歧上报：${topic}`,
        });
        if (dead()) return abortCleanup();

        // 原子写入：pending + status + checkpoint，任一步 generation 失效则回滚
        this.dispatch({
            type: 'SET_PENDING_DECISION',
            payload: {
                topic,
                agentA: agentA.name,
                agentB: agentB.name,
                summary,
                proposals,
                dialogueHistory,
                gateId,
                gateGeneration: gen,
            },
        });
        if (dead()) return abortCleanup();

        this.dispatch({ type: 'SET_STATUS', payload: 'waiting_for_decision' });
        if (dead()) return abortCleanup();

        this._setWorkflowCheckpoint({
            type: 'waiting_for_decision',
            ceoAgentId: executionContext.ceoAgentId || ceoAgent.id,
            teamAgentIds: executionContext.teamAgentIds || [],
            decomposition: executionContext.decomposition || this.getState().decomposition || null,
            completedPhases: executionContext.completedPhases || [],
            currentPhase: executionContext.currentPhase || topic,
            agentAId: agentA.id,
            agentBId: agentB.id,
            topic,
            gateId,
            gateGeneration: gen,
            createdAt: new Date().toISOString(),
        });
        if (dead()) return abortCleanup();

        // 挂起注册与 generation 绑定：stop 后 bump generation，此处再次校验
        const decisionResult = await new Promise(resolve => {
            const finish = (value) => {
                // 仅接受本 generation 的 resolve
                if (this._pendingDecisionResolve !== finish) return;
                this._pendingDecisionResolve = null;
                resolve(value);
            };
            this._pendingDecisionResolve = finish;
            // 赋值后再查一次，堵住 TOCTOU
            if (this._gateInvalidated(gen)) {
                this._pendingDecisionResolve = null;
                resolve({ aborted: true, reason: ABORT_REASON.GATE_CANCELLED });
            }
        });

        if (this._aborted || decisionResult?.aborted || this._gateInvalidated(gen)) {
            return abortCleanup();
        }
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
        const checkpoint = state.workflowCheckpoint;

        if (!this._pendingDecisionResolve && checkpoint?.type === 'waiting_for_decision') {
            void this._resumeAfterDecision(checkpoint, chosenText);
            return;
        }

        // 热态：先原子提升检查点，再唤醒内存链
        if (checkpoint?.type === 'waiting_for_decision' || checkpoint?.type === 'waiting_for_human') {
            const ctx = this._restoreCheckpointContext(checkpoint);
            if (ctx) {
                const completedPhases = new Set(ctx.completedPhases || []);
                // 决策门禁由阶段 finalize 后的协作触发；热恢复也必须像冷恢复一样
                // 把当前阶段记为完成，否则刷新会重放已通过 QA 的阶段。
                let inFlight = normalizeInFlight(ctx.inFlight || []);
                if (checkpoint.type === 'waiting_for_decision' && checkpoint.currentPhase) {
                    completedPhases.add(checkpoint.currentPhase);
                    inFlight = removeInFlight(inFlight, checkpoint.currentPhase);
                }
                this._promoteGateCheckpointToRunning(checkpoint, {
                    ceoAgent: ctx.ceoAgent || ceoAgent,
                    teamAgents: ctx.teamAgents,
                    decomposition: ctx.decomposition,
                    completedPhases,
                    phaseFailures: ctx.phaseFailures || this._phaseFailures,
                    inFlight,
                }, { inFlight });
            }
        }

        this.dispatch({ type: 'SET_STATUS', payload: 'running' });
        this.dispatch({ type: 'RESOLVE_DECISION' });

        if (ceoAgent) {
            this._emitCEOMessage(ceoAgent, [
                `【CEO】✅ 董事长已做出决策：「${redactSensitive(chosenText)}」`,
                '按此方案继续执行后续阶段。',
            ], ['恢复执行流程']);
        }
        recordTimelineEvent('decision', { agentName: 'CEO', detail: `决策：${redactSensitive(chosenText)}` });

        const entry = { role: 'system', content: redactSensitive(`[董事长决策] ${decision.topic}: ${chosenText}`) };
        const aAgent = state.agents.find(a => a.name === decision.agentA);
        const bAgent = state.agents.find(a => a.name === decision.agentB);
        if (aAgent) this.dispatch({ type: 'UPDATE_AGENT_HISTORY', payload: { id: aAgent.id, entry } });
        if (bAgent) this.dispatch({ type: 'UPDATE_AGENT_HISTORY', payload: { id: bAgent.id, entry } });

        if (typeof this._pendingDecisionResolve === 'function') {
            const resolve = this._pendingDecisionResolve;
            resolve({ chosenText });
            // _escalateDisagreement 注册的 finish 回调会先校验身份再自行清理。
            // 不能在调用前置空，否则 finish 会拒绝执行并让等待 Promise 永久挂起。
            if (this._pendingDecisionResolve === resolve) {
                this._pendingDecisionResolve = null;
            }
        }
    }

    async _resumeAfterDecision(checkpoint, chosenText) {
        const context = this._restoreCheckpointContext(checkpoint);
        const state = this.getState();
        const ceoAgent = context?.ceoAgent || state.agents.find(a => a.name === 'CEO');
        const failRecovery = (reason) => {
            this._clearWorkflowCheckpoint();
            this.dispatch({ type: 'RESOLVE_DECISION' });
            this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
            if (ceoAgent) {
                this.dispatch({
                    type: 'UPDATE_AGENT',
                    payload: {
                        id: ceoAgent.id,
                        state: AGENT_STATES.BLOCKED,
                        currentTask: '董事长决策恢复失败',
                    },
                });
                this._emitCEOMessage(ceoAgent, [
                    `【CEO】⚠️ ${reason}`,
                    '请重新发布目标启动新的执行流程。',
                ], ['重新发布目标']);
            }
        };

        if (!context) {
            failRecovery('未找到可恢复的董事长决策上下文。');
            return;
        }

        if (this.isRunning) {
            logger.warn('CEO', '决策恢复时 runner 仍在运行，忽略重复恢复');
            return;
        }

        const { decomposition, teamAgents, completedPhases, phaseFailures, inFlight: rawInFlight } = context;
        const decision = state.pendingDecision;
        this._aborted = false;
        this._paused = false;
        this._phaseFailures = Array.isArray(phaseFailures) ? [...phaseFailures] : (this._phaseFailures || []);
        this._pauseBarrier.forceRelease();
        this._beginRunAbortScope();
        this.isRunning = true;

        try {
            // 协作发生在上游阶段已完成后；currentPhase 已在 finalize 后进入协作，应计入完成
            // 与热态 resolveDecision 对齐：移出 inFlight，避免冷恢复后重放已完成阶段
            let inFlight = normalizeInFlight(rawInFlight || []);
            if (checkpoint.currentPhase) {
                completedPhases.add(checkpoint.currentPhase);
                inFlight = removeInFlight(inFlight, checkpoint.currentPhase);
            }

            // 原子提升，禁止先 clear
            this._promoteGateCheckpointToRunning(checkpoint, {
                ceoAgent,
                teamAgents,
                decomposition,
                completedPhases,
                phaseFailures: this._phaseFailures,
                inFlight,
            }, { inFlight });

            this.dispatch({ type: 'SET_STATUS', payload: 'running' });
            this.dispatch({ type: 'RESOLVE_DECISION' });

            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: ceoAgent.id,
                    state: AGENT_STATES.EXECUTING,
                    currentTask: '根据董事长决策恢复执行',
                },
            });

            this._emitCEOMessage(ceoAgent, [
                `【CEO】✅ 董事长已做出决策：「${redactSensitive(chosenText)}」`,
                '按此方案继续执行后续阶段。',
            ], ['恢复执行流程']);

            const entry = {
                role: 'system',
                content: redactSensitive(`[董事长决策] ${decision?.topic || checkpoint.topic}: ${chosenText}`),
            };
            const aAgent = state.agents.find(a => a.id === checkpoint.agentAId || a.name === decision?.agentA);
            const bAgent = state.agents.find(a => a.id === checkpoint.agentBId || a.name === decision?.agentB);
            if (aAgent) this.dispatch({ type: 'UPDATE_AGENT_HISTORY', payload: { id: aAgent.id, entry } });
            if (bAgent) this.dispatch({ type: 'UPDATE_AGENT_HISTORY', payload: { id: bAgent.id, entry } });

            await this._delay(300);
            if (this._aborted) return;

            const activeTeam = this._refreshTeamAgents(teamAgents);
            await this._driveExecution(ceoAgent, activeTeam, decomposition, { completedPhases });
        } catch (err) {
            logger.error('CEO', `决策恢复异常: ${redactSensitive(err.message)}`);
            failRecovery(err.message);
        } finally {
            this.isRunning = false;
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
        const safeDialogue = (dialogue || []).map(line => redactSensitive(String(line ?? '')));
        const safeNext = (nextStep || []).map(line => redactSensitive(String(line ?? '')));
        const safeOutput = outputContent == null ? null : redactSensitive(String(outputContent));
        const msg = createStructuredMessage(
            updatedAgent || agent,
            safeDialogue,
            safeNext,
            safeOutput
        );
        if (msg.current_task) {
            msg.current_task = redactSensitive(String(msg.current_task));
        }
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
                graph[dep] ??= [];
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
            graph[node].forEach(dfs);
            stack.delete(node);
        };
        phases.forEach(dfs);
        if (hasCycle) issues.push('检测到任务依赖环，请检查阶段依赖设置');

        return { ok: issues.length === 0, issues };
    }

    /**
     * LLM 调用带重试与退避
     * - 配置缺失 / 用户取消：不重试
     * - 自动注入本轮 AbortSignal
     */
    async _callLLMWithRetry(params, maxAttempts = 3) {
        let attempt = 0;
        let delay = 500;
        const signal = params.signal || this._getRunSignal();

        while (attempt < maxAttempts) {
            if (this._aborted || signal?.aborted) {
                const err = new Error('LLM 请求已取消');
                err.code = 'LLM_CANCELLED';
                throw err;
            }
            try {
                return await this.dependencies.sendChat({ ...params, signal });
            } catch (err) {
                if (isCancelError(err) || this._aborted) {
                    throw err;
                }
                // 配置缺失 / 4xx 客户端错误不重试
                if (err.message && err.message.includes('未配置')) {
                    throw err;
                }
                if (err.code === 'LLM_HTTP' || err.retryable === false || /LLM 调用失败 (4\d{2})/.test(err.message || '')) {
                    // 4xx 配置/鉴权错误不重试
                    if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
                        throw err;
                    }
                    if (err.retryable === false) throw err;
                }
                attempt += 1;
                if (attempt >= maxAttempts) throw err;
                await this._delay(delay);
                delay *= 2;
            }
        }
    }

    /**
     * 构建交付物报告
     * 状态以调度器 completedPhases / phaseFailures / phaseResults 为准，禁止用 outputs 猜测
     */
    _buildDeliverable(decomposition, teamAgents, tasks, meta = {}) {
        const now = new Date().toISOString();
        const state = this.getState();
        const lines = [];
        const completedSet = meta.completedPhases instanceof Set
            ? meta.completedPhases
            : new Set(meta.completedPhases || []);
        const failedList = meta.phaseFailures ?? this._phaseFailures ?? [];
        const failedSet = new Set(failedList.map(f => f.phase));
        const phaseResults = meta.phaseResults ?? this._phaseResults ?? {};

        const phaseStatuses = tasks.map(t => {
            const subtasks = t.subtasks || [];
            const agentState = state.agents.find(a => a.name === t.assignee);
            const phaseOutputs = (agentState?.outputs || []).filter(o => o.phase === t.phase);
            const successOutputs = phaseOutputs.filter(o =>
                o.status === STEP_STATUS.SUCCESS
                || (!o.status && o.source !== 'template' && o.source !== 'fallback' && o.source !== 'skipped' && (o.content || '').trim())
            );
            const recorded = phaseResults[t.phase];

            if (failedSet.has(t.phase) || recorded?.status === STEP_STATUS.FAILED) {
                return {
                    phase: t.phase,
                    status: 'failed',
                    reason: failedList.find(f => f.phase === t.phase)?.reason || recorded?.reason || '失败',
                    subtaskDone: successOutputs.length,
                    subtaskTotal: subtasks.length,
                };
            }
            // 严格：仅 completedPhases 中的阶段算 success，且子任务数须齐全（若有定义）
            if (completedSet.has(t.phase) && recorded?.status !== STEP_STATUS.FAILED) {
                const allSubtasksDone = subtasks.length === 0
                    || subtasks.every(st => successOutputs.some(o => o.subtask === st));
                if (!allSubtasksDone) {
                    return {
                        phase: t.phase,
                        status: 'incomplete',
                        reason: `子任务未全部成功（${successOutputs.length}/${subtasks.length}）`,
                        subtaskDone: successOutputs.length,
                        subtaskTotal: subtasks.length,
                    };
                }
                if (recorded?.qa && recorded.qa !== 'pass') {
                    return {
                        phase: t.phase,
                        status: 'failed',
                        reason: `QA=${recorded.qa}`,
                        subtaskDone: successOutputs.length,
                        subtaskTotal: subtasks.length,
                    };
                }
                return {
                    phase: t.phase,
                    status: 'success',
                    subtaskDone: successOutputs.length,
                    subtaskTotal: subtasks.length,
                };
            }
            return {
                phase: t.phase,
                status: 'incomplete',
                reason: '未进入 completedPhases',
                subtaskDone: successOutputs.length,
                subtaskTotal: subtasks.length,
            };
        });

        const successCount = phaseStatuses.filter(p => p.status === 'success').length;
        const failedCount = phaseStatuses.filter(p => p.status === 'failed').length;
        const incompleteCount = phaseStatuses.filter(p => p.status === 'incomplete').length;
        const allSuccess = successCount === tasks.length && failedCount === 0 && incompleteCount === 0;

        lines.push(`# 项目交付报告`);
        lines.push('');
        lines.push(`| 项目 | 详情 |`);
        lines.push(`|------|------|`);
        lines.push(`| 生成时间 | ${now} |`);
        lines.push(`| 战略目标 | ${redactSensitive(decomposition.objective)} |`);
        lines.push(`| 项目类型 | ${redactSensitive(decomposition.type)} |`);
        lines.push(`| 阶段数量 | ${tasks.length} |`);
        lines.push(`| 成功阶段 | ${successCount} |`);
        lines.push(`| 失败阶段 | ${failedCount} |`);
        lines.push(`| 未完成阶段 | ${incompleteCount} |`);
        lines.push(`| 团队规模 | ${teamAgents.length} 人 |`);
        lines.push(`| 整体结论 | ${allSuccess ? '全部成功' : '部分完成/存在失败或未完成'} |`);
        lines.push('');

        lines.push(`## 团队角色与模型`);
        teamAgents.forEach(a => {
            lines.push(`- **${redactSensitive(a.name)}**（${redactSensitive(a.role)}） — 模型：${redactSensitive(a.model || '未指定')}`);
        });
        lines.push('');

        lines.push(`## 执行阶段与成果`);
        tasks.forEach((t, idx) => {
            // phaseStatuses 与 tasks 由上面的同一次 map 一一对应。
            const st = phaseStatuses[idx];
            lines.push(`### ${idx + 1}. ${redactSensitive(t.phase)} 〔${st.status}〕`);
            lines.push(`- **负责人**：${redactSensitive(t.assignee)}`);
            if (t.dependencies?.length) {
                lines.push(`- **依赖**：${redactSensitive(t.dependencies.join(', '))}`);
            }
            if (st.subtaskTotal) {
                lines.push(`- **子任务进度**：${st.subtaskDone || 0}/${st.subtaskTotal}`);
            }
            if (st.reason) {
                lines.push(`- **说明**：${redactSensitive(st.reason)}`);
            }
            lines.push('');

            const agentState = state.agents.find(a => a.name === t.assignee);
            const outputs = (agentState?.outputs || []).filter(o => o.phase === t.phase);
            if (outputs.length > 0) {
                outputs.forEach(o => {
                    const tag = o.status && o.status !== STEP_STATUS.SUCCESS ? ` [${o.status}]` : '';
                    lines.push(`#### ${redactSensitive(o.subtask)}${tag}`);
                    lines.push(redactSensitive(o.content || '（无内容）'));
                    lines.push('');
                });
            } else {
                lines.push('_本阶段无已确认的实质产出_');
                lines.push('');
            }
        });

        const collabMessages = (state.messages || []).filter(m => m.source === 'collaboration');
        if (collabMessages.length > 0) {
            lines.push(`## 协作对话记录`);
            collabMessages.forEach(m => {
                const line = (m.dialogue || []).join(' ');
                lines.push(`- ${redactSensitive(line.slice(0, 200))}`);
            });
            lines.push('');
        }

        lines.push(`## 总结`);
        if (allSuccess) {
            lines.push(`全部 ${tasks.length} 个阶段已成功完成（含 QA 通过），共产出经确认的工作成果。`);
        } else {
            lines.push(
                `未全部成功：成功 ${successCount}，失败 ${failedCount}，未完成 ${incompleteCount}（共 ${tasks.length} 阶段）。`
            );
            lines.push('请勿将本报告视为完整交付；失败/未完成阶段需人工复核或重置后重试。');
        }
        lines.push(`如需继续迭代，请在底部输入框直接下达新指令。`);

        return {
            id: uuidv4(),
            title: redactSensitive(`交付物 - ${String(decomposition.objective || '').slice(0, 30)}`),
            timestamp: now,
            content: lines.join('\n'),
            meta: {
                successCount,
                failedCount,
                incompleteCount,
                allSuccess,
                phaseStatuses,
            },
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
     * 延迟执行（支持多 waiter 暂停栅栏 + 中止）
     */
    _delay(ms) {
        return new Promise((resolve) => {
            if (this._aborted) {
                resolve();
                return;
            }
            const timer = setTimeout(async () => {
                try {
                    if (this._aborted) {
                        resolve();
                        return;
                    }
                    if (this._paused || this._pauseBarrier.isPaused()) {
                        await this._pauseBarrier.waitIfPaused();
                    }
                } finally {
                    resolve();
                }
            }, ms);
            this.timers.push(timer);
        });
    }

    /**
     * 暂停执行（董事长可在运行中暂停）
     * 暂停时同步刷写阶段检查点，降低刷新丢进度风险
     */
    pause() {
        if (!this.isRunning && !this._paused) return;
        this._paused = true;
        this._pauseBarrier.pause();
        const state = this.getState();
        const ceoAgent = state.agents.find(a => a.name === 'CEO');
        const existing = state.workflowCheckpoint;
        if (existing?.type === 'running_execution' && ceoAgent) {
            // 保留 completed + inFlight，仅刷新时间戳与 team 列表
            const teamAgents = state.agents.filter(a => a.name !== 'CEO');
            this._persistRunningCheckpoint(
                ceoAgent,
                teamAgents,
                existing.decomposition || state.decomposition,
                new Set(existing.completedPhases || []),
                { replaceInFlight: existing.inFlight || [] }
            );
        } else if (state.decomposition && ceoAgent) {
            const teamAgents = state.agents.filter(a => a.name !== 'CEO');
            // 上方已读取 state.agents.find，故这里的 agents 必为同一稳定数组。
            const completed = state.agents
                .filter(a => a.state === AGENT_STATES.COMPLETED && a.phase)
                .map(a => a.phase);
            // 从 agent 进度推导 inFlight
            const inFlight = [];
            for (const agent of teamAgents) {
                if (agent.state !== AGENT_STATES.EXECUTING && agent.state !== AGENT_STATES.PLANNING) continue;
                const task = (state.decomposition.tasks || []).find(t => t.assignee === agent.name || t.phase === agent.phase);
                if (!task || completed.includes(task.phase)) continue;
                const nextIdx = Math.max(
                    agent.currentSubtaskIndex || 0,
                    inferNextSubtaskIndex(agent, task)
                );
                inFlight.push({
                    phase: task.phase,
                    agentId: agent.id,
                    agentName: agent.name,
                    nextSubtaskIndex: nextIdx,
                    phaseStartedAt: new Date().toISOString(),
                    totalSubtasks: (task.subtasks || []).length,
                    currentSubtask: (task.subtasks || [])[nextIdx] || agent.currentTask || '',
                });
            }
            this._persistRunningCheckpoint(
                ceoAgent,
                teamAgents,
                state.decomposition,
                new Set(existing?.completedPhases || completed),
                { replaceInFlight: inFlight }
            );
        }
        if (ceoAgent) {
            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: ceoAgent.id,
                    state: AGENT_STATES.WAITING,
                    currentTask: '已暂停 - 等待董事长指令',
                },
            });
            this._emitCEOMessage(ceoAgent, [
                '【CEO】⏸️ 收到董事长指令，执行已暂停。',
                '您可以在左侧调整成员模型；热重组后恢复时会重新读取最新团队。',
                '阶段进度已写入检查点，刷新页面后仍可继续。',
                '准备好后点击「▶️ 恢复执行」。',
            ], ['等待董事长操作']);
        }
        this.dispatch({ type: 'SET_STATUS', payload: 'paused' });
        recordTimelineEvent('state_change', { agentName: 'CEO', detail: '执行暂停' });
        logger.info('CEO', '执行已暂停');
    }

    /**
     * 从暂停状态恢复执行
     */
    unpause() {
        if (!this._paused && !this._pauseBarrier.isPaused()) return;
        this._paused = false;
        this._pauseBarrier.resume();
        const state = this.getState();
        const ceoAgent = state.agents.find(a => a.name === 'CEO');
        if (ceoAgent) {
            this.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: ceoAgent.id,
                    state: AGENT_STATES.EXECUTING,
                    currentTask: '恢复执行',
                },
            });
            this._emitCEOMessage(ceoAgent, [
                '【CEO】▶️ 收到董事长指令，恢复执行！',
            ], ['继续调度后续阶段']);
        }
        this.dispatch({ type: 'SET_STATUS', payload: 'running' });
        recordTimelineEvent('state_change', { agentName: 'CEO', detail: '执行恢复' });
        logger.info('CEO', '执行已恢复');
    }

    /**
     * 热重组团队（在暂停状态下调用）
     * @param {object} changes - { add: [{name, role, color}], remove: [agentId], update: [{id, role, model}] }
     */
    restructure(changes = {}) {
        const state = this.getState();
        const ceoAgent = state.agents.find(a => a.name === 'CEO');
        const actionLogs = [];

        // 添加新 Agent
        if (changes.add && changes.add.length > 0) {
            for (const info of changes.add) {
                const agent = createAgent({
                    name: info.name,
                    role: info.role,
                    color: info.color || '#3B82F6',
                    parentId: ceoAgent?.id,
                    model: info.model || '',
                });
                this.dispatch({ type: 'ADD_AGENT', payload: agent });
                actionLogs.push(`  ✅ 新增成员：${info.name}（${info.role}）`);
            }
        }

        // 移除 Agent
        if (changes.remove && changes.remove.length > 0) {
            for (const agentId of changes.remove) {
                const agent = state.agents.find(a => a.id === agentId);
                if (agent && agent.name !== 'CEO') {
                    this.dispatch({ type: 'REMOVE_AGENT', payload: agentId });
                    actionLogs.push(`  ❌ 移除成员：${agent.name}`);
                }
            }
        }

        // 更新 Agent
        if (changes.update && changes.update.length > 0) {
            for (const upd of changes.update) {
                this.dispatch({ type: 'UPDATE_AGENT', payload: upd });
                const agent = state.agents.find(a => a.id === upd.id);
                actionLogs.push(`  🔄 更新成员：${agent?.name || upd.id}`);
            }
        }

        if (ceoAgent && actionLogs.length > 0) {
            this._emitCEOMessage(ceoAgent, [
                '【CEO】🔄 团队重组完成：',
                ...actionLogs,
                '请点击「▶️ 恢复执行」继续。',
            ], ['等待董事长恢复执行']);
        }

        logger.info('CEO', `团队重组：${actionLogs.length} 项变更`);
    }

    /**
     * 停止执行 — 必须唤醒所有挂起 Promise，并 abort 进行中的 LLM 请求
     * @param {string} [reason]
     */
    stop(reason = ABORT_REASON.STOPPED) {
        this._aborted = true;
        this.isRunning = false;
        this._paused = false;

        // 作废排队中 + 活动中的用户门禁（generation 令牌）
        this._gates.bump({ rotateRunId: false });
        try {
            this._userGate?.invalidate?.();
        } catch (_) { /* ignore */ }

        // 立即取消所有进行中的 fetch / SSE
        if (this._runAbortController) {
            try {
                this._runAbortController.abort();
            } catch (_) { /* ignore */ }
            this._runAbortController = null;
        }

        this.timers.forEach(t => clearTimeout(t));
        this.timers = [];

        // 先唤醒暂停栅栏，再解决 HITL/决策挂起
        this._pauseBarrier.forceRelease();

        if (typeof this._pendingHumanInput === 'function') {
            const resolve = this._pendingHumanInput;
            try {
                resolve(reason);
            } catch (_) { /* ignore */ }
            this._pendingHumanInput = null;
        }

        if (typeof this._pendingDecisionResolve === 'function') {
            const resolve = this._pendingDecisionResolve;
            try {
                resolve({ aborted: true, reason });
            } catch (_) { /* ignore */ }
            if (this._pendingDecisionResolve === resolve) {
                this._pendingDecisionResolve = null;
            }
        }

        // 清理持久化的待决策数据；否则 stop 后 UI 仍可能显示过期方案。
        try {
            this.dispatch({ type: 'RESOLVE_DECISION' });
        } catch (_) { /* ignore */ }

        this._pendingExecution = null;
        this._phaseFailures = [];

        try {
            this._clearWorkflowCheckpoint();
        } catch (_) { /* ignore */ }

        // 终态不得停在 waiting_for_*
        try {
            const st = this.getState()?.systemStatus;
            if (st === 'waiting_for_config' || st === 'waiting_for_human' || st === 'waiting_for_decision' || st === 'running' || st === 'paused') {
                this.dispatch({ type: 'SET_STATUS', payload: 'blocked' });
            }
        } catch (_) { /* ignore */ }

        logger.info('CEO', `执行已停止：${reason}`);
        recordTimelineEvent('state_change', { agentName: 'CEO', detail: `停止：${reason}` });
    }
}

export default CEOAgentRunner;
