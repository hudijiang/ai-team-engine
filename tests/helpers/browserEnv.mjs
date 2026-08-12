import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const helperDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(helperDir, '../..');

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class FakeLocalStorage {
    constructor() {
        this.map = new Map();
    }

    get length() {
        return this.map.size;
    }

    getItem(key) {
        return this.map.has(key) ? this.map.get(key) : null;
    }

    setItem(key, value) {
        this.map.set(String(key), String(value));
    }

    removeItem(key) {
        this.map.delete(String(key));
    }

    clear() {
        this.map.clear();
    }

    key(index) {
        return Array.from(this.map.keys())[index] ?? null;
    }
}

function createAsyncRequest(run) {
    const request = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
    };

    setTimeout(() => {
        try {
            request.result = run();
            request.onsuccess?.({ target: request });
        } catch (error) {
            request.error = error;
            request.onerror?.({ target: request });
        }
    }, 0);

    return request;
}

function createFakeIndexedDB() {
    const databases = new Map();

    const ensureDatabaseRecord = (name) => {
        if (!databases.has(name)) {
            databases.set(name, {
                name,
                stores: new Map(),
            });
        }
        return databases.get(name);
    };

    const createDatabaseHandle = (record) => ({
        objectStoreNames: {
            contains(storeName) {
                return record.stores.has(storeName);
            },
        },
        createObjectStore(storeName) {
            if (!record.stores.has(storeName)) {
                record.stores.set(storeName, new Map());
            }
            return {};
        },
        transaction(storeName) {
            if (!record.stores.has(storeName)) {
                record.stores.set(storeName, new Map());
            }
            const store = record.stores.get(storeName);
            return {
                objectStore() {
                    return {
                        get(key) {
                            return createAsyncRequest(() => clone(store.get(key)));
                        },
                        put(value, key) {
                            return createAsyncRequest(() => {
                                store.set(key, clone(value));
                                return key;
                            });
                        },
                        delete(key) {
                            return createAsyncRequest(() => {
                                store.delete(key);
                                return undefined;
                            });
                        },
                    };
                },
            };
        },
    });

    return {
        databases,
        open(name) {
            const request = {
                result: undefined,
                error: null,
                onsuccess: null,
                onerror: null,
                onupgradeneeded: null,
            };

            setTimeout(() => {
                try {
                    const existed = databases.has(name);
                    const record = ensureDatabaseRecord(name);
                    const db = createDatabaseHandle(record);
                    request.result = db;
                    if (!existed) {
                        request.onupgradeneeded?.({ target: request });
                    }
                    request.onsuccess?.({ target: request });
                } catch (error) {
                    request.error = error;
                    request.onerror?.({ target: request });
                }
            }, 0);

            return request;
        },
    };
}

const localStorage = new FakeLocalStorage();
const indexedDB = createFakeIndexedDB();

globalThis.localStorage = localStorage;
globalThis.indexedDB = indexedDB;

let importCounter = 0;

export function resetBrowserState() {
    localStorage.clear();
    indexedDB.databases.forEach(record => {
        record.stores.forEach(store => store.clear());
    });
}

export function readLocalJSON(key) {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
}

export function readIndexedValue(key, { dbName = 'ai-team-engine', storeName = 'kv' } = {}) {
    const record = indexedDB.databases.get(dbName);
    const store = record?.stores.get(storeName);
    if (!store || !store.has(key)) return null;
    return clone(store.get(key));
}

export function writeIndexedValue(key, value, { dbName = 'ai-team-engine', storeName = 'kv' } = {}) {
    if (!indexedDB.databases.has(dbName)) {
        indexedDB.databases.set(dbName, { name: dbName, stores: new Map() });
    }
    const record = indexedDB.databases.get(dbName);
    if (!record.stores.has(storeName)) {
        record.stores.set(storeName, new Map());
    }
    record.stores.get(storeName).set(key, clone(value));
}

export async function settleAsync(iterations = 4) {
    for (let i = 0; i < iterations; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

export async function importFreshFromRoot(relativePath) {
    importCounter += 1;
    const moduleUrl = pathToFileURL(path.resolve(projectRoot, relativePath));
    // CEOAgentRunner has no module-level mutable execution state. Keeping one
    // canonical source URL lets V8 merge coverage from all test files instead
    // of treating every query-string import as a different script.
    if (relativePath !== 'src/engine/ceoAgent.js') {
        moduleUrl.searchParams.set('test', String(importCounter));
    }
    return import(moduleUrl.href);
}
