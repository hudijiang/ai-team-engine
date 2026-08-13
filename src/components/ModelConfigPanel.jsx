import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    PROVIDERS,
    ensureProviderConfigsHydrated,
    saveProviderConfigs,
    fetchModelsFromAPI,
    ensureModelsCacheHydrated,
    saveModelsCache,
} from '../engine/modelConfig';
import { useStore } from '../store/store';
import {
    canFetchProviderModels,
    flushPendingProviderConfigAutosave,
    mergeProviderConfigUpdate,
    queueProviderConfigAutosave,
    shouldApplyHydratedProviderConfigs,
} from './modelConfigPanelLogic.js';
import {
    hydrateModelConfigPanelState,
    integrateFetchedProviderModels,
    integrateProviderFetchError,
} from './modelConfigPanelActions.js';
import {
    ensureGatewayConfigHydrated,
    saveGatewayConfig,
} from '../engine/gatewayConfig.js';

/**
 * 模型配置面板
 * 按供应商配置 API URL / Key，并可拉取模型列表
 * 配置修改后自动持久化，无需手动点击保存
 */
export default function ModelConfigPanel() {
    const [configs, setConfigs] = useState({});
    const [expandedProvider, setExpandedProvider] = useState(null);
    const [fetchingModels, setFetchingModels] = useState(null);
    const [fetchResults, setFetchResults] = useState({});
    const dispatch = useStore(s => s.dispatch);
    const saveTimerRef = useRef(null);
    const latestConfigsRef = useRef({});
    const lastConfigMutationAtRef = useRef(0);
    const [gateway, setGateway] = useState({ useGateway: false, gatewayUrl: '', accessToken: '' });
    const gatewayTimerRef = useRef(null);

    // 初始化：加载 API 配置 + 恢复模型缓存
    useEffect(() => {
        let active = true;
        const hydrateStartedAt = Date.now();

        const restorePersistedState = async () => {
            const { configs: savedConfigs, fetchResults: restoredFetchResults } = await hydrateModelConfigPanelState({
                dispatch,
                ensureProviderConfigsHydratedImpl: ensureProviderConfigsHydrated,
                ensureModelsCacheHydratedImpl: ensureModelsCacheHydrated,
            });
            if (!active) return;
            if (!shouldApplyHydratedProviderConfigs({
                hydrateStartedAt,
                lastLocalMutationAt: lastConfigMutationAtRef.current,
            })) {
                return;
            }

            setConfigs(savedConfigs);
            latestConfigsRef.current = savedConfigs;
            if (Object.keys(restoredFetchResults).length > 0) {
                setFetchResults(restoredFetchResults);
            }
            const gw = await ensureGatewayConfigHydrated();
            if (active) setGateway(gw);
        };

        void restorePersistedState();

        return () => {
            active = false;
            flushPendingProviderConfigAutosave({
                saveTimerRef,
                latestConfigsRef,
                saveProviderConfigsImpl: saveProviderConfigs,
            });
        };
    }, [dispatch]);

    // 修改配置后自动保存（防抖 500ms）
    const updateConfig = useCallback((providerId, field, value) => {
        lastConfigMutationAtRef.current = Date.now();
        setConfigs(prev => {
            const next = mergeProviderConfigUpdate(prev, providerId, field, value);
            queueProviderConfigAutosave({
                saveTimerRef,
                latestConfigsRef,
                configs: next,
                saveProviderConfigsImpl: saveProviderConfigs,
            });
            return next;
        });
    }, []);

    // 拉取某供应商的模型列表
    const handleFetchModels = useCallback(async (providerId) => {
        const config = configs[providerId];
        if (!canFetchProviderModels(config)) return;

        // 先保存当前配置确保最新
        saveProviderConfigs(configs);

        setFetchingModels(providerId);
        try {
            const models = await fetchModelsFromAPI(config.apiUrl, config.apiKey, providerId);
            setFetchResults(prev => {
                return integrateFetchedProviderModels({
                    providerId,
                    models,
                    previousFetchResults: prev,
                    dispatch,
                    saveModelsCacheImpl: saveModelsCache,
                });
            });
        } catch (err) {
            setFetchResults(prev => integrateProviderFetchError({
                providerId,
                error: err,
                previousFetchResults: prev,
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

            <div className="model-config-item" style={{ marginTop: 16 }}>
                <label className="model-config-item__header">
                    <input
                        type="checkbox"
                        checked={!!gateway.useGateway}
                        onChange={(e) => {
                            const next = { ...gateway, useGateway: e.target.checked };
                            setGateway(next);
                            clearTimeout(gatewayTimerRef.current);
                            gatewayTimerRef.current = setTimeout(() => saveGatewayConfig(next), 300);
                        }}
                    />
                    {' '}使用本机单租户 Gateway（推荐：浏览器不再持有供应商 raw key）
                </label>
                {gateway.useGateway && (
                    <div className="model-config-item__body">
                        <input
                            className="model-config-item__input"
                            placeholder="Gateway URL，如 http://127.0.0.1:8787"
                            value={gateway.gatewayUrl}
                            onChange={(e) => {
                                const next = { ...gateway, gatewayUrl: e.target.value };
                                setGateway(next);
                                clearTimeout(gatewayTimerRef.current);
                                gatewayTimerRef.current = setTimeout(() => saveGatewayConfig(next), 300);
                            }}
                        />
                        <input
                            className="model-config-item__input"
                            type="password"
                            placeholder="GATEWAY_TOKEN"
                            value={gateway.accessToken}
                            onChange={(e) => {
                                const next = { ...gateway, accessToken: e.target.value };
                                setGateway(next);
                                clearTimeout(gatewayTimerRef.current);
                                gatewayTimerRef.current = setTimeout(() => saveGatewayConfig(next), 300);
                            }}
                        />
                    </div>
                )}
            </div>

            <div className="model-config-panel__note">
                🔒 默认：API Key 在本机 IndexedDB（localStorage 仅去敏 bootstrap）。
                直连模式下<strong>浏览器</strong>会把密钥发到你填写的模型 URL。
                开启上方 Gateway 后，浏览器只带 Gateway Token，供应商密钥留在本机 Gateway 进程。
                标注「实验」的供应商表示原生协议未验证，仅兼容代理可用。
            </div>
        </div>
    );
}
