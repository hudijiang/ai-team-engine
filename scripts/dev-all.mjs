/**
 * 同时启动 Vite 与本机 Gateway（单租户开发）。
 * Gateway 默认 127.0.0.1:8787；未设置 GATEWAY_TOKEN 时仍可起进程，但 chat/runs 会 401。
 */
import { spawn } from 'node:child_process';

const children = [];

function run(name, command, args, extraEnv = {}) {
    const child = spawn(command, args, {
        stdio: 'inherit',
        env: { ...process.env, ...extraEnv },
        shell: false,
    });
    child.on('exit', (code) => {
        console.log(`[dev-all] ${name} exited (${code})`);
        for (const item of children) {
            if (!item.killed) item.kill('SIGTERM');
        }
        process.exit(code ?? 0);
    });
    children.push(child);
}

run('vite', 'npm', ['run', 'dev']);
run('gateway', 'npm', ['run', 'gateway']);

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        for (const child of children) {
            if (!child.killed) child.kill(signal);
        }
    });
}
