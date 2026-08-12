/**
 * 敏感信息分类与脱敏（商用 P0）
 *
 * 原则：
 * 1. HITL 人工门禁输入默认视为不透明凭据，不依赖正则猜测
 * 2. 通用文本出口（报告/日志）仍做模式脱敏作为第二道防线
 */

/** 高风险任务关键词（用于是否触发 HITL，而非决定是否脱敏） */
export const HIGH_RISK_HITL_PATTERN = /登录|登陆|扫码|验证码|短信|支付|付款|转账|密码|口令|token|授权|oauth|人脸|指纹|实名|银行卡|cvv|私钥|secret|api\s*key|credential|password|otp|2fa|mfa/i;

/** 通用敏感片段（字段级 + 供应商常见密钥前缀） */
const SENSITIVE_PATTERNS = [
    { re: /(验证码|短信码|动态码|授权码|密码|口令|token|api[_\s-]?key|secret|bearer)\s*[:：=]\s*([^\s,;，；]{4,})/gi, replace: '$1: [REDACTED]' },
    { re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replace: 'Bearer [REDACTED]' },
    { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: '[REDACTED_JWT]' },
    { re: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/g, replace: '[REDACTED_API_KEY]' },
    { re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, replace: '[REDACTED_API_KEY]' },
    { re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replace: '[REDACTED_API_KEY]' },
    { re: /\bghp_[A-Za-z0-9]{20,}\b/g, replace: '[REDACTED_API_KEY]' },
    { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: '[REDACTED_API_KEY]' },
    { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: '[REDACTED_API_KEY]' },
    { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: '[REDACTED_API_KEY]' },
    // 不再无上下文替换所有 4–8 位数字（会破坏年份/金额/订单量）。
    // HITL 凭据走不透明通道；仅在「验证码」标签语境下脱敏数字。
    { re: /(验证码|短信码|动态码|otp|OTP)\s*[:：=]?\s*(\d{4,8})\b/g, replace: '$1: [REDACTED_CODE]' },
];

export function isHighRiskHumanTask(text = '') {
    return HIGH_RISK_HITL_PATTERN.test(String(text || ''));
}

/**
 * 脱敏文本（用于日志、消息、报告、导出）
 */
export function redactSensitive(text) {
    if (text == null) return text;
    if (typeof text !== 'string') {
        try {
            return redactSensitive(JSON.stringify(text));
        } catch (_) {
            return String(text);
        }
    }

    let out = text;
    for (const { re, replace } of SENSITIVE_PATTERNS) {
        out = out.replace(re, replace);
    }
    return out;
}

/**
 * 递归脱敏对象中的字符串字段
 */
export function redactSensitiveDeep(value, depth = 0) {
    if (typeof value === 'string') return redactSensitive(value);
    // 深度上限必须 fail-closed；返回原对象会让深层凭据绕过公共出口。
    if (depth > 6) {
        return value && typeof value === 'object' ? '[REDACTED_NESTED]' : value;
    }
    if (Array.isArray(value)) return value.map(v => redactSensitiveDeep(v, depth + 1));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const keySensitive = /password|secret|token|apikey|api_key|authorization|验证码|credential/i.test(k);
            out[k] = keySensitive && typeof v === 'string'
                ? '[REDACTED]'
                : redactSensitiveDeep(v, depth + 1);
        }
        return out;
    }
    return value;
}

/**
 * 人工协助信息：供模型使用的受控摘要
 *
 * 默认 fail-closed：凡经 HITL 门禁的输入一律视为不透明凭据，
 * 永不把用户原文注入 Prompt（不依赖关键词猜测）。
 *
 * @param {string} rawInput
 * @param {string} [subtask]
 * @param {{ allowPlaintext?: boolean }} [options] 仅测试/显式白名单可放行明文（默认 false）
 */
export function buildSafeHumanAssistContext(rawInput, subtask = '', options = {}) {
    const raw = String(rawInput || '').trim();
    if (!raw) return '';

    // 默认：HITL 输入永不进入 Prompt 原文
    if (!options.allowPlaintext) {
        return [
            '董事长已在人工协助门禁中确认本步骤可继续。',
            '系统已接收协助凭据（内容按不透明凭据处理，不会在日志或 Prompt 中保存原文）。',
            subtask ? `相关子任务：「${String(subtask).slice(0, 80)}」。` : '',
            '请假设所需登录/授权/验证/人工确认步骤已由人类完成，基于该前提继续产出后续工作成果。',
            '不要在输出中复述任何验证码、密码、Token、密钥或用户输入原文。',
        ].filter(Boolean).join('\n');
    }

    return redactSensitive(raw);
}

/**
 * 展示给对话流的人工协助确认文案（默认不含任何用户原文）
 */
export function buildHumanAssistPublicMessage(rawInput, subtask = '', options = {}) {
    if (!options.allowPlaintext) {
        return '【系统】已接收董事长协助（内容按不透明凭据处理，未写入对话/日志/Prompt 原文）。';
    }
    const safe = redactSensitive(String(rawInput || '').slice(0, 80));
    return `【系统】已接收董事长协助：${safe}${String(rawInput || '').length > 80 ? '…' : ''}`;
}

export default {
    HIGH_RISK_HITL_PATTERN,
    isHighRiskHumanTask,
    redactSensitive,
    redactSensitiveDeep,
    buildSafeHumanAssistContext,
    buildHumanAssistPublicMessage,
};
