import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    PROVIDERS,
    loadProviderConfigs,
    saveProviderConfigs,
    fetchModelsFromAPI,
    loadModelsCache,
    saveModelsCache,
} from '../engine/modelConfig';
import { useStore } from '../store/store';

/**
 * 模型配置面板
 * 按供应商配置 API URL / Key，并可拉取模型列表
 * 配置修改后自动保存到 localStorage，无需手动点击保存
 */
export default function ModelConfigPanel() {
    const [configs, setConfigs] = useState({});
    const [expandedProvider, setExpandedProvider] = useState(null);
    const [fetchingModels, setFetchingModels] = useState(null);
    const [fetchResults, setFetchResults] = useState({});
    const dispatch = useStore(s => s.dispatch);
    const saveTimerRef = useRef(null);

    // 初始化：加载 API 配置 + 恢复模型缓存
    useEffect(() => {
        const savedConfigs = loadProviderConfigs();
        setConfigs(savedConfigs);

        // 恢复模型缓存到 store 和本地 fetchResults
        const cache = loadModelsCache();
        if (cache.models && cache.models.length > 0) {
            // 按 provider 分组
            const grouped = {};
            cache.models.forEach(m => {
                if (!grouped[m.provider]) grouped[m.provider] = [];
                grouped[m.provider].push(m);
            });
            // 恢复到 fetchResults 显示
            const results = {};
            Object.entries(grouped).forEach(([pid, models]) => {
                results[pid] = { models, error: null };
                // 恢复到全局 store
                dispatch({ type: 'SET_PROVIDER_MODELS', payload: { providerId: pid, models } });
            });
            setFetchResults(results);
        }
    }, [dispatch]);

    // 修改配置后自动保存（防抖 500ms）
    const updateConfig = useCallback((providerId, field, value) => {
        setConfigs(prev => {
            const next = {
                ...prev,
                [providerId]: { ...prev[providerId], [field]: value },
            };
            // 防抖自动保存
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => {
                saveProviderConfigs(next);
            }, 500);
            return next;
        });
    }, []);

    // 拉取某供应商的模型列表
    const handleFetchModels = useCallback(async (providerId) => {
        const config = configs[providerId];
        if (!config?.apiUrl || !config?.apiKey) return;

        // 先保存当前配置确保最新
        saveProviderConfigs(configs);

        setFetchingModels(providerId);
        try {
            const models = await fetchModelsFromAPI(config.apiUrl, config.apiKey, providerId);
            setFetchResults(prev => {
                const next = { ...prev, [providerId]: { models, error: null } };
                // 将所有已获取的模型合并保存到缓存
                const allModels = [];
                Object.entries(next).forEach(([pid, r]) => {
                    if (r.models) r.models.forEach(m => allModels.push({ ...m, provider: pid }));
                });
                saveModelsCache({ models: allModels, timestamp: Date.now() });
                return next;
            });
            // 写入全局 store
            dispatch({
                type: 'SET_PROVIDER_MODELS',
                payload: { providerId, models },
            });
        } catch (err) {
            setFetchResults(prev => ({
                ...prev,
                [providerId]: { models: [], error: err.message },
            }));
        } finally {
            setFetchingModels(null);
        }
    }, [configs, dispatch]);

    const toggleExpand = (id) => {
        setExpandedProvider(prev => prev === id ? null : id);
    };

    return (
        <div className="model-config-panel">
            <div className="model-config-panel__header">
                <div>
                    <div className="model-config-panel__title">⚙️ 供应商 API 配置</div>
                    <div className="model-config-panel__desc">
                        配置供应商 API 后，点击「获取模型」拉取可用模型列表。然后在左侧 Agent 卡片中为每个 Agent 选择模型。
                    </div>
                </div>
                <span className="model-config-panel__autosave">🔄 自动保存</span>
            </div>

            {PROVIDERS.map(provider => {
                const config = configs[provider.id] || { apiUrl: '', apiKey: '' };
                const isExpanded = expandedProvider === provider.id;
                const isConfigured = !!(config.apiUrl && config.apiKey);
                const result = fetchResults[provider.id];
                const isFetching = fetchingModels === provider.id;

                return (
                    <div
                        key={provider.id}
                        className={`model-config-item ${isConfigured ? 'model-config-item--configured' : ''}`}
                    >
                        <div className="model-config-item__header" onClick={() => toggleExpand(provider.id)}>
                            <div className="model-config-item__name">
                                <span className="model-config-item__icon">{provider.icon}</span>
                                {provider.name}
                                {isConfigured && <span className="model-config-item__badge">已配置</span>}
                                {result?.models?.length > 0 && (
                                    <span className="model-config-item__badge" style={{ background: 'rgba(59,130,246,0.15)', color: 'var(--accent-blue)' }}>
                                        {result.models.length} 个模型
                                    </span>
                                )}
                            </div>
                            <span className="model-config-item__toggle">{isExpanded ? '▾' : '▸'}</span>
                        </div>

                        {isExpanded && (
                            <div className="model-config-item__body">
                                <div className="model-config-item__field">
                                    <label className="model-config-item__label">API URL</label>
                                    <input
                                        className="model-config-item__input"
                                        type="text"
                                        value={config.apiUrl || ''}
                                        onChange={e => updateConfig(provider.id, 'apiUrl', e.target.value)}
                                        placeholder={provider.defaultApiUrl || 'https://api.example.com/v1'}
                                        id={`api-url-${provider.id}`}
                                    />
                                </div>
                                <div className="model-config-item__field">
                                    <label className="model-config-item__label">API Key</label>
                                    <input
                                        className="model-config-item__input"
                                        type="password"
                                        value={config.apiKey || ''}
                                        onChange={e => updateConfig(provider.id, 'apiKey', e.target.value)}
                                        placeholder={provider.placeholder}
                                        id={`api-key-${provider.id}`}
                                    />
                                </div>
                                <div className="model-config-item__actions">
                                    <button
                                        className="model-config-item__fetch"
                                        onClick={() => handleFetchModels(provider.id)}
                                        disabled={!isConfigured || isFetching}
                                    >
                                        {isFetching ? '⏳ 获取中...' : '🔄 获取模型'}
                                    </button>
                                </div>

                                {/* 获取结果 */}
                                {result?.error && (
                                    <div className="model-config-item__error">
                                        ❌ {result.error}
                                    </div>
                                )}
                                {result?.models?.length > 0 && (
                                    <div className="model-config-item__models-list">
                                        <div className="model-config-item__label">可用模型：</div>
                                        <div className="model-config-item__models-tags">
                                            {result.models.slice(0, 20).map(m => (
                                                <span key={m.id} className="model-config-item__model-tag">
                                                    {m.name || m.id}
                                                </span>
                                            ))}
                                            {result.models.length > 20 && (
                                                <span className="model-config-item__model-tag" style={{ opacity: 0.5 }}>
                                                    +{result.models.length - 20} 个
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}

            <div className="model-config-panel__note">
                🔒 API Key 仅存储在浏览器本地 (localStorage)，不会上传到任何服务器。
            </div>
        </div>
    );
}
