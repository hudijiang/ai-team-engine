import { useEffect } from 'react';
import messageBus from '../engine/messageBus';
import { useStore } from '../store/store';

export default function useInboxSubscriber() {
    const dispatch = useStore(s => s.dispatch);

    useEffect(() => {
        const unsub = messageBus.subscribe('*', (msg) => {
            if (msg.type === 'agent-message' && msg.to) {
                dispatch({
                    type: 'ADD_INBOX',
                    payload: {
                        from: msg.from,
                        to: msg.to,
                        content: msg.payload?.content || [],
                        topic: msg.payload?.topic || '',
                        source: msg.payload?.source || 'template',
                        timestamp: msg.timestamp,
                    },
                });
            }
        });
        return () => unsub && unsub();
    }, [dispatch]);
}
