/**
 * 时间线事件记录 — 把关键执行事件写入 timelineStore
 */
import useTimelineStore from '../store/timelineStore.js';
import { redactSensitive, redactSensitiveDeep } from '../utils/sensitiveData.js';

export function recordTimelineEvent(type, data = {}) {
    try {
        // 时间线是可回放/可导出的公共出口，统一在边界做深度脱敏。
        const safeType = redactSensitive(String(type || 'state_change'));
        const safeData = redactSensitiveDeep(data);
        useTimelineStore.getState().addEvent(safeType, safeData);
    } catch (_) { /* 测试环境或未挂载时忽略 */ }
}

export function clearTimelineEvents() {
    try {
        useTimelineStore.getState().clearEvents();
    } catch (_) { /* ignore */ }
}

export default { recordTimelineEvent, clearTimelineEvents };
