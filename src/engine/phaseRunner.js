/**
 * 阶段运行器：从 CEOAgentRunner 抽出的阶段/子任务/QA 收尾。
 * 仍通过 runner 访问 dispatch、门禁与协作，避免一次拆爆。
 */
import {
    createStructuredMessage,
    AGENT_STATES,
    DIALOGUE_TEMPLATES,
} from './agentEngine.js';
import { inferNextSubtaskIndex, isSubtaskOutputPresent } from './workflowCheckpoint.js';
import { v4 as uuidv4 } from 'uuid';
import {
    STEP_STATUS,
    normalizeSubtaskResult,
    isSuccessStatus,
    statusLabel,
} from './executionResult.js';
import { recordTimelineEvent } from './timelineRecorder.js';
import { ABORT_REASON } from './executionControl.js';
import { buildSafeHumanAssistContext } from '../utils/sensitiveData.js';
import logger from '../utils/logger.js';

export async function executeAgentPhase(runner, ceoAgent, agent, task, completedPhases, teamAgents, options = {}) {
    const agentId = agent.id;
    const phaseStartedAt = options.phaseStartedAt || new Date().toISOString();
    let startIndex = Math.max(0, options.startIndex || 0);
    const skipPlanning = options.skipPlanning || startIndex > 0;

    try {
        if (runner._aborted) return false;

        // 幂等：按 outputs 对齐 startIndex
        const latestForInfer = runner._getLatestAgent(agentId);
        startIndex = Math.max(startIndex, inferNextSubtaskIndex(latestForInfer, task));

        // 标记阶段进入 inFlight
        runner._persistRunningCheckpoint(
            ceoAgent,
            teamAgents,
            runner.getState().decomposition || { tasks: [task] },
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
            runner.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: agentId,
                    state: AGENT_STATES.WAITING,
                    currentTask: `等待依赖：${task.dependencies.join(', ')}`,
                },
            });
            runner._emitAgentMessage(agent,
                DIALOGUE_TEMPLATES.waiting(agent.name, task.dependencies.join(', ')),
                [`等待 ${task.dependencies.join(', ')} 完成`]
            );
            await runner._delay(1000);
            if (runner._aborted) return false;
        }

        // 规划阶段（续跑跳过）
        if (!skipPlanning) {
            runner.dispatch({
                type: 'UPDATE_AGENT',
                payload: {
                    id: agentId,
                    state: AGENT_STATES.PLANNING,
                    currentTask: `规划：${task.phase}`,
                    progress: 0.1,
                },
            });
            runner._emitAgentMessage(agent,
                DIALOGUE_TEMPLATES.planning(agent.name, task.subtasks),
                ['开始执行各子任务']
            );
            await runner._delay(1500);
            if (runner._aborted) return false;
        }

        const success = await runner._runRemainingSubtasks(
            ceoAgent, agent, task, completedPhases, teamAgents, startIndex, phaseStartedAt
        );
        if (!success || runner._aborted) return false;

        const finalized = await runner._finalizeAgentPhase(
            ceoAgent, agent, task, completedPhases, teamAgents, phaseStartedAt
        );
        if (!finalized || runner._aborted) {
            runner._persistRunningCheckpoint(
                ceoAgent,
                teamAgents,
                runner.getState().decomposition,
                completedPhases,
                { removeInFlightPhase: task.phase }
            );
            return false;
        }

        // 阶段完成：移出 inFlight
        runner._persistRunningCheckpoint(
            ceoAgent,
            teamAgents,
            runner.getState().decomposition,
            completedPhases,
            { removeInFlightPhase: task.phase }
        );
        return true;
    } catch (err) {
        logger.error('CEO', `执行阶段「${task.phase}」失败: ${err.message}`);
        runner.dispatch({
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

export async function runRemainingSubtasks(runner, ceoAgent, agent, task, completedPhases, teamAgents, startIndex = 0, phaseStartedAt = new Date().toISOString()) {
    const agentId = agent.id;
    const subtasks = task.subtasks;
    const decomposition = runner.getState().decomposition;

    for (let i = startIndex; i < subtasks.length; i++) {
        if (runner._aborted) return false;

        const subtask = subtasks[i];
        const subtaskProgress = (i + 1) / Math.max(subtasks.length, 1);

        // 幂等：已有产出则跳过（避免刷新后重复烧 token）
        const latestAgent = runner._getLatestAgent(agentId);
        if (isSubtaskOutputPresent(latestAgent, task.phase, subtask)) {
            runner._emitAgentMessage(agent, [
                `【${agent.name}】⏭ 子任务已有产出，跳过：${subtask}`,
            ], [], 'checkpoint-skip');
            runner._persistRunningCheckpoint(ceoAgent, teamAgents, decomposition, completedPhases, {
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

        runner.dispatch({
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
        runner._persistRunningCheckpoint(ceoAgent, teamAgents, decomposition, completedPhases, {
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
        const needsHumanIntervention = await runner._checkHumanInterventionNeeded(agent, subtask);
        if (runner._aborted) return false;

        if (needsHumanIntervention) {
            recordTimelineEvent('decision', {
                agentName: agent.name,
                detail: `请求人工协助：${subtask}`,
            });
            let humanResult;
            try {
                const gateEpoch = runner._userGate.epoch();
                humanResult = await runner._userGate.runExclusive(
                    () => runner._requestHumanIntervention(agent, subtask, {
                        ceoAgentId: ceoAgent.id,
                        teamAgentIds: teamAgents.map(teamAgent => teamAgent.id),
                        decomposition: runner.getState().decomposition || null,
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
                        isAlive: () => !runner._aborted,
                    }
                );
            } catch (gateErr) {
                if (gateErr?.code === ABORT_REASON.GATE_CANCELLED || runner._aborted) {
                    return false;
                }
                throw gateErr;
            }

            if (
                humanResult === ABORT_REASON.TIMEOUT_ABORT
                || humanResult === ABORT_REASON.STOPPED
                || humanResult === ABORT_REASON.RESET
                || humanResult === ABORT_REASON.GATE_CANCELLED
                || runner._aborted
            ) {
                return false;
            }

            if (humanResult === 'FORCE_CONTINUE' || humanResult === 'SKIPPED_BY_USER' || humanResult === 'TIMEOUT_SKIP') {
                // 显式跳过：不计入成功，阶段失败
                runner._emitAgentMessage(agent, [
                    `【${agent.name}】子任务被显式跳过：${subtask}（不计为成功）`,
                ], [], 'skipped');
                runner.dispatch({
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
        const result = await runner._executeSubtask(
            agent,
            subtask,
            subtaskProgress,
            (token) => {
                liveBuffer += token;
                runner.dispatch({
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

        if (runner._aborted) return false;

        const normalized = normalizeSubtaskResult(result);
        // 模板/失败产出不得当作成功继续
        if (!isSuccessStatus(normalized.status)) {
            runner._emitAgentMessage(agent, [
                `【${agent.name}】❌ 子任务失败：${subtask}`,
                normalized.reason || `来源=${normalized.source}，状态=${statusLabel(normalized.status)}`,
            ], [], 'failed');
            runner.dispatch({
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
        runner.dispatch({
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

        runner._emitAgentMessage(agent,
            normalized.summary,
            i < subtasks.length - 1
                ? [`继续执行：${subtasks[i + 1]}`]
                : ['进入审核阶段'],
            normalized.source,
            streamClientId,
            normalized.content
        );

        // 子任务完成后推进 nextSubtaskIndex
        runner._persistRunningCheckpoint(ceoAgent, teamAgents, decomposition, completedPhases, {
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

        await runner._delay(1500 + Math.random() * 1000);
        if (runner._aborted) return false;

        runner._emitAgentMessage(agent,
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
export async function finalizeAgentPhase(runner, ceoAgent, agent, task, completedPhases, teamAgents, phaseStartedAt = new Date().toISOString()) {
    const agentId = agent.id;

    // 审核阶段
    runner.dispatch({
        type: 'UPDATE_AGENT',
        payload: {
            id: agentId,
            state: AGENT_STATES.REVIEWING,
            currentTask: `审核：${task.phase}`,
            progress: 0.9,
        },
    });
    runner._emitAgentMessage(agent,
        DIALOGUE_TEMPLATES.reviewing(agent.name),
        ['提交最终成果']
    );
    await runner._delay(1500);

    const qaReview = await runner._runPhaseQualityGate(ceoAgent, agent, task);
    const phaseContent = qaReview.finalContent || runner._buildPhaseOutput(agent, task);

    // QA 未通过：不得标记 COMPLETED，不得解锁下游
    if (qaReview.result !== 'pass') {
        runner.dispatch({
            type: 'UPDATE_AGENT',
            payload: {
                id: agentId,
                state: AGENT_STATES.BLOCKED,
                currentTask: `${task.phase} - QA 未通过`,
                progress: 0.9,
            },
        });
        runner._emitCEOMessage(ceoAgent, [
            `【CEO】❌ 「${task.phase}」质量门未通过，阶段不计为完成。`,
            qaReview.suggestion
                ? `原因：${qaReview.suggestion}`
                : '请修订产出或重置后重试。',
        ], ['阶段阻塞']);
        recordTimelineEvent('qa_review', {
            agentName: agent.name,
            detail: `${task.phase} — QA 未通过`,
        });
        runner._recordPhasePerformance(agent, task, phaseStartedAt, qaReview, phaseContent);
        runner._phaseResults[task.phase] = {
            status: STEP_STATUS.FAILED,
            qa: qaReview.result,
            reason: qaReview.suggestion || 'QA 未通过',
        };
        return false;
    }

    // 标记完成
    runner.dispatch({
        type: 'UPDATE_AGENT',
        payload: {
            id: agentId,
            state: AGENT_STATES.COMPLETED,
            currentTask: `${task.phase} - 已完成`,
            progress: 1.0,
        },
    });
    runner._emitAgentMessage(agent,
        DIALOGUE_TEMPLATES.completed(agent.name, task.phase),
        []
    );

    runner._recordPhasePerformance(agent, task, phaseStartedAt, qaReview, phaseContent);
    runner._phaseResults[task.phase] = {
        status: STEP_STATUS.SUCCESS,
        qa: 'pass',
    };

    // 持久化阶段经验，供后续会话注入
    try {
        const experience = (phaseContent || '').slice(0, 400).replace(/\s+/g, ' ');
        if (experience) {
            runner.dependencies.saveMemory(agent.name, task.phase, experience);
        }
    } catch (e) {
        logger.warn('Memory', `保存记忆失败: ${e.message}`);
    }

    runner._emitCEOMessage(ceoAgent, [
        `【CEO】收到 ${agent.name} 报告：「${task.phase}」阶段已完成 ✅`,
        '质量结论：QA 通过',
    ], []);
    recordTimelineEvent('qa_review', {
        agentName: agent.name,
        detail: `${task.phase} — QA 通过`,
    });

    // ★ 阶段完成后，与下游依赖的 Agent 进行多轮协作共识
    const state = runner.getState();
    const allTasks = state.decomposition?.tasks ?? [];
    const downstreamTasks = allTasks.filter(t =>
        t.dependencies.includes(task.phase)
    );
    for (const downTask of downstreamTasks) {
        if (runner._aborted) return false;
        const downAgent = state.agents.find(a => a.name === downTask.assignee);
        if (!downAgent || downAgent.id === agentId) continue;
        await runner._conductCollaboration(ceoAgent, agent, downAgent, task.phase, 3, {
            ceoAgentId: ceoAgent.id,
            teamAgentIds: teamAgents.map(teamAgent => teamAgent.id),
            decomposition: state.decomposition,
            completedPhases: [...completedPhases],
            currentPhase: task.phase,
        });
        if (runner._aborted) return false;
    }

    await runner._delay(800);
    return true;
}

export default { executeAgentPhase, runRemainingSubtasks, finalizeAgentPhase };
