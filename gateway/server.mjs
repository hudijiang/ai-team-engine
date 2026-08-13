/**
 * 最小单租户 LLM Gateway
 *
 * - 浏览器只持有 GATEWAY_TOKEN，供应商 raw key 只在服务端
 * - 上游主机白名单 + 拒绝私网地址（服务端代发时的 SSRF 防护）
 * - 运行记录落盘（关页后记录仍在；Agent 不会继续跑）
 * - 内存令牌桶限流
 *
 * 默认不随前端启动。用法见 gateway/README.md
 */
import http from 'node:http';
import path from 'node:path';
import { createGatewayHandler } from './handler.mjs';
import { createRunStore } from './runStore.mjs';

const PORT = Number(process.env.GATEWAY_PORT || 8787);
const HOST = process.env.GATEWAY_HOST || '127.0.0.1';
const MAX_BODY_BYTES = Number(process.env.GATEWAY_MAX_BODY_BYTES || 512_000);
const DATA_DIR = process.env.GATEWAY_DATA_DIR
    || path.join(process.cwd(), 'data', 'gateway-runs');

const CORS_ORIGIN = Reflect.get(process, 'env').GATEWAY_CORS_ORIGIN || 'http://localhost:5173';

if (HOST === '0.0.0.0') {
    // eslint-disable-next-line no-console
    console.warn('[gateway] HOST=0.0.0.0 is not recommended; bind 127.0.0.1 behind a reverse proxy/TLS');
}

const handler = createGatewayHandler({
    token: process.env.GATEWAY_TOKEN || '',
    rpm: Number(process.env.GATEWAY_RPM || 30),
    corsOrigin: process.env.GATEWAY_CORS_ORIGIN || 'http://localhost:5173',
    maxBodyChars: MAX_BODY_BYTES,
    runStore: createRunStore({ dir: DATA_DIR }),
    providerKeys: {
        openai: process.env.OPENAI_API_KEY || '',
        anthropic: process.env.ANTHROPIC_API_KEY || '',
        deepseek: process.env.DEEPSEEK_API_KEY || '',
        alibaba: process.env.DASHSCOPE_API_KEY || process.env.ALIBABA_API_KEY || '',
        zhipu: process.env.ZHIPU_API_KEY || '',
        custom: process.env.CUSTOM_API_KEY || '',
    },
    extraAllowHosts: (process.env.GATEWAY_ALLOW_HOSTS || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean),
});

const server = http.createServer(async (req, res) => {
    try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                res.writeHead(413, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Access-Control-Allow-Origin': CORS_ORIGIN,
                });
                res.end(JSON.stringify({ error: 'payload_too_large' }));
                return;
            }
            chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        const result = await handler({
            method: req.method || 'GET',
            url: req.url || '/',
            headers: req.headers,
            body: raw,
        });
        res.writeHead(result.status, {
            'Content-Type': result.contentType || 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...result.headers,
        });
        res.end(result.body);
    } catch (err) {
        // 不把文件路径、解析异常等内部细节返回浏览器。
        res.writeHead(500, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': CORS_ORIGIN,
        });
        res.end(JSON.stringify({ error: 'internal_error' }));
    }
});

server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`[gateway] single-tenant LLM proxy listening on http://${HOST}:${PORT}`);
    if (!process.env.GATEWAY_TOKEN) {
        // eslint-disable-next-line no-console
        console.warn('[gateway] GATEWAY_TOKEN is empty — all /api/llm/chat requests will be rejected');
    }
});
