import {
    buildFetchResultsFromCache,
    buildModelsCacheFromFetchResults,
} from './modelConfigPanelLogic.js';

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

export default {
    hydrateModelConfigPanelState,
    integrateFetchedProviderModels,
    integrateProviderFetchError,
};
