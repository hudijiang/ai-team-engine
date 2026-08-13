import React, { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store/store';
import {
    deleteGatewayRun,
    exportGatewayRuns,
    getGatewayRun,
    listGatewayRuns,
} from '../engine/gatewayRuns.js';
import { isGatewayEnabled, loadGatewayConfig } from '../engine/gatewayConfig.js';

export default function GatewayRunsPanel() {
    const gatewayRunId = useStore(s => s.gatewayRunId);
    const [records, setRecords] = useState([]);
    const [current, setCurrent] = useState(null);
    const [error, setError] = useState('');
    const enabled = isGatewayEnabled(loadGatewayConfig());

    const refresh = useCallback(async () => {
        if (!enabled) {
            setRecords([]);
            setCurrent(null);
            return;
        }
        try {
            const rows = await listGatewayRuns();
            setRecords(rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))));
            if (gatewayRunId) {
                setCurrent(await getGatewayRun(gatewayRunId));
            } else {
                setCurrent(rows[0] || null);
            }
            setError('');
        } catch (err) {
            setError(err?.message || '无法读取 Gateway 记录');
        }
    }, [enabled, gatewayRunId]);

    useEffect(() => {
        void refresh();
        if (!enabled) return undefined;
        const timer = setInterval(() => { void refresh(); }, 4000);
        return () => clearInterval(timer);
    }, [refresh, enabled]);

    const handleDelete = async (id) => {
        if (!id) return;
        await deleteGatewayRun(id);
        await refresh();
    };

    const handleExport = () => {
        const blob = new Blob([exportGatewayRuns(records)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `gateway-runs-${Date.now()}.json`;
        link.click();
        URL.revokeObjectURL(url);
    };

    if (!enabled) {
        return (
            <div className="progress-dashboard">
                <div className="text-muted">未开启本机 Gateway。开启后这里会显示运行记录（对账用，关页不会继续跑 Agent）。</div>
            </div>
        );
    }

    return (
        <div className="progress-dashboard">
            <div className="model-config-panel__header" style={{ marginBottom: 12 }}>
                <div>
                    <div className="model-config-panel__title">Gateway 运行记录</div>
                    <div className="model-config-panel__desc">单租户对账。不是云端控制台。</div>
                </div>
                <div className="model-config-item__actions">
                    <button className="model-config-item__fetch" onClick={() => void refresh()}>刷新</button>
                    <button className="model-config-item__fetch" onClick={handleExport} disabled={!records.length}>导出</button>
                </div>
            </div>
            {error && <div className="text-muted" style={{ color: 'var(--accent-red)' }}>{error}</div>}
            {current && (
                <div className="model-config-item" style={{ marginBottom: 12 }}>
                    <div className="model-config-item__name">当前 run</div>
                    <div className="text-sm text-muted">
                        {current.id}<br />
                        状态 {current.status} · rev {current.revision}
                        {current.checkpointType ? ` · ${current.checkpointType}` : ''}
                        {current.currentPhase ? ` · ${current.currentPhase}` : ''}
                    </div>
                    {current.lastError && (
                        <div className="text-sm" style={{ color: 'var(--accent-amber)', marginTop: 6 }}>
                            {current.lastError}
                        </div>
                    )}
                    <div className="text-sm">{current.objective}</div>
                </div>
            )}
            <div className="text-sm text-muted" style={{ marginBottom: 8 }}>共 {records.length} 条</div>
            {records.map(record => (
                <div key={record.id} className="model-config-item" style={{ marginBottom: 8 }}>
                    <div className="model-config-item__header">
                        <div className="model-config-item__name">
                            {record.status} · {record.objective || '(无目标)'}
                        </div>
                        <button className="model-config-item__fetch" onClick={() => void handleDelete(record.id)}>删除</button>
                    </div>
                    <div className="text-sm text-muted">
                        {record.id.slice(0, 8)}… · rev {record.revision} · {record.updatedAt || ''}
                    </div>
                </div>
            ))}
        </div>
    );
}
