import {
    buildFetchResultsFromCache,
    buildModelsCacheFromFetchResults,
} from './modelConfigPanelLogic.js';
import { getKnownProvider } from '../engine/providerCatalog.js';

export async function hydrateModelConfigPanelState({
    dispatch,
    ensureProviderConfigsHydratedImpl,
    ensureModelsCacheHydratedImpl,
    buildFetchResultsFromCacheImpl = buildFetchResultsFromCache,
}) {
    const [configs, cache] = await Promise.all([
        ensureProviderConfigsHydratedImpl(),
        ensureModelsCacheHydratedImpl(),
    ]);

    const fetchResults = buildFetchResultsFromCacheImpl(cache);
    Object.entries(fetchResults).forEach(([providerId, result]) => {
        dispatch({
            type: 'SET_PROVIDER_MODELS',
            payload: { providerId, models: result.models },
        });
    });

    return { configs, fetchResults };
}

export function integrateFetchedProviderModels({
    providerId,
    models,
    previousFetchResults,
    dispatch,
    saveModelsCacheImpl,
    buildModelsCacheFromFetchResultsImpl = buildModelsCacheFromFetchResults,
    timestamp = Date.now(),
}) {
    const next = {
        ...previousFetchResults,
        [providerId]: { models, error: null },
    };

    saveModelsCacheImpl(buildModelsCacheFromFetchResultsImpl(next, timestamp));
    dispatch({
        type: 'SET_PROVIDER_MODELS',
        payload: { providerId, models },
    });

    return next;
}

export function integrateProviderFetchError({
    providerId,
    error,
    previousFetchResults,
}) {
    return {
        ...previousFetchResults,
        [providerId]: {
            models: [],
            error: error?.message || String(error),
        },
    };
}

/**
 * Gateway 手工模型必须挂在一个已知 Provider 下，避免模型 ID 再靠名称猜测
 * 并意外回退到 OpenAI/custom。
 */
export function integrateManualProviderModel({
    providerId,
    modelId,
    previousFetchResults,
    dispatch,
    saveModelsCacheImpl,
}) {
    const normalizedModelId = String(modelId || '').trim();
    if (!normalizedModelId || !getKnownProvider(providerId)) {
        return previousFetchResults;
    }
    const existing = Array.isArray(previousFetchResults?.[providerId]?.models)
        ? previousFetchResults[providerId].models
        : [];
    const models = existing.some(item => item.id === normalizedModelId)
        ? existing
        : [...existing, {
            id: normalizedModelId,
            name: normalizedModelId,
            provider: providerId,
        }];
    return integrateFetchedProviderModels({
        providerId,
        models,
        previousFetchResults,
        dispatch,
        saveModelsCacheImpl,
    });
}

export default {
    hydrateModelConfigPanelState,
    integrateFetchedProviderModels,
    integrateManualProviderModel,
    integrateProviderFetchError,
};
