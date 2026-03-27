/**
 * 同步 bootstrap + 异步完整持久化资源封装
 */
import { loadIndexedValue, saveIndexedValue } from './indexedDBStorage.js';

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value));
}

export function createPersistentResource({
    storageKey,
    fullKey = `${storageKey}:full`,
    initialValue,
    bootstrapSelector = (value) => value,
}) {
    const buildInitialValue = () => cloneValue(
        typeof initialValue === 'function' ? initialValue() : initialValue
    );

    const loadBootstrap = () => {
        try {
            const saved = localStorage.getItem(storageKey);
            return saved ? JSON.parse(saved) : buildInitialValue();
        } catch (_) {
            return buildInitialValue();
        }
    };

    let cache = loadBootstrap();
    let hydrated = false;
    let hydratePromise = null;
    let mutationVersion = 0;

    const saveBootstrap = (value) => {
        try {
            localStorage.setItem(storageKey, JSON.stringify(bootstrapSelector(value)));
        } catch (_) { /* ignore */ }
    };

    return {
        get() {
            return cache;
        },

        set(value) {
            cache = value;
            mutationVersion += 1;
            hydrated = true;
            saveBootstrap(value);
            void saveIndexedValue(fullKey, value);
            return cache;
        },

        update(updater) {
            return this.set(updater(cache));
        },

        async hydrate() {
            if (hydrated) return cache;
            if (hydratePromise) return hydratePromise;

            const hydrateVersion = mutationVersion;
            hydratePromise = (async () => {
                const stored = await loadIndexedValue(fullKey);
                if (
                    stored !== null
                    && stored !== undefined
                    && hydrateVersion === mutationVersion
                    && !hydrated
                ) {
                    cache = stored;
                }
                if (hydrateVersion === mutationVersion && !hydrated) {
                    saveBootstrap(cache);
                    void saveIndexedValue(fullKey, cache);
                }
                hydrated = true;
                return cache;
            })().finally(() => {
                hydratePromise = null;
            });

            return hydratePromise;
        },

        isHydrated() {
            return hydrated;
        },

        reset() {
            return this.set(buildInitialValue());
        },
    };
}

export default { createPersistentResource };
