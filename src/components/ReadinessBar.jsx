import React, { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import { ensureGatewayConfigHydrated } from '../engine/gatewayConfig.js';
import { probeGateway } from '../engine/gatewayRuns.js';
import { buildReadiness } from '../engine/readiness.js';

export default function ReadinessBar({ onNavigate }) {
    const agents = useStore(s => s.agents) || [];
    const systemStatus = useStore(s => s.systemStatus);
    const [probe, setProbe] = useState(null);

    useEffect(() => {
        let active = true;
        const tick = async () => {
            await ensureGatewayConfigHydrated();
            const next = await probeGateway();
            if (active) setProbe(next);
        };
        void tick();
        const timer = setInterval(() => { void tick(); }, 8000);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, []);

    const readiness = buildReadiness({ agents, systemStatus, gatewayProbe: probe });
    const modeLabel = readiness.mode === 'gateway' ? 'Gateway' : '直连';

    return (
        <div className="readiness-bar" data-ready={readiness.ready ? 'yes' : 'no'}>
            <span className={`readiness-chip ${readiness.ready ? 'readiness-chip--ok' : 'readiness-chip--warn'}`}>
                {readiness.ready ? `可以发布 · ${modeLabel}` : `还缺 ${readiness.issues.length} 项 · ${modeLabel}`}
            </span>
            {readiness.issues.map(issue => (
                <button
                    key={issue.id}
                    type="button"
                    className="readiness-chip readiness-chip--action"
                    onClick={() => onNavigate?.(issue.tab)}
                >
                    {issue.label}
                </button>
            ))}
        </div>
    );
}
