/**
 * 单租户运行记录存储。
 * 文件落盘后，创建请求结束后（甚至新 handler 实例）仍可按 id 读回。
 * 这是记录耐久性，不是浏览器关页后继续跑 Agent。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSensitive } from '../src/utils/sensitiveData.js';

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
    let diskCorrupt = false;
    let memory = new Map();
    try {
        memory = loadFromDisk(filePath);
    } catch (err) {
        if (err?.code === 'CORRUPT') diskCorrupt = true;
        else throw err;
    }

    function persist() {
        if (!filePath || diskCorrupt) return;
        mkdirSync(dirname(filePath), { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.tmp`;
        const payload = JSON.stringify({ records: [...memory.values()] }, null, 2);
        writeFileSync(tmpPath, payload, 'utf8');
        renameSync(tmpPath, filePath);
        try {
            writeFileSync(`${filePath}.bak`, payload, 'utf8');
        } catch (_) { /* backup is best-effort */ }
    }

    function reloadIfDurable() {
        if (!filePath) return;
        if (diskCorrupt) {
            const err = new Error('run_store_corrupt');
            err.code = 'CORRUPT';
            throw err;
        }
        try {
            memory = loadFromDisk(filePath);
        } catch (err) {
            if (err?.code === 'CORRUPT') {
                diskCorrupt = true;
            }
            throw err;
        }
    }

    return {
        create(input = {}) {
            reloadIfDurable();
            const record = normalizeRecord({
                ...sanitizeInput(input),
                id: createId(),
                revision: 1,
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
            if (input.revision != null && Number(input.revision) !== Number(current.revision)) {
                const err = new Error(`stale_revision:${input.revision}!=${current.revision}`);
                err.code = 'STALE_REVISION';
                throw err;
            }
            if (patch.status && !canTransition(current.status, patch.status)) {
                const err = new Error(`invalid_status_transition:${current.status}->${patch.status}`);
                err.code = 'INVALID_TRANSITION';
                throw err;
            }
            const next = normalizeRecord({
                ...current,
                ...patch,
                id: current.id,
                revision: Number(current.revision || 1) + 1,
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

        remove(id) {
            reloadIfDurable();
            const key = String(id || '');
            if (!memory.has(key)) {
                const err = new Error('run_not_found');
                err.code = 'NOT_FOUND';
                throw err;
            }
            memory.delete(key);
            persist();
            return true;
        },

        isCorrupt() {
            return diskCorrupt;
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
    } catch (err) {
        if (err?.code === 'ENOENT') return map;
        const corrupt = new Error('run_store_corrupt');
        corrupt.code = 'CORRUPT';
        throw corrupt;
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
        out.objective = redactSensitive(String(input.objective || '')).slice(0, 500);
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
    if (input.lastError !== undefined) {
        out.lastError = input.lastError
            ? redactSensitive(String(input.lastError)).slice(0, 400)
            : null;
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
        lastError: row.lastError || null,
        revision: Number(row.revision) > 0 ? Number(row.revision) : 1,
        createdAt: row.createdAt || null,
        updatedAt: row.updatedAt || null,
    };
}

export default { createRunStore };
