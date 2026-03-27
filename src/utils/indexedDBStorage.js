/**
 * 轻量 IndexedDB 键值存储
 */
const DB_NAME = 'ai-team-engine';
const STORE_NAME = 'kv';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
    if (typeof indexedDB === 'undefined') {
        return Promise.resolve(null);
    }
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }).catch(error => {
        dbPromise = null;
        console.warn('打开 IndexedDB 失败:', error);
        return null;
    });

    return dbPromise;
}

function runRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
    });
}

export async function loadIndexedValue(key) {
    const db = await openDB();
    if (!db) return null;

    try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        return await runRequest(store.get(key));
    } catch (error) {
        console.warn(`读取 IndexedDB 键 ${key} 失败:`, error);
        return null;
    }
}

export async function saveIndexedValue(key, value) {
    const db = await openDB();
    if (!db) return false;

    try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        await runRequest(store.put(value, key));
        return true;
    } catch (error) {
        console.warn(`写入 IndexedDB 键 ${key} 失败:`, error);
        return false;
    }
}

export async function deleteIndexedValue(key) {
    const db = await openDB();
    if (!db) return false;

    try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        await runRequest(store.delete(key));
        return true;
    } catch (error) {
        console.warn(`删除 IndexedDB 键 ${key} 失败:`, error);
        return false;
    }
}

export default { loadIndexedValue, saveIndexedValue, deleteIndexedValue };
