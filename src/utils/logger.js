/**
 * 前端日志工具 — Logger
 * 开发环境下通过 /api/log 写入服务端文件
 * 生产环境下仅 console 输出
 */

const LOG_BUFFER = [];
const FLUSH_INTERVAL = 2000;
let flushTimer = null;
let currentSessionId = null;

/**
 * 刷写缓冲区到服务端
 */
async function flush() {
    if (LOG_BUFFER.length === 0) return;
    const batch = LOG_BUFFER.splice(0);
    try {
        await fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batch),
        });
    } catch (_e) {
        // 生产环境或网络异常时静默失败
    }
}

function ensureTimer() {
    if (!flushTimer) {
        flushTimer = setInterval(flush, FLUSH_INTERVAL);
    }
}

/**
 * 写入日志
 * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'} level
 * @param {string} tag - 来源标签（如 'CEO', 'LLM', 'Store'）
 * @param {string|object} message
 */
function log(level, tag, message) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        tag,
        message,
        sessionId: currentSessionId,
    };

    // 控制台始终输出
    const consoleFn = level === 'ERROR' ? console.error
        : level === 'WARN' ? console.warn
            : level === 'DEBUG' ? console.debug
                : console.log;
    consoleFn(`[${tag}]`, message);

    // 开发环境下缓冲写文件
    if (import.meta.env.DEV) {
        LOG_BUFFER.push(entry);
        ensureTimer();
    }
}

/** 页面卸载时立即刷写 */
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        flush();
    });
}

const logger = {
    debug: (tag, msg) => log('DEBUG', tag, msg),
    info: (tag, msg) => log('INFO', tag, msg),
    warn: (tag, msg) => log('WARN', tag, msg),
    error: (tag, msg) => log('ERROR', tag, msg),
    flush, // 手动刷写
    /** 开始新会话，后续日志写入独立文件 */
    startSession(id) {
        currentSessionId = id || `session-${Date.now()}`;
        log('INFO', 'Session', `=== 新会话开始: ${currentSessionId} ===`);
        return currentSessionId;
    },
    getSessionId() { return currentSessionId; },
};

export default logger;
