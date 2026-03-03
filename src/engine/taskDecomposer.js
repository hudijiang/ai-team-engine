/**
 * 任务拆解引擎 - 智能版
 * CEO 根据目标语义动态分析，智能组建团队和拆解任务
 * 不再依赖固定模板，而是通过语义分析生成最合适的团队结构
 */

/**
 * 角色库 - CEO 可从中选择或自定义
 * 每个角色代表一个可用的能力单元
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
 * 语义分析规则
 * 根据目标中的关键词推断需要的能力领域和角色
 */
const SEMANTIC_RULES = [
    // 赚钱/商业目标 → 商业团队
    {
        triggers: ['赚钱', '盈利', '收入', '变现', '商业', '创业', '副业', '被动收入', '财务自由', '投资', '理财'],
        roles: ['商业分析师', '市场策划', '运营专家', '财务分析师'],
        type: '商业策略',
        phases: (obj) => [
            { phase: '商业机会分析', assignee: '商业分析师', subtasks: [`分析「${obj}」的市场背景`, '评估潜在商业模式', '识别目标客户群', '分析竞争格局'], dependencies: [], duration: 3 },
            { phase: '营销策略制定', assignee: '市场策划', subtasks: ['制定获客策略', '设计营销漏斗', '规划推广渠道', '制定预算方案'], dependencies: ['商业机会分析'], duration: 3 },
            { phase: '运营方案设计', assignee: '运营专家', subtasks: ['设计运营流程', '搭建执行体系', '制定增长计划', '建立反馈机制'], dependencies: ['营销策略制定'], duration: 4 },
            { phase: '财务规划', assignee: '财务分析师', subtasks: ['成本结构分析', '制定盈利模型', '投资回报预测', '风险评估报告'], dependencies: ['商业机会分析'], duration: 3 },
        ],
    },

    // 软件/技术开发
    {
        triggers: ['开发', '编程', '代码', '程序', '软件', '系统', '平台', '应用', 'app', '小程序', '网站', '网页', 'API', '数据库'],
        roles: ['产品经理', 'UI设计师', '前端工程师', '后端工程师', '测试工程师'],
        type: '软件开发',
        phases: (obj) => [
            { phase: '需求分析', assignee: '产品经理', subtasks: ['分析战略目标', '调研市场需求', '编写需求文档', '定义功能列表'], dependencies: [], duration: 3 },
            { phase: 'UI设计', assignee: 'UI设计师', subtasks: ['确定设计风格', '制作原型图', '设计UI组件', '输出设计规范'], dependencies: ['需求分析'], duration: 3 },
            { phase: '前端开发', assignee: '前端工程师', subtasks: ['搭建项目框架', '实现页面布局', '开发交互功能', '接入后端API'], dependencies: ['UI设计'], duration: 5 },
            { phase: '后端开发', assignee: '后端工程师', subtasks: ['设计数据模型', '开发API接口', '实现业务逻辑', '配置部署环境'], dependencies: ['需求分析'], duration: 5 },
            { phase: '测试验收', assignee: '测试工程师', subtasks: ['编写测试用例', '执行功能测试', '性能压力测试', '输出测试报告'], dependencies: ['前端开发', '后端开发'], duration: 3 },
        ],
    },

    // 营销/品牌推广
    {
        triggers: ['营销', '推广', '品牌', '广告', '运营', '增长', '获客', '引流', '粉丝', '流量', '传播', '种草', '带货'],
        roles: ['市场策划', '内容创作者', '设计师', '数据分析师'],
        type: '营销推广',
        phases: (obj) => [
            { phase: '战略规划', assignee: '市场策划', subtasks: ['市场调研', '竞品分析', '制定营销策略', '规划执行方案'], dependencies: [], duration: 3 },
            { phase: '内容制作', assignee: '内容创作者', subtasks: ['撰写核心文案', '创作推广内容', '准备发布素材', '审核内容质量'], dependencies: ['战略规划'], duration: 4 },
            { phase: '视觉设计', assignee: '设计师', subtasks: ['设计主视觉', '制作推广物料', '适配多平台素材', '输出设计文件'], dependencies: ['战略规划'], duration: 4 },
            { phase: '效果追踪', assignee: '数据分析师', subtasks: ['搭建追踪体系', '收集运营数据', '分析投放效果', '输出优化建议'], dependencies: ['内容制作', '视觉设计'], duration: 3 },
        ],
    },

    // 内容/自媒体
    {
        triggers: ['内容', '自媒体', '短视频', '直播', '抖音', '小红书', '公众号', 'B站', '视频号', '写作', '博客', '播客'],
        roles: ['内容创作者', '视频制作', '设计师', '运营专家'],
        type: '内容创作',
        phases: (obj) => [
            { phase: '内容策划', assignee: '内容创作者', subtasks: [`分析「${obj}」定位`, '制定内容策略', '确定内容类型', '建立内容日历'], dependencies: [], duration: 3 },
            { phase: '视频/素材制作', assignee: '视频制作', subtasks: ['编写脚本', '拍摄/录制素材', '后期剪辑制作', '优化发布格式'], dependencies: ['内容策划'], duration: 4 },
            { phase: '视觉包装', assignee: '设计师', subtasks: ['设计账号视觉', '制作封面模板', '设计品牌元素', '产出设计资产'], dependencies: ['内容策划'], duration: 3 },
            { phase: '分发运营', assignee: '运营专家', subtasks: ['制定分发策略', '管理多平台发布', '社群互动运营', '数据复盘优化'], dependencies: ['视频/素材制作', '视觉包装'], duration: 4 },
        ],
    },

    // 研究/分析
    {
        triggers: ['研究', '分析', '调研', '报告', '评估', '论文', '考察', '洞察'],
        roles: ['首席研究员', '数据分析师', '报告撰写员'],
        type: '研究分析',
        phases: (obj) => [
            { phase: '研究设计', assignee: '首席研究员', subtasks: ['确定研究范围', '设计研究方法', '制定研究计划', '分配研究任务'], dependencies: [], duration: 2 },
            { phase: '数据分析', assignee: '数据分析师', subtasks: ['采集相关数据', '清洗整理数据', '执行分析模型', '提炼关键发现'], dependencies: ['研究设计'], duration: 4 },
            { phase: '报告输出', assignee: '报告撰写员', subtasks: ['整合研究成果', '撰写研究报告', '制作数据可视化', '提交最终成果'], dependencies: ['数据分析'], duration: 3 },
        ],
    },

    // 教育/培训
    {
        triggers: ['教育', '培训', '课程', '教学', '学习', '考试', '辅导', '技能'],
        roles: ['课程设计师', '讲师', '内容创作者'],
        type: '教育培训',
        phases: (obj) => [
            { phase: '课程体系设计', assignee: '课程设计师', subtasks: [`分析「${obj}」教学目标`, '设计课程大纲', '制定学习路径', '设计评估标准'], dependencies: [], duration: 3 },
            { phase: '教学内容开发', assignee: '讲师', subtasks: ['编写教学内容', '设计实践案例', '录制教学视频', '准备教学资料'], dependencies: ['课程体系设计'], duration: 5 },
            { phase: '辅助资料制作', assignee: '内容创作者', subtasks: ['编写配套文档', '制作学习手册', '设计练习题库', '整理参考资源'], dependencies: ['课程体系设计'], duration: 3 },
        ],
    },

    // 规划/方案
    {
        triggers: ['方案', '计划', '规划', '战略', '策略', '路线图', '蓝图'],
        roles: ['商业分析师', '项目经理', '质量专员'],
        type: '方案规划',
        phases: (obj) => [
            { phase: '现状分析', assignee: '商业分析师', subtasks: [`分析「${obj}」现状`, '评估内外部环境', '识别关键问题', '梳理资源条件'], dependencies: [], duration: 3 },
            { phase: '方案制定', assignee: '项目经理', subtasks: ['确定目标体系', '设计实施路径', '制定时间表', '分配资源计划'], dependencies: ['现状分析'], duration: 4 },
            { phase: '方案评审', assignee: '质量专员', subtasks: ['可行性评估', '风险分析', '成本效益分析', '输出最终方案'], dependencies: ['方案制定'], duration: 2 },
        ],
    },
];

/**
 * 可选颜色池
 */
const COLOR_POOL = ['#7C3AED', '#EC4899', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#06B6D4', '#8B5CF6', '#84CC16', '#F97316'];

/**
 * 智能分析目标，匹配最佳语义规则
 * @param {string} objective
 * @returns {{ rule: object, matchScore: number, matchedKeywords: string[] }}
 */
function analyzeObjective(objective) {
    const lower = objective.toLowerCase();
    let bestMatch = null;
    let bestScore = 0;
    let bestKeywords = [];

    for (const rule of SEMANTIC_RULES) {
        const matched = rule.triggers.filter(kw => lower.includes(kw));
        const score = matched.length;
        if (score > bestScore) {
            bestScore = score;
            bestMatch = rule;
            bestKeywords = matched;
        }
    }

    return { rule: bestMatch, matchScore: bestScore, matchedKeywords: bestKeywords };
}

/**
 * 根据目标动态生成自定义团队（当无规则匹配时）
 * CEO 主动分析目标语义，创造性地组建团队
 * @param {string} objective
 * @returns {{ type: string, roles: Array, phases: Function }}
 */
function generateCustomTeam(objective) {
    const roles = [
        { name: '首席策划师', role: `负责分析「${objective}」并制定整体策略`, color: COLOR_POOL[0] },
        { name: '执行负责人', role: `负责「${objective}」的具体落地和执行`, color: COLOR_POOL[2] },
        { name: '质量审核员', role: '负责成果审核、风险评估和持续优化', color: COLOR_POOL[3] },
    ];

    const phases = () => [
        {
            phase: '深度分析与策划',
            assignee: '首席策划师',
            subtasks: [`深度分析「${objective}」的核心要素`, '调研相关领域最佳实践', '制定可行性方案', '输出执行路线图'],
            dependencies: [],
            duration: 3,
        },
        {
            phase: '方案执行',
            assignee: '执行负责人',
            subtasks: ['按路线图推进执行', '处理执行中的问题', '记录关键进展', '完成阶段性交付'],
            dependencies: ['深度分析与策划'],
            duration: 5,
        },
        {
            phase: '成果审核与优化',
            assignee: '质量审核员',
            subtasks: ['审核执行成果', '评估目标达成度', '提出优化建议', '输出总结报告'],
            dependencies: ['方案执行'],
            duration: 2,
        },
    ];

    return { type: '自定义方案', roles, phases };
}

/**
 * 拆解战略目标为可执行任务（智能版）
 * CEO 根据目标语义动态:
 * 1. 分析目标属于什么领域
 * 2. 从角色库中选择或自定义最合适的团队
 * 3. 生成针对性的任务阶段和子任务
 *
 * @param {string} objective - 战略目标
 * @returns {{ roles: Array, tasks: Array, type: string, analysis: object }}
 */
export function decomposeObjective(objective) {
    const analysis = analyzeObjective(objective);

    let type, roles, tasks;

    if (analysis.rule && analysis.matchScore > 0) {
        // 匹配到语义规则 → 使用对应团队
        type = analysis.rule.type;
        roles = analysis.rule.roles.map((name, i) => ({
            name,
            ...ROLE_LIBRARY[name],
            color: ROLE_LIBRARY[name]?.color || COLOR_POOL[i % COLOR_POOL.length],
        }));
        tasks = analysis.rule.phases(objective);
    } else {
        // 无匹配 → CEO 自主创建定制团队
        const custom = generateCustomTeam(objective);
        type = custom.type;
        roles = custom.roles;
        tasks = custom.phases();
    }

    return {
        type,
        roles,
        tasks,
        objective,
        totalPhases: tasks.length,
        estimatedDuration: tasks.reduce((sum, t) => sum + t.duration, 0),
        analysis: {
            matchScore: analysis.matchScore,
            matchedKeywords: analysis.matchedKeywords,
            isCustomTeam: analysis.matchScore === 0,
        },
    };
}

/**
 * 获取角色库（供 UI 展示或 CEO 选择）
 */
export function getRoleLibrary() {
    return ROLE_LIBRARY;
}

export default { decomposeObjective, getRoleLibrary };
