export function mergeProviderConfigUpdate(prevConfigs, providerId, field, value) {
    return {
        ...prevConfigs,
        [providerId]: {
            ...(prevConfigs[providerId] || {}),
            [field]: value,
        },
    };
}

export function buildFetchResultsFromCache(cache = {}) {
    const grouped = {};
    const models = Array.isArray(cache?.models) ? cache.models : [];

    models.forEach(model => {
        const providerId = model?.provider;
        if (!providerId) return;

        if (!grouped[providerId]) {
            grouped[providerId] = { models: [], error: null };
        }
        grouped[providerId].models.push(model);
    });

    return grouped;
}

export function buildModelsCacheFromFetchResults(fetchResults = {}, timestamp = Date.now()) {
    const models = [];

    Object.entries(fetchResults).forEach(([providerId, result]) => {
        if (!Array.isArray(result?.models)) return;
        result.models.forEach(model => {
            models.push({
                ...model,
                provider: model.provider || providerId,
            });
        });
    });

    return { models, timestamp };
}

export function canFetchProviderModels(config) {
    return !!(config?.apiUrl && config?.apiKey);
}

export function shouldApplyHydratedProviderConfigs({
    hydrateStartedAt,
    lastLocalMutationAt = 0,
}) {
    return lastLocalMutationAt <= hydrateStartedAt;
}

export function queueProviderConfigAutosave({
    saveTimerRef,
    latestConfigsRef,
    configs,
    saveProviderConfigsImpl,
    delay = 500,
}) {
    latestConfigsRef.current = configs;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        saveProviderConfigsImpl(latestConfigsRef.current);
    }, delay);
}

export function flushPendingProviderConfigAutosave({
    saveTimerRef,
    latestConfigsRef,
    saveProviderConfigsImpl,
}) {
    if (!saveTimerRef.current) return false;

    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    saveProviderConfigsImpl(latestConfigsRef.current);
    return true;
}

export default {
    mergeProviderConfigUpdate,
    buildFetchResultsFromCache,
    buildModelsCacheFromFetchResults,
    canFetchProviderModels,
    shouldApplyHydratedProviderConfigs,
    queueProviderConfigAutosave,
    flushPendingProviderConfigAutosave,
};
