// ============================================================================
// shared/noco.js — клиент NocoDB (Data API v1) + in-memory кеш списков
// ============================================================================
// «Чистый» модуль: зависимости (axios, адрес, токен) передаются в фабрику
// createNocoClient. Это позволяет:
//   1) тестировать БЕЗ сети — мок axios (tests/noco.test.js);
//   2) переиспользовать в bot.js (и при необходимости в webhook/server.js);
//   3) не хардкодить глобалы в модуле (правило: всё через конфиг).
//
// Data API v1: строковые имена колонок (Проблема 45) — модуль НЕ знает про
// внутренние ID колонок. Пагинация — цикл до пустой страницы (limit/offset).
//
// Кеш списков: in-memory Map с TTL + single-flight (два одновременных открытия
// одного списка = ОДИН запрос в NocoDB). Инвалидация: invalidateTable(tableName)
// вызывается после ЗАПИСЕЙ (методы createRow/updateRow/deleteRow с
// { invalidate: true }) либо вручную из бота после прямых axios-записей.
// ============================================================================

// ──────────────────────────── HTTP-клиент ───────────────────────────────────
function createNocoClient(deps) {
    const { axios, baseUrl, token } = deps;
    if (!axios || !baseUrl || !token) {
        throw new Error('createNocoClient: нужны axios, baseUrl и token');
    }
    const headers = { 'xc-token': token };

    const dataPath = (tableName) => `${baseUrl}/api/v1/db/data/noco/${deps.baseId}/${tableName}`;

    // Полная выборка таблицы (пагинация до пустой страницы).
    // Сигнатура повторяет историческую fetchAllRows() из bot.js:
    //   fetchAllRows(tableName, pageSize = 100, extraParams = '')
    // extraParams — строка вида 'sort=-Id', добавляется в URL после limit/offset.
    async function fetchAllRows(tableName, pageSize = 100, extraParams = '') {
        const all = [];
        let offset = 0;
        while (true) {
            const url = `${dataPath(tableName)}?limit=${pageSize}&offset=${offset}${extraParams ? '&' + extraParams : ''}`;
            const res = await axios.get(url, { headers });
            const rows = res.data.list || [];
            all.push(...rows);
            if (rows.length === 0 || rows.length < pageSize) break;
            offset += pageSize;
            if (offset > 50000) break; // предохранитель от бесконечного цикла
        }
        return all;
    }

    async function getRow(tableName, rowId) {
        const res = await axios.get(`${dataPath(tableName)}/${rowId}`, { headers });
        return res.data;
    }

    async function createRow(tableName, data, opts = {}) {
        try {
            const res = await axios.post(dataPath(tableName), data, { headers });
            if (opts.invalidate !== false) invalidateTable(tableName);
            return res.data;
        } catch (err) {
            throw err;
        }
    }

    async function updateRow(tableName, rowId, data, opts = {}) {
        try {
            const res = await axios.patch(`${dataPath(tableName)}/${rowId}`, data, { headers });
            if (opts.invalidate !== false) invalidateTable(tableName);
            return res.data;
        } catch (err) {
            throw err;
        }
    }

    async function deleteRow(tableName, rowId, opts = {}) {
        try {
            const res = await axios.delete(`${dataPath(tableName)}/${rowId}`, { headers });
            if (opts.invalidate !== false) invalidateTable(tableName);
            return res.data;
        } catch (err) {
            throw err;
        }
    }

    // ─────────────────────────── Кеш списков ─────────────────────────────────
    // Map<`table|extraParams`, { value, expiresAt }>. Память освобождается при
    // каждой записи/протухании (лениво) — размер ограничен числом таблиц×вариантов.
    const cache = new Map();
    const pending = new Map(); // single-flight: идут запросы в этот момент

    function cacheKey(tableName, extraParams) {
        return `${tableName}|${extraParams || ''}`;
    }

    // TTL по умолчанию: 15 секунд. Списки проектов/контактов/юрлиц меняются
    // нечасто; задачи при необходимости можно кешировать с меньшим TTL (5 с),
    // передав ttlMs в опциях вызова.
    const DEFAULT_TTL_MS = 15 * 1000;

    function invalidateTable(tableName) {
        const prefix = `${tableName}|`;
        for (const key of cache.keys()) {
            if (key.startsWith(prefix)) cache.delete(key);
        }
    }

    // Полная выборка с кешем. force=true — пропустить кеш (но записать новый).
    // ВАЖНО: наружу всегда отдаётся КОПИЯ массива — функции-потребители делают
    // sort()/filter()/splice() на месте, и мутация закешированного массива
    // испортила бы список для всех остальных.
    async function fetchAllRowsCached(tableName, { pageSize = 100, extraParams = '', ttlMs = DEFAULT_TTL_MS, force = false } = {}) {
        const key = cacheKey(tableName, extraParams);
        const now = Date.now();

        const hit = cache.get(key);
        if (!force && hit && hit.expiresAt > now) return hit.value.slice();

        if (!pending.has(key)) {
            pending.set(key, (async () => {
                try {
                    const value = await fetchAllRows(tableName, pageSize, extraParams);
                    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
                    return value;
                } finally {
                    pending.delete(key); // ошибку НЕ кешируем — можно повторить
                }
            })());
        }
        const rows = await pending.get(key);
        return rows.slice();
    }

    // ────────────────────── Утилиты кеша (для тестов) ────────────────────────
    function cacheStats() {
        let size = 0;
        for (const { expiresAt } of cache.values()) {
            if (expiresAt > Date.now()) size++;
        }
        return { size };
    }

    return {
        fetchAllRows,
        fetchAllRowsCached,
        getRow,
        createRow,
        updateRow,
        deleteRow,
        invalidateTable,
        cacheStats
    };
}

module.exports = { createNocoClient };
