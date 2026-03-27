import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    importFreshFromRoot,
    readIndexedValue,
    readLocalJSON,
    resetBrowserState,
    settleAsync,
    writeIndexedValue,
} from './helpers/browserEnv.mjs';

beforeEach(() => {
    return settleAsync().then(() => {
        resetBrowserState();
        return settleAsync();
    });
});

test('persistentResource hydrates full data from IndexedDB without leaking secrets to bootstrap cache', { concurrency: false }, async () => {
    writeIndexedValue('resource-secret:full', { token: 'secret-token', enabled: true });
    localStorage.setItem('resource-secret', JSON.stringify({ token: '', enabled: true }));

    const { createPersistentResource } = await importFreshFromRoot('src/utils/persistentResource.js');
    const resource = createPersistentResource({
        storageKey: 'resource-secret',
        initialValue: () => ({ token: '', enabled: false }),
        bootstrapSelector: (value) => ({
            ...value,
            token: '',
        }),
    });

    assert.deepEqual(resource.get(), { token: '', enabled: true });

    const hydrated = await resource.hydrate();
    assert.deepEqual(hydrated, { token: 'secret-token', enabled: true });
    assert.deepEqual(readLocalJSON('resource-secret'), { token: '', enabled: true });
    assert.deepEqual(readIndexedValue('resource-secret:full'), { token: 'secret-token', enabled: true });
});

test('persistentResource does not let async hydration overwrite newer in-memory mutations', { concurrency: false }, async () => {
    writeIndexedValue('resource-race:full', { value: 'stale' });
    localStorage.setItem('resource-race', JSON.stringify({ value: 'bootstrap' }));

    const { createPersistentResource } = await importFreshFromRoot('src/utils/persistentResource.js');
    const resource = createPersistentResource({
        storageKey: 'resource-race',
        initialValue: () => ({ value: 'initial' }),
    });

    const pendingHydrate = resource.hydrate();
    resource.set({ value: 'fresh' });
    await pendingHydrate;
    await settleAsync();

    assert.deepEqual(resource.get(), { value: 'fresh' });
    assert.deepEqual(readLocalJSON('resource-race'), { value: 'fresh' });
    assert.deepEqual(readIndexedValue('resource-race:full'), { value: 'fresh' });
});

test('modelConfig keeps API keys out of bootstrap storage and restores them after hydration', { concurrency: false }, async () => {
    let modelConfig = await importFreshFromRoot('src/engine/modelConfig.js');

    modelConfig.saveProviderConfigs({
        openai: {
            apiUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-secret',
            enabled: true,
        },
    });
    await settleAsync();

    const bootstrap = readLocalJSON('agent-auto-provider-configs');
    assert.equal(bootstrap.openai.apiKey, '');

    modelConfig = await importFreshFromRoot('src/engine/modelConfig.js');
    assert.equal(modelConfig.loadProviderConfigs().openai.apiKey, '');

    const hydrated = await modelConfig.ensureProviderConfigsHydrated();
    assert.equal(hydrated.openai.apiKey, 'sk-secret');
});

test('mcpClient strips auth tokens from bootstrap storage and refreshes cached clients when config changes', { concurrency: false }, async () => {
    let mcpClient = await importFreshFromRoot('src/engine/mcpClient.js');

    mcpClient.saveMCPConfigs([
        {
            url: 'https://mcp.example',
            name: 'Alpha',
            authToken: 'token-1',
        },
    ]);
    await settleAsync();

    const bootstrap = readLocalJSON('agent-auto-mcp-servers');
    assert.equal(bootstrap[0].authToken, '');

    mcpClient = await importFreshFromRoot('src/engine/mcpClient.js');
    assert.equal(mcpClient.loadMCPConfigs()[0].authToken, '');

    const hydrated = await mcpClient.ensureMCPConfigsHydrated();
    assert.equal(hydrated[0].authToken, 'token-1');

    const client = await mcpClient.getMCPClient('https://mcp.example');
    assert.equal(client.authToken, 'token-1');
    assert.equal(client.name, 'Alpha');

    mcpClient.saveMCPConfigs([
        {
            url: 'https://mcp.example',
            name: 'Beta',
            authToken: 'token-2',
        },
    ]);
    await settleAsync();

    const updatedClient = await mcpClient.getMCPClient('https://mcp.example');
    assert.equal(updatedClient, client);
    assert.equal(updatedClient.authToken, 'token-2');
    assert.equal(updatedClient.name, 'Beta');
});

test('backendAdapter keeps backend API keys out of bootstrap config and restores them after hydration', { concurrency: false }, async () => {
    let backendAdapter = await importFreshFromRoot('src/engine/backendAdapter.js');

    backendAdapter.saveConfig({
        useBackend: true,
        backendUrl: 'https://backend.example',
        apiKey: 'backend-secret',
    });
    await settleAsync();

    const bootstrap = readLocalJSON('agent-auto-backend-config');
    assert.deepEqual(bootstrap, {
        useBackend: true,
        backendUrl: 'https://backend.example',
        apiKey: '',
    });

    backendAdapter = await importFreshFromRoot('src/engine/backendAdapter.js');
    assert.equal(backendAdapter.loadConfig().apiKey, '');

    const hydrated = await backendAdapter.ensureConfigHydrated();
    assert.equal(hydrated.apiKey, 'backend-secret');
});

test('backendAdapter migrates legacy localStorage entries into IndexedDB cache', { concurrency: false }, async () => {
    localStorage.setItem('legacy-task', JSON.stringify({ status: 'ok', count: 1 }));

    const backendAdapter = await importFreshFromRoot('src/engine/backendAdapter.js');
    const value = await backendAdapter.storage.get('legacy-task');

    assert.deepEqual(value, { status: 'ok', count: 1 });
    assert.equal(localStorage.getItem('legacy-task'), null);
    assert.deepEqual(readIndexedValue('legacy-task'), { status: 'ok', count: 1 });
});
