/**
 * 时间线事件存储
 * 记录执行过程中的所有关键事件，用于任务执行回放
 */
import { create } from 'zustand';

const useTimelineStore = create((set, get) => ({
    events: [],
    isPlaying: false,
    playbackIndex: 0,
    playbackSpeed: 1,

    /**
     * 记录事件
     * @param {string} type - state_change | message | decision | collaboration | tool_call
     * @param {object} data - 事件数据
     */
    addEvent: (type, data) => set(state => ({
        events: [...state.events, {
            id: state.events.length,
            timestamp: new Date().toISOString(),
            type,
            ...data,
        }],
    })),

    /** 开始回放 */
    startPlayback: () => set({ isPlaying: true, playbackIndex: 0 }),

    /** 暂停回放 */
    pausePlayback: () => set({ isPlaying: false }),

    /** 设置回放位置 */
    setPlaybackIndex: (index) => set({ playbackIndex: index }),

    /** 设置回放速度 */
    setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),

    /** 前进一步 */
    stepForward: () => set(state => ({
        playbackIndex: Math.min(state.playbackIndex + 1, state.events.length - 1),
    })),

    /** 清空事件 */
    clearEvents: () => set({ events: [], playbackIndex: 0, isPlaying: false }),

    /** 获取按 Agent 分组的事件 */
    getEventsByAgent: () => {
        const events = get().events;
        const grouped = {};
        events.forEach(e => {
            const agent = e.agentName || e.agentId || 'system';
            if (!grouped[agent]) grouped[agent] = [];
            grouped[agent].push(e);
        });
        return grouped;
    },
}));

export default useTimelineStore;
