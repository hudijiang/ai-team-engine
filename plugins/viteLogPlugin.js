/**
 * Vite 开发服务器日志中间件
 * 接收前端 POST /api/log 请求，写入 logs/ 目录
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOG_DIR = path.resolve(process.cwd(), 'logs');

/** 与前端共用同一脱敏模块；异步加载，未就绪时用扩展正则回退 */
let redactSensitive = (msg) => String(msg ?? '')
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_API_KEY]');

void (async () => {
    try {
        const sensitivePath = path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '../src/utils/sensitiveData.js'
        );
        const mod = await import(pathToFileURL(sensitivePath).href);
        if (typeof mod.redactSensitive === 'function') {
            redactSensitive = mod.redactSensitive;
        }
    } catch (_) { /* 使用回退规则 */ }
})();

/** 确保日志目录存在 */
function ensureLogDir() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

/** 获取日志文件路径（按 sessionId 或按天） */
function getLogFile(sessionId) {
    if (sessionId) {
        // 保留中文字符，只移除文件系统不安全的字符（/\:*?"<>| 等）
        const safe = sessionId.replace(/[\/\\:*?"<>|\s]/g, '_').replace(/_+/g, '_');
        return path.join(LOG_DIR, `${safe}.log`);
    }
    const date = new Date().toISOString().slice(0, 10);
    return path.join(LOG_DIR, `agent-${date}.log`);
}

/**
 * Vite 插件：开发服务器日志写文件
 */
export default function viteLogPlugin() {
    return {
        name: 'vite-plugin-file-logger',
        configureServer(server) {
            ensureLogDir();

            const MAX_BODY_BYTES = 64 * 1024; // 64KB / 请求
            const MAX_ENTRIES = 50;

            server.middlewares.use('/api/log', (req, res) => {
                // 仅本机开发：拒绝异常 method，限制体积
                if (req.method !== 'POST') {
                    res.statusCode = 405;
                    res.end('Method Not Allowed');
                    return;
                }

                let body = '';
                let truncated = false;
                req.on('data', chunk => {
                    if (body.length + chunk.length > MAX_BODY_BYTES) {
                        truncated = true;
                        return;
                    }
                    body += chunk;
                });
                req.on('end', () => {
                    if (truncated) {
                        res.statusCode = 413;
                        res.end('{"error":"payload too large"}');
                        return;
                    }
                    try {
                        const entries = JSON.parse(body);
                        const parsed = (Array.isArray(entries) ? entries : [entries]).slice(0, MAX_ENTRIES);
                        // 按 sessionId 分组写入不同文件
                        const groups = {};
                        for (const e of parsed) {
                            const sid = e.sessionId || '__default__';
                            if (!groups[sid]) groups[sid] = [];
                            const ts = e.timestamp || new Date().toISOString();
                            const level = (e.level || 'INFO').toUpperCase().padEnd(5);
                            const tag = e.tag ? `[${e.tag}]` : '';
                            let msg = typeof e.message === 'string'
                                ? e.message
                                : JSON.stringify(e.message);
                            msg = redactSensitive(String(msg)).slice(0, 4000);
                            groups[sid].push(`${ts} ${level} ${tag} ${msg}`);
                        }

                        for (const [sid, lines] of Object.entries(groups)) {
                            const file = sid === '__default__'
                                ? getLogFile(null)
                                : getLogFile(sid);
                            fs.appendFileSync(file, lines.join('\n') + '\n', 'utf-8');
                        }

                        res.setHeader('Content-Type', 'application/json');
                        res.statusCode = 200;
                        res.end('{"ok":true}');
                    } catch (err) {
                        console.error('[vite-log-plugin] parse error:', err.message);
                        res.statusCode = 400;
                        res.end(JSON.stringify({ error: String(err.message || 'bad request') }));
                    }
                });
            });

            console.log(`[vite-log-plugin] 日志将写入 ${LOG_DIR}/`);
        },
    };
}
