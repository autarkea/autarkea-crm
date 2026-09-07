// ============================================================================
// shared/watchdog.js — Watchdog Telegram-поллинга (v4.46.0, Проблема 117)
// ============================================================================
// Клиентский кейс 05.09.2026: после одиночного сетевого обрыва (EFATAL: read
// ECONNRESET) следующий getUpdates «завис» навсегда — в node-telegram-bot-api
// нет клиентского таймаута на запрос, а рекурсивный цикл поллинга ждёт
// завершения текущего запроса. Итог: бот жив, cron-задачи работают, /health
// отвечает, НО апдейты Telegram не забираются (pending_update_count растёт).
//
// Этот модуль — ЧИСТАЯ логика решения «завис ли поллинг». Никакой сети и
// файлов — только функция, тесты: tests/watchdog.test.js (node --test).
// Принятие решения сделано двухтактным, чтобы не перезапускать бота на
// одиночном «бусте» трафика (клиент прислал пачку сообщений — они уходят
// одним getUpdates, но момент между двумя health-тиками мог попасть в окно).
// ============================================================================

'use strict';

// ───────────────────────────── Пороги по умолчанию ──────────────────────────
const DEFAULTS = {
    // Сколько health-тиков подряд поллинг обязан показывать «pending>0 и ни
    // одного входящего апдейта», чтобы признать поллинг зависшим. Два тика =
    // ~10 минут «тишины» при накопленных сообщениях — ложных срабатываний нет.
    wedgeStrikes: 2,

    // Резкий скачок очереди (клиенты написали много, пока бот молчал) —
    // зависание очевидно сразу, не ждём второй тик.
    immediatePending: 25,
};

/**
 * Решение по одному health-тику.
 * @param {Object} o
 * @param {number}  o.pending             — pending_update_count из getWebhookInfo
 * @param {boolean} o.processedSincePrev  — true, если с прошлого тика приходил
 *                                          хоть один входящий апдейт (поллинг жив)
 * @param {number}  [o.strike]            — счётчик подозрительных тиков подряд
 * @param {number}  [o.wedgeStrikes]      — порог срабатывания (см. DEFAULTS)
 * @param {number}  [o.immediatePending]  — порог мгновенного срабатывания
 * @returns {{ wedged: boolean, strike: number, reason: string }}
 */
function evaluatePollHealth(o = {}) {
    const pending = Number.isFinite(o.pending) ? o.pending : 0;
    const processedSincePrev = !!o.processedSincePrev;
    const strike = Number.isInteger(o.strike) && o.strike > 0 ? o.strike : 0;
    const wedgeStrikes = Number.isInteger(o.wedgeStrikes) && o.wedgeStrikes > 0
        ? o.wedgeStrikes : DEFAULTS.wedgeStrikes;
    const immediatePending = Number.isInteger(o.immediatePending) && o.immediatePending > 0
        ? o.immediatePending : DEFAULTS.immediatePending;

    // Поллинг живой: апдейты доходят → любые подозрения сбрасываем.
    if (processedSincePrev) {
        return { wedged: false, strike: 0, reason: 'апдейты доходят' };
    }

    // Резкий скачок очереди — очевидное застревание (не ждём второй тик).
    if (pending >= immediatePending) {
        return {
            wedged: true,
            strike: strike + 1,
            reason: `pending_update_count=${pending} ≥ ${immediatePending}, апдейты не забираются`,
        };
    }

    // Накопленные апдейты без единого входящего с прошлого тика → подозрение.
    // Два таких тика подряд = поллинг завис. Один тик может быть «окном» между
    // отправкой пачки сообщений и их забором — не рвём процесс.
    if (pending > 0) {
        const s = strike + 1;
        const wedged = s >= wedgeStrikes;
        return {
            wedged,
            strike: wedged ? 0 : s,
            reason: wedged
                ? `pending>0 в ${s} тиках подряд без входящих апдейтов (pending=${pending})`
                : `подозрение: pending=${pending}, жду следующий тик (${s}/${wedgeStrikes})`,
        };
    }

    // Очередь пуста и апдейтов нет — обычная «тихая» пауза, не доказательство
    // зависания (поллинг мог встать, но никто и не писал). Не трогаем.
    return { wedged: false, strike: 0, reason: 'нет накопленных апдейтов' };
}

module.exports = {
    DEFAULTS,
    evaluatePollHealth,
};
