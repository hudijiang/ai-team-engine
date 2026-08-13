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

/** 单租户记录状态机；同态可幂等 PATCH */
export const STATUS_TRANSITIONS = {
    created: ['created', 'running', 'waiting_for_config', 'blocked', 'paused'],
    running: [
        'running', 'waiting_for_config', 'waiting_for_human', 'waiting_for_decision',
        'paused', 'blocked', 'completed',
    ],
    waiting_for_config: ['waiting_for_config', 'running', 'blocked', 'paused'],
    waiting_for_human: ['waiting_for_human', 'running', 'blocked', 'paused'],
    waiting_for_decision: ['waiting_for_decision', 'running', 'blocked', 'paused'],
    paused: ['paused', 'running', 'blocked'],
    blocked: ['blocked', 'running', 'paused'],
    completed: ['completed'],
};

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

        update(id, input = {}) {
            reloadIfDurable();
            const current = memory.get(String(id || ''));
            if (!current) {
                const err = new Error('run_not_found');
                err.code = 'NOT_FOUND';
                throw err;
            }
            const patch = sanitizeInput(input, { allowPartial: true });
            if (patch.status && !canTransition(current.status, patch.status)) {
                const err = new Error(`invalid_status_transition:${current.status}->${patch.status}`);
                err.code = 'INVALID_TRANSITION';
                throw err;
            }
            const next = normalizeRecord({
                ...current,
                ...patch,
                id: current.id,
                createdAt: current.createdAt,
                updatedAt: now(),
            });
            memory.set(next.id, next);
            persist();
            return { ...next };
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

function canTransition(from, to) {
    const allowed = STATUS_TRANSITIONS[from] || [];
    return allowed.includes(to);
}

function sanitizeInput(input = {}, { allowPartial = false } = {}) {
    if (input.apiKey || input.api_key || input.secret || input.accessToken) {
        const err = new Error('provider_key_not_accepted');
        err.code = 'SECRET_REJECTED';
        throw err;
    }
    const out = {};
    if (!allowPartial || input.objective != null) {
        out.objective = String(input.objective || '').slice(0, 500);
    }
    if (!allowPartial || input.status != null) {
        out.status = ALLOWED_STATUS.has(input.status) ? input.status : (allowPartial ? undefined : 'created');
        if (out.status == null) delete out.status;
    }
    if (!allowPartial || input.sessionId !== undefined) {
        out.sessionId = input.sessionId ? String(input.sessionId).slice(0, 120) : null;
    }
    if (!allowPartial || input.checkpointType !== undefined) {
        out.checkpointType = input.checkpointType ? String(input.checkpointType).slice(0, 64) : null;
    }
    if (input.currentPhase !== undefined) {
        out.currentPhase = input.currentPhase ? String(input.currentPhase).slice(0, 80) : null;
    }
    if (Array.isArray(input.completedPhases)) {
        out.completedPhases = input.completedPhases.map(phase => String(phase).slice(0, 80)).slice(0, 32);
    }
    return out;
}

function normalizeRecord(row = {}) {
    return {
        id: String(row.id),
        type: 'run',
        objective: String(row.objective || ''),
        status: ALLOWED_STATUS.has(row.status) ? row.status : 'created',
        sessionId: row.sessionId || null,
        checkpointType: row.checkpointType || null,
        currentPhase: row.currentPhase || null,
        completedPhases: Array.isArray(row.completedPhases) ? row.completedPhases : [],
        createdAt: row.createdAt || null,
        updatedAt: row.updatedAt || null,
    };
}

export default { createRunStore };
