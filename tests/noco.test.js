// ============================================================================
// tests/noco.test.js — клиент NocoDB shared/noco.js (кеш, TTL, single-flight)
// ============================================================================
// Запуск: node --test tests/
// Сеть не используется: axios заменяется моком (фабрика принимает зависимости).
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createNocoClient } = require('../shared/noco');

// ─────────────── Мок axios: сервер из строк по limit/offset ─────────────────
function makeMockAxios(rowsByTable, { failUrls = [] } = {}) {
    const calls = { get: [], post: [], patch: [], delete: [] };
    const axios = {
        async get(url) {
            calls.get.push(url);
            if (failUrls.some(f => url.includes(f))) {
                const err = new Error('net err');
                err.response = { data: { error: 'mock net err' } };
                throw err;
            }
            // dataPath = .../noco/{baseId}/{table}
            const m = url.match(/\/noco\/\w+\/([^/]+)\?/);
            const table = m ? m[1] : '';
            const limit = parseInt((url.match(/limit=(\d+)/) || [])[1] || '100', 10);
            const offset = parseInt((url.match(/offset=(\d+)/) || [])[1] || '0', 10);
            const rows = rowsByTable[table] || [];
            return { data: { list: rows.slice(offset, offset + limit) } };
        },
        async post(url, data) { calls.post.push({ url, data }); return { data: { Id: 999 } }; },
        async patch(url, data) { calls.patch.push({ url, data }); return { data: {} }; },
        async delete(url) { calls.delete.push(url); return { data: {} }; }
    };
    return { axios, calls };
}

const BASE = 'http://nocodb:8080';
const TOKEN = 'tok';
const BASE_ID = 'noco';

function makeClient(rowsByTable, opts) {
    const { axios, calls } = makeMockAxios(rowsByTable, opts);
    const client = createNocoClient({ axios, baseUrl: BASE, baseId: BASE_ID, token: TOKEN });
    return { client, calls };
}

// ─────────────────────────── Полная выборка ─────────────────────────────────
test('fetchAllRows: пагинация до конца таблицы', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ Id: i + 1, Имя: `r${i + 1}` }));
    const { client } = makeClient({ Контакты: rows });
    const all = await client.fetchAllRows('Контакты', 100, 'sort=-Id');
    assert.equal(all.length, 250);
    assert.equal(all[0].Id, 1);
});

test('fetchAllRows: extraParams попадают в URL', async () => {
    const { client, calls } = makeClient({ Проекты: [] });
    await client.fetchAllRows('Проекты', 100, 'sort=-Id');
    assert.ok(calls.get[0].includes('sort=-Id'), calls.get[0]);
});

// ─────────────────────────────── Кеш списков ────────────────────────────────
test('кеш: повторный вызов не ходит в сеть', async () => {
    const { client, calls } = makeClient({ Проекты: [{ Id: 1 }] });
    await client.fetchAllRowsCached('Проекты');
    await client.fetchAllRowsCached('Проекты');
    assert.equal(calls.get.length, 1);
});

test('кеш: разные extraParams — разные ключи', async () => {
    const { client, calls } = makeClient({ Проекты: [{ Id: 1 }] });
    await client.fetchAllRowsCached('Проекты', { extraParams: 'sort=-Id' });
    await client.fetchAllRowsCached('Проекты', { extraParams: 'sort=Id' });
    assert.equal(calls.get.length, 2);
});

test('кеш: TTL протухает — запрос повторяется', async () => {
    const { client, calls } = makeClient({ Проекты: [{ Id: 1 }] });
    await client.fetchAllRowsCached('Проекты', { ttlMs: 50 });
    await new Promise(r => setTimeout(r, 70));
    await client.fetchAllRowsCached('Проекты', { ttlMs: 50 });
    assert.equal(calls.get.length, 2);
});

test('ошибка сети НЕ кешируется — следующий вызов снова пробует', async () => {
    const { client, calls } = makeClient({ Проекты: [{ Id: 1 }] }, { failUrls: ['Проекты'] });
    await assert.rejects(() => client.fetchAllRowsCached('Проекты'));
    await assert.rejects(() => client.fetchAllRowsCached('Проекты'));
    assert.equal(calls.get.length, 2);
});

// ───────────────────────── Инвалидация кеша ─────────────────────────────────
test('invalidateTable сбрасывает кеш таблицы (все варианты extraParams)', async () => {
    const { client, calls } = makeClient({ Проекты: [{ Id: 1 }] });
    await client.fetchAllRowsCached('Проекты', { extraParams: 'sort=-Id' });
    await client.fetchAllRowsCached('Проекты', { extraParams: '' });
    assert.equal(calls.get.length, 2);
    client.invalidateTable('Проекты');
    await client.fetchAllRowsCached('Проекты', { extraParams: 'sort=-Id' });
    assert.equal(calls.get.length, 3);
});

test('createRow/updateRow/deleteRow инвалидируют кеш таблицы (по умолчанию)', async () => {
    const { client, calls } = makeClient({ Контакты: [{ Id: 1 }] });
    await client.fetchAllRowsCached('Контакты');
    await client.createRow('Контакты', { Имя: 'x' });
    await client.fetchAllRowsCached('Контакты');
    assert.equal(calls.get.length, 2); // 1-й кеш-запрос + 1-й после createRow

    await client.updateRow('Контакты', 1, { Имя: 'y' });
    await client.fetchAllRowsCached('Контакты');
    assert.equal(calls.get.length, 3);

    await client.deleteRow('Контакты', 1);
    await client.fetchAllRowsCached('Контакты');
    assert.equal(calls.get.length, 4);
});

test('записи с { invalidate: false } НЕ трогают кеш', async () => {
    const { client, calls } = makeClient({ Контакты: [{ Id: 1 }] });
    await client.fetchAllRowsCached('Контакты');
    await client.createRow('Контакты', { Имя: 'x' }, { invalidate: false });
    await client.fetchAllRowsCached('Контакты');
    assert.equal(calls.get.length, 1); // кеш не сброшен — повторный запрос не ходил
});

test('мутация результата НЕ портит кеш (наружу идёт копия)', async () => {
    const { client, calls } = makeClient({ Проекты: [{ Id: 2 }, { Id: 1 }] });
    const first = await client.fetchAllRowsCached('Проекты');
    first.sort((a, b) => a.Id - b.Id);        // мутируем «как sendXxxList»
    first.push({ Id: 999 });                  // и добавляем
    assert.equal(first.length, 3);
    const second = await client.fetchAllRowsCached('Проекты'); // из кеша
    assert.equal(second.length, 2);           // кеш не испорчен
    assert.equal(second[0].Id, 2);            // исходный порядок не тронут
    assert.equal(calls.get.length, 1);        // повторный запрос в сеть не ходил
});

test('кеш изолирован по клиентам (разные инстансы)', async () => {
    const { axios } = makeMockAxios({ Контакты: [{ Id: 1 }] });
    const a = createNocoClient({ axios, baseUrl: BASE, baseId: BASE_ID, token: TOKEN });
    const b = createNocoClient({ axios, baseUrl: BASE, baseId: BASE_ID, token: TOKEN });
    await a.fetchAllRowsCached('Контакты');
    await b.fetchAllRowsCached('Контакты');
    // a и b не делят Map — проверяем через cacheStats
    assert.equal(a.cacheStats().size, 1);
    assert.equal(b.cacheStats().size, 1);
});

