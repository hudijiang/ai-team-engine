import React, { useEffect, useRef } from 'react';
import { useStore } from '../store/store';

/**
 * 系统日志组件
 * 展示全局事件流，支持审计追踪
 */
export default function SystemLog() {
    const messages = useStore(s => s.messages);
    const scrollRef = useRef(null);

    // 从消息流派生日志条目
    const logEntries = messages.map(msg => ({
        timestamp: msg.timestamp,
        role: msg.role,
        state: msg.state,
        text: msg.dialogue ? msg.dialogue[0] : msg.current_task,
    }));

    // 自动滚动到底部
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logEntries.length]);

    const formatTime = (ts) => {
        if (!ts) return '--:--:--';
        const d = new Date(ts);
        return d.toLocaleTimeString('zh-CN', { hour12: false });
    };

    return (
        <div className="system-log" ref={scrollRef} style={{ maxHeight: '200px', overflowY: 'auto' }}>
            {logEntries.length === 0 ? (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center', padding: '16px' }}>
                    暂无日志记录
                </div>
            ) : (
                logEntries.map((entry, idx) => (
                    <div key={idx} className="system-log__entry">
                        <span className="system-log__time">{formatTime(entry.timestamp)}</span>
                        <span className="system-log__text">
                            [{entry.role}/{entry.state}] {entry.text}
                        </span>
                    </div>
                ))
            )}
        </div>
    );
}
