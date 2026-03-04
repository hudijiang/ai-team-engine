/**
 * 任务拆解引擎 - LLM 智能版
 * CEO 通过 AI 动态分析目标，智能组建团队和拆解任务
 * 完全由 LLM 驱动，不使用任何硬编码模板
 */
import { sendChat, resolveProviderForModel } from './llmClient';
import { loadProviderConfigs } from './modelConfig';
import logger from '../utils/logger';

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
 * @returns {Promise<Object>} 拆解结果 { type, roles, tasks, objective, ... }
 */
export async function decomposeWithLLM(objective, model, availableModels) {
    // 构建角色库描述，让 LLM 知道有哪些可选角色
    const roleDescriptions = Object.entries(ROLE_LIBRARY)
        .map(([name, info]) => `  - ${name}（${info.category}）：${info.role}`)
        .join('\n');

    const systemPrompt = `你是一个项目 CEO，擅长分析战略目标并组建最合适的执行团队。

## 可用角色库（可选择也可自创新角色）
${roleDescriptions}

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
    });

    // 提取 JSON
    const parsed = extractJSON(content);
    if (!parsed) {
        throw new Error(`LLM 返回内容无法解析为 JSON: ${(content || '').slice(0, 100)}`);
    }

    // 验证并标准化
    const result = validateAndNormalize(parsed, objective);
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
function validateAndNormalize(parsed, objective) {
    if (!parsed.type || !Array.isArray(parsed.roles) || !Array.isArray(parsed.tasks)) {
        throw new Error('JSON 缺少必要字段: type, roles, tasks');
    }
    if (parsed.roles.length === 0 || parsed.tasks.length === 0) {
        throw new Error('roles 或 tasks 为空');
    }

    // 为角色分配颜色（角色库有的用库颜色，否则用颜色池）
    const roles = parsed.roles.map((r, i) => ({
        name: r.name,
        role: r.role || `负责${r.name}相关工作`,
        color: ROLE_LIBRARY[r.name]?.color || COLOR_POOL[i % COLOR_POOL.length],
        category: r.category || 'business',
    }));

    // 验证 tasks 结构
    const roleNames = new Set(roles.map(r => r.name));
    const tasks = parsed.tasks.map(t => ({
        phase: t.phase,
        assignee: roleNames.has(t.assignee) ? t.assignee : roles[0].name,
        subtasks: Array.isArray(t.subtasks) && t.subtasks.length > 0
            ? t.subtasks
            : [`分析${t.phase}的需求`, `执行${t.phase}的核心工作`, `完成${t.phase}并输出成果`],
        dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
        duration: t.duration || 3,
    }));

    return {
        type: parsed.type,
        roles,
        tasks,
        objective,
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
    return ROLE_LIBRARY;
}

export default { decomposeWithLLM, getRoleLibrary };
