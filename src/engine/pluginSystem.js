/**
 * 插件系统
 * 支持注册自定义角色模板和工具链
 */

const STORAGE_KEY = 'agent-auto-plugins';

/**
 * 插件格式定义
 * {
 *   id: string,
 *   name: string,
 *   version: string,
 *   description: string,
 *   enabled: boolean,
 *   roles: [{ name, role, color, defaultModel }],
 *   tools: [{ name, description, parameters, execute }],
 *   config: {}
 * }
 */

/** 内置示例插件 */
const BUILTIN_PLUGINS = [
    {
        id: 'plugin-ecommerce',
        name: '电商团队模板',
        version: '1.0.0',
        description: '为电商项目提供预置角色模板：产品经理、UI设计师、前端开发、后端开发、运营专员',
        enabled: false,
        roles: [
            { name: '产品经理', role: '负责产品规划、需求分析和原型设计', color: '#3B82F6' },
            { name: 'UI设计师', role: '负责界面视觉设计和交互体验', color: '#8B5CF6' },
            { name: '前端开发', role: '负责页面开发和用户端功能实现', color: '#10B981' },
            { name: '后端开发', role: '负责服务端架构、API和数据库设计', color: '#F59E0B' },
            { name: '运营专员', role: '负责市场推广、用户增长和数据分析', color: '#EF4444' },
        ],
        tools: [],
        config: {},
    },
    {
        id: 'plugin-content-creation',
        name: '内容创作团队',
        version: '1.0.0',
        description: '为自媒体内容创作提供预置角色：编导、文案、剪辑师、设计师、运营',
        enabled: false,
        roles: [
            { name: '编导', role: '负责选题策划、脚本撰写和内容方向', color: '#6366F1' },
            { name: '文案', role: '负责文案撰写、标题优化和SEO', color: '#EC4899' },
            { name: '剪辑师', role: '负责视频剪辑、特效和后期处理', color: '#14B8A6' },
            { name: '设计师', role: '负责封面设计、图文排版和视觉素材', color: '#F97316' },
            { name: '运营', role: '负责平台分发、粉丝互动和数据分析', color: '#06B6D4' },
        ],
        tools: [],
        config: {},
    },
];

/**
 * 加载所有插件（内置 + 自定义）
 */
export function loadPlugins() {
    let custom = [];
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) custom = JSON.parse(saved);
    } catch (_) { /* ignore */ }

    // 合并内置和自定义
    const all = [...BUILTIN_PLUGINS];
    for (const cp of custom) {
        const idx = all.findIndex(p => p.id === cp.id);
        if (idx >= 0) {
            all[idx] = { ...all[idx], ...cp };
        } else {
            all.push(cp);
        }
    }
    return all;
}

/**
 * 保存插件状态
 */
export function savePlugins(plugins) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plugins));
}

/**
 * 启用/禁用插件
 */
export function togglePlugin(pluginId, enabled) {
    const plugins = loadPlugins();
    const plugin = plugins.find(p => p.id === pluginId);
    if (plugin) {
        plugin.enabled = enabled;
        savePlugins(plugins);
    }
}

/**
 * 获取所有已启用的插件
 */
export function getEnabledPlugins() {
    return loadPlugins().filter(p => p.enabled);
}

/**
 * 获取已启用插件的所有角色模板
 */
export function getPluginRoles() {
    return getEnabledPlugins().flatMap(p => p.roles || []);
}

/**
 * 注册新插件
 */
export function registerPlugin(plugin) {
    const plugins = loadPlugins();
    const existing = plugins.findIndex(p => p.id === plugin.id);
    if (existing >= 0) {
        plugins[existing] = { ...plugins[existing], ...plugin };
    } else {
        plugins.push({ ...plugin, enabled: false });
    }
    savePlugins(plugins);
}

export default { loadPlugins, savePlugins, togglePlugin, getEnabledPlugins, getPluginRoles, registerPlugin };
