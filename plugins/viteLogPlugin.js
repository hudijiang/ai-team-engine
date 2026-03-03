/**
 * Vite 开发服务器日志中间件
 * 接收前端 POST /api/log 请求，写入 logs/ 目录
 */
import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve(process.cwd(), 'logs');

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

            server.middlewares.use('/api/log', (req, res) => {
                if (req.method !== 'POST') {
                    res.statusCode = 405;
                    res.end('Method Not Allowed');
                    return;
                }

                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    try {
                        const entries = JSON.parse(body);
                        const parsed = (Array.isArray(entries) ? entries : [entries]);
                        // 按 sessionId 分组写入不同文件
                        const groups = {};
                        for (const e of parsed) {
                            const sid = e.sessionId || '__default__';
                            if (!groups[sid]) groups[sid] = [];
                            const ts = e.timestamp || new Date().toISOString();
                            const level = (e.level || 'INFO').toUpperCase().padEnd(5);
                            const tag = e.tag ? `[${e.tag}]` : '';
                            const msg = typeof e.message === 'string'
                                ? e.message
                                : JSON.stringify(e.message);
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
                        res.end(`{"error":"${err.message}"}`);
                    }
                });
            });

            console.log(`[vite-log-plugin] 日志将写入 ${LOG_DIR}/`);
        },
    };
}
