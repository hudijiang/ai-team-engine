/**
 * 单租户运行记录存储。
 * 文件落盘后，创建请求结束后（甚至新 handler 实例）仍可按 id 读回。
 * 这是记录耐久性，不是浏览器关页后继续跑 Agent。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ALLOWED_STATUS = new Set([
    'created',
    'running',
    'paused',
    'blocked',
    'completed',
    'waiting_for_config',
    'waiting_for_human',
    'waiting_for_decision',
]);

export function createRunStore(options = {}) {
    const filePath = options.filePath
        || (options.dir ? join(options.dir, 'runs.json') : null);
    const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
    const createId = typeof options.createId === 'function' ? options.createId : () => randomUUID();
    let memory = loadFromDisk(filePath);

    function persist() {
        if (!filePath) return;
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, JSON.stringify({ records: [...memory.values()] }, null, 2), 'utf8');
    }

    function reloadIfDurable() {
        if (!filePath) return;
        memory = loadFromDisk(filePath);
    }

    return {
        create(input = {}) {
            reloadIfDurable();
            const record = normalizeRecord({
                ...sanitizeInput(input),
                id: createId(),
                createdAt: now(),
                updatedAt: now(),
            });
            memory.set(record.id, record);
            persist();
            return { ...record };
        },

        get(id) {
            reloadIfDurable();
            const record = memory.get(String(id || ''));
            return record ? { ...record } : null;
        },

        list() {
            reloadIfDurable();
            return [...memory.values()].map(record => ({ ...record }));
        },
    };
}

function loadFromDisk(filePath) {
    const map = new Map();
    if (!filePath || !existsSync(filePath)) return map;
    try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        const rows = Array.isArray(parsed?.records) ? parsed.records : [];
        for (const row of rows) {
            if (row?.id) map.set(row.id, normalizeRecord(row));
        }
    } catch (_) {
        return map;
    }
    return map;
}

function sanitizeInput(input = {}) {
    if (input.apiKey || input.api_key || input.secret || input.accessToken) {
        const err = new Error('provider_key_not_accepted');
        err.code = 'SECRET_REJECTED';
        throw err;
    }
    return {
        objective: String(input.objective || '').slice(0, 500),
        status: ALLOWED_STATUS.has(input.status) ? input.status : 'created',
        sessionId: input.sessionId ? String(input.sessionId).slice(0, 120) : null,
        checkpointType: input.checkpointType ? String(input.checkpointType).slice(0, 64) : null,
    };
}

function normalizeRecord(row = {}) {
    return {
        id: String(row.id),
        type: 'run',
        objective: String(row.objective || ''),
        status: ALLOWED_STATUS.has(row.status) ? row.status : 'created',
        sessionId: row.sessionId || null,
        checkpointType: row.checkpointType || null,
        createdAt: row.createdAt || null,
        updatedAt: row.updatedAt || null,
    };
}

export default { createRunStore };
