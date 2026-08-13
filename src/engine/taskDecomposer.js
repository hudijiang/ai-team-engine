/**
 * 任务拆解引擎 - LLM 智能版
 * CEO 通过 AI 动态分析目标，智能组建团队和拆解任务
 * 完全由 LLM 驱动，不使用任何硬编码模板
 */
import { sendChat, resolveProviderForModel } from './llmClient.js';
import { ensureKnowledgeBaseHydrated, formatRAGContext } from './ragEngine.js';
import { getMergedRoleLibrary, buildRoleLibraryText, buildPluginRolePrompt } from './capabilityRuntime.js';
import logger from '../utils/logger.js';

/**
 * 角色库 - 作为 LLM 的参考，LLM 可以从中选择也可以自创角色
 */
const ROLE_LIBRARY = {
    // 商业类
    '商业分析师': { role: '负责商业模式分析、盈利策略和市场机会评估', color: '#7C3AED', category: 'business' },
    '市场策划': { role: '负责营销战略规划和活动策划', color: '#EC4899', category: 'business' },
    '运营专家': { role: '负责日常运营管理和流程优化', color: '#F59E0B', category: 'business' },
    '销售顾问': { role: '负责销售策略制定和客户转化', color: '#EF4444', category: 'business' },
    '财务分析师': { role: '负责成本分析、预算制定和投资回报评估', color: '#06B6D4', category: 'business' },

    // 技术类
    '产品经理': { role: '负责需求分析、产品设计和功能规划', color: '#7C3AED', category: 'tech' },
    'UI设计师': { role: '负责界面设计、交互设计和视觉规范', color: '#EC4899', category: 'tech' },
    '前端工程师': { role: '负责前端页面开发和交互实现', color: '#3B82F6', category: 'tech' },
    '后端工程师': { role: '负责后端服务、API设计和数据库', color: '#10B981', category: 'tech' },
    '测试工程师': { role: '负责功能测试、性能测试和质量保证', color: '#F59E0B', category: 'tech' },
    '架构师': { role: '负责系统架构设计和技术选型', color: '#8B5CF6', category: 'tech' },

    // 创意内容类
    '内容创作者': { role: '负责文案撰写和内容制作', color: '#EC4899', category: 'creative' },
    '视频制作': { role: '负责视频策划、拍摄和后期制作', color: '#3B82F6', category: 'creative' },
    '设计师': { role: '负责视觉设计和物料制作', color: '#F59E0B', category: 'creative' },
    '品牌顾问': { role: '负责品牌定位、形象塑造和传播策略', color: '#8B5CF6', category: 'creative' },

    // 研究类
    '首席研究员': { role: '负责研究方向和方法论设计', color: '#7C3AED', category: 'research' },
    '数据分析师': { role: '负责数据采集、建模和定量分析', color: '#3B82F6', category: 'research' },
    '报告撰写员': { role: '负责研究报告撰写和可视化', color: '#10B981', category: 'research' },

    // 教育培训类
    '课程设计师': { role: '负责课程体系设计和教学大纲制定', color: '#7C3AED', category: 'education' },
    '讲师': { role: '负责教学内容开发和授课', color: '#3B82F6', category: 'education' },

    // 管理类
    '项目经理': { role: '负责项目规划、进度跟踪和风险管理', color: '#7C3AED', category: 'management' },
    '质量专员': { role: '负责质量检查和结果验收', color: '#10B981', category: 'management' },
};

/**
 * 可选颜色池
 */
const COLOR_POOL = ['#7C3AED', '#EC4899', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#06B6D4', '#8B5CF6', '#84CC16', '#F97316'];

/**
 * 使用 LLM 动态分析目标，智能组建团队（主方法）
 *
 * @param {string} objective - 战略目标
 * @param {string} model - CEO 使用的模型 ID
 * @param {Object} availableModels - 可用模型字典
 * @param {AbortSignal} [signal] - 可选取消信号
 * @returns {Promise<Object>} 拆解结果 { type, roles, tasks, objective, ... }
 */
export async function decomposeWithLLM(objective, model, availableModels, signal = null) {
    const roleLibrary = getMergedRoleLibrary(ROLE_LIBRARY, COLOR_POOL);
    // 构建角色库描述，让 LLM 知道有哪些可选角色
    const roleDescriptions = buildRoleLibraryText(roleLibrary);
    const pluginRolePrompt = buildPluginRolePrompt();
    await ensureKnowledgeBaseHydrated();
    const knowledgeContext = formatRAGContext(objective);

    const systemPrompt = `你是一个项目 CEO，擅长分析战略目标并组建最合适的执行团队。

## 可用角色库（可选择也可自创新角色）
${roleDescriptions}

${pluginRolePrompt ? `${pluginRolePrompt}\n` : ''}

${knowledgeContext ? `## 本地知识库参考（关键词检索）\n${knowledgeContext}\n` : ''}

## 你的任务
分析用户的战略目标，然后：
1. 判断目标类型（如：商业策略、软件开发、营销推广、研究分析等）
2. 从角色库中选择 3-5 个最合适的角色（也可以自定义不在库中的新角色）
3. 为每个角色设计具体的任务阶段和子任务
4. 定义阶段之间的依赖关系

## 输出格式
严格输出以下 JSON（不要包裹在 markdown 代码块中，不要添加任何其他文字）：
{
  "type": "项目类型名称",
  "roles": [
    { "name": "角色名", "role": "一句话职责描述", "category": "business|tech|creative|research|education|management" }
  ],
  "tasks": [
    {
      "phase": "阶段名称",
      "assignee": "负责的角色名（必须与 roles 中某个 name 一致）",
      "subtasks": ["子任务1", "子任务2", "子任务3", "子任务4"],
      "dependencies": [],
      "duration": 3
    }
  ]
}

## 约束
- 选择 3-5 个角色，每个角色至少分配一个任务阶段
- 每个阶段包含 3-5 个具体可执行的子任务（要针对目标，不要泛泛）
- dependencies 表示需要等待哪些阶段完成后才能开始，用阶段名称引用
- 至少有一个阶段的 dependencies 为空数组 []（可以最先启动的）
- duration 表示预估工作周期（1-5）`;

    const userPrompt = `分析以下战略目标并组建执行团队：\n\n「${objective}」`;

    logger.info('TaskDecomposer', `正在使用 LLM(${model}) 分析目标：「${objective}」`);

    const content = await sendChat({
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        availableModels,
        stream: false,
        signal,
    });

    // 提取 JSON
    const parsed = extractJSON(content);
    if (!parsed) {
        throw new Error(`LLM 返回内容无法解析为 JSON: ${(content || '').slice(0, 100)}`);
    }

    // 验证并标准化
    const result = validateAndNormalize(parsed, objective, roleLibrary);
    logger.info('TaskDecomposer', `LLM 分析完成：类型=${result.type}，角色=${result.roles.map(r => r.name).join(',')}，阶段=${result.totalPhases}`);
    return result;
}

/**
 * 从 LLM 返回的文本中提取 JSON
 */
function extractJSON(text) {
    if (!text) return null;

    // 尝试直接解析
    try { return JSON.parse(text.trim()); } catch (_) { /* continue */ }

    // 尝试从 markdown 代码块中提取
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
        try { return JSON.parse(codeBlockMatch[1].trim()); } catch (_) { /* continue */ }
    }

    // 尝试提取第一个 { ... } 块
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
        try { return JSON.parse(braceMatch[0]); } catch (_) { /* continue */ }
    }

    return null;
}

/**
 * 验证和标准化 LLM 返回的结构
 */
function validateAndNormalize(parsed, objective, roleLibrary) {
    if (!parsed.type || !Array.isArray(parsed.roles) || !Array.isArray(parsed.tasks)) {
        throw new Error('JSON 缺少必要字段: type, roles, tasks');
    }
    if (parsed.roles.length === 0 || parsed.tasks.length === 0) {
        throw new Error('roles 或 tasks 为空');
    }

    // 角色数量与命名约束
    if (parsed.roles.length > 8) {
        throw new Error('roles 过多（最多 8 个）');
    }
    if (parsed.tasks.length > 16) {
        throw new Error('tasks 过多（最多 16 个）');
    }

    const roleNameSeen = new Set();
    const roles = [];
    for (let i = 0; i < parsed.roles.length; i++) {
        const r = parsed.roles[i];
        const name = String(r?.name || '').trim().slice(0, 40);
        if (!name) throw new Error(`roles[${i}] 缺少 name`);
        if (roleNameSeen.has(name)) throw new Error(`角色名重复：${name}`);
        roleNameSeen.add(name);
        roles.push({
            name,
            role: String(r.role || `负责${name}相关工作`).slice(0, 200),
            color: roleLibrary[name]?.color || COLOR_POOL[i % COLOR_POOL.length],
            category: r.category || roleLibrary[name]?.category || 'business',
            model: r.model || roleLibrary[name]?.defaultModel || '',
        });
    }

    const roleNames = new Set(roles.map(r => r.name));
    const phaseSeen = new Set();
    const tasks = [];

    for (let i = 0; i < parsed.tasks.length; i++) {
        const t = parsed.tasks[i];
        const phase = String(t?.phase || '').trim().slice(0, 60);
        if (!phase) throw new Error(`tasks[${i}] 缺少 phase`);
        if (phaseSeen.has(phase)) throw new Error(`阶段名重复：${phase}`);
        phaseSeen.add(phase);

        if (!roleNames.has(t.assignee)) {
            throw new Error(`阶段「${phase}」负责人「${t.assignee}」不在 roles 中`);
        }

        let subtasks = Array.isArray(t.subtasks) ? t.subtasks.map(s => String(s).trim().slice(0, 120)).filter(Boolean) : [];
        if (subtasks.length === 0) {
            throw new Error(`阶段「${phase}」缺少可执行 subtasks`);
        }
        if (subtasks.length > 8) subtasks = subtasks.slice(0, 8);

        const dependencies = Array.isArray(t.dependencies)
            ? t.dependencies.map(d => String(d).trim()).filter(Boolean)
            : [];

        const duration = Math.min(10, Math.max(1, Number(t.duration) || 3));
        tasks.push({ phase, assignee: t.assignee, subtasks, dependencies, duration });
    }

    // 依赖必须指向存在的阶段；至少有一个无依赖起点
    for (const t of tasks) {
        for (const dep of t.dependencies) {
            if (!phaseSeen.has(dep)) {
                throw new Error(`阶段「${t.phase}」依赖不存在的阶段「${dep}」`);
            }
            if (dep === t.phase) {
                throw new Error(`阶段「${t.phase}」不能依赖自身`);
            }
        }
    }
    if (!tasks.some(t => t.dependencies.length === 0)) {
        throw new Error('至少需要一个无依赖的起始阶段');
    }

    // 简单环检测
    const graph = {};
    phaseSeen.forEach(p => { graph[p] = []; });
    tasks.forEach(t => {
        t.dependencies.forEach(dep => graph[dep].push(t.phase));
    });
    const visited = new Set();
    const stack = new Set();
    const dfs = (node) => {
        if (stack.has(node)) return true;
        if (visited.has(node)) return false;
        visited.add(node);
        stack.add(node);
        for (const next of graph[node] || []) {
            if (dfs(next)) return true;
        }
        stack.delete(node);
        return false;
    };
    for (const p of phaseSeen) {
        if (dfs(p)) throw new Error('任务依赖存在环');
    }

    return {
        type: String(parsed.type).slice(0, 80),
        roles,
        tasks,
        objective: String(objective).slice(0, 500),
        totalPhases: tasks.length,
        estimatedDuration: tasks.reduce((sum, t) => sum + t.duration, 0),
        analysis: {
            source: 'llm',
        },
    };
}

/**
 * 获取角色库（供 UI 展示或 LLM 参考）
 */
export function getRoleLibrary() {
    return getMergedRoleLibrary(ROLE_LIBRARY, COLOR_POOL);
}

export default { decomposeWithLLM, getRoleLibrary };
