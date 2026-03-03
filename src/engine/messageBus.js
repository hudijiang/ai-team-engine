/**
 * 消息总线 - Agent 间通信核心
 * 提供事件发布/订阅、消息记录和审计功能
 */

/** 消息历史最大条数 */
const MAX_HISTORY = 500;

class MessageBus {
    constructor() {
        /** @type {Map<string, Function[]>} */
        this.subscribers = new Map();
        /** @type {Array} 全局消息历史 */
        this.history = [];
        /** @type {Function|null} 状态变更监听器 */
        this.onMessageCallback = null;
    }

    /**
     * 订阅特定频道的消息
     * @param {string} channel - 频道名称
     * @param {Function} callback - 回调函数
     * @returns {Function} 取消订阅函数
     */
    subscribe(channel, callback) {
        if (!this.subscribers.has(channel)) {
            this.subscribers.set(channel, []);
        }
        this.subscribers.get(channel).push(callback);

        // 返回取消订阅函数
        return () => {
            const subs = this.subscribers.get(channel);
            if (subs) {
                const idx = subs.indexOf(callback);
                if (idx > -1) subs.splice(idx, 1);
            }
        };
    }

    /**
     * 发布消息到指定频道
     * @param {string} channel - 频道名称
     * @param {object} message - 结构化消息
     */
    publish(channel, message) {
        const envelope = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            channel,
            timestamp: new Date().toISOString(),
            ...message,
        };

        // 记录到历史（限制上限）
        this.history.push(envelope);
        if (this.history.length > MAX_HISTORY) {
            this.history.shift();
        }

        // 通知全局监听器
        if (this.onMessageCallback) {
            this.onMessageCallback(envelope);
        }

        // 通知频道订阅者
        const subs = this.subscribers.get(channel) || [];
        subs.forEach(cb => cb(envelope));

        // 广播频道通知所有订阅者
        const broadcastSubs = this.subscribers.get('*') || [];
        broadcastSubs.forEach(cb => cb(envelope));

        return envelope;
    }

    /**
     * 发送 Agent 间直接消息
     * @param {string} fromId - 发送方 Agent ID
     * @param {string} toId - 接收方 Agent ID
     * @param {object} structuredMessage - 结构化消息体
     */
    sendAgentMessage(fromId, toId, structuredMessage) {
        return this.publish(`agent:${toId}`, {
            from: fromId,
            to: toId,
            type: 'agent-message',
            payload: structuredMessage,
        });
    }

    /**
     * 广播系统事件
     * @param {string} eventType - 事件类型
     * @param {object} data - 事件数据
     */
    broadcastEvent(eventType, data) {
        return this.publish('system', {
            type: eventType,
            payload: data,
        });
    }

    /**
     * 设置全局消息监听器
     * @param {Function} callback
     */
    setMessageListener(callback) {
        this.onMessageCallback = callback;
    }

    /**
     * 获取消息历史
     * @param {object} filter - 过滤条件
     * @returns {Array}
     */
    getHistory(filter = {}) {
        let result = [...this.history];
        if (filter.channel) {
            result = result.filter(m => m.channel === filter.channel);
        }
        if (filter.from) {
            result = result.filter(m => m.from === filter.from);
        }
        if (filter.type) {
            result = result.filter(m => m.type === filter.type);
        }
        return result;
    }

    /** 清空历史 */
    clear() {
        this.history = [];
        this.subscribers.clear();
    }
}

// 单例导出
export const messageBus = new MessageBus();
export default messageBus;
