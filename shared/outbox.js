// ============================================================================
// shared/outbox.js — персистентная очередь исходящих уведомлений (v4.49.0)
// ============================================================================
// Проблема (Волна 1 безотказности, 09.09.2026): при недоступности Telegram
// (у сервера пропал интернет) bot.sendMessage падал, ошибка глоталась через
// .catch(()=>{}), а «журналы» notifiedTasks / notifiedDeadlines помечали ключ
// ДО отправки → уведомление (дедлайн, назначение, утренняя сводка) терялось
// навсегда, пока жив процесс.
//
// Решение: надёжный канал доставки. Модуль хранит записи ОТДЕЛЬНЫМИ файлами
// в каталоге (по умолчанию /mnt/data/logs/outbox — вне контейнера, переживает
// рестарт и reboot). Никакой сети — только fs, поэтому модуль тестируется
// в tests/outbox.test.js без Telegram.
//
// Формат записи:
//   { id, chatId, text, parseMode, journal, createdAt, attempts, nextAttemptAt }
//   id     — уникальный ключ. У напоминаний id = ключ журнала
//            (`<taskId>_<tgId>_due` и т.п.) → flush не создаст дубль,
//            а append с тем же id игнорируется.
//   journal — 'tasks' | 'deadlines' | null: в какой Set-журнал bot.js кладёт
//            ключ ПОСЛЕ реальной доставки (защита от дублей при след. тике).
//   attempts / nextAttemptAt — экспоненциальный backoff (заполняет bot.js).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Жёсткие лимиты (константы модуля — не env):
// maxRecords  — больше записей в очередь не кладём: переполнение = экзотика
//               (недоступный Telegram + длинный простой), но диск важнее.
// maxAttempts — попыток на запись; после — запись удаляется с логом в bot.js
//               (запись с мёртвым chat_id не должна долбиться вечно).
const DEFAULTS = {
    maxRecords: 500,
    maxAttempts: 20,
};

// Безопасное имя файла из id: в ключах журналов есть цифры/точки/подчёркивания.
function safeFileName(id) {
    return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

function fileFor(dir, id) {
    return path.join(dir, `${safeFileName(id)}.json`);
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

/**
 * Добавляет запись в очередь.
 * @returns {boolean} true — добавлена; false — дубликат по id ИЛИ очередь переполнена.
 */
function append(dir, record) {
    ensureDir(dir);
    const id = String(record.id);
    if (fs.existsSync(fileFor(dir, id))) return false; // дубликат — flush доставит

    let count = 0;
    try {
        count = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
    } catch (e) { count = 0; }
    if (count >= DEFAULTS.maxRecords) return false;

    const rec = {
        id,
        chatId: record.chatId,
        text: String(record.text),
        parseMode: record.parseMode || null,
        // v4.53.0: опциональная inline-клавиатура (например «👁 Открыть задачу»
        // в уведомлениях). Хранится в JSON-файле → переживает рестарт/reboot,
        // flush доставит кнопку вместе с текстом. Старые записи без поля = null.
        replyMarkup: record.replyMarkup || null,
        journal: record.journal || null,
        createdAt: record.createdAt || Date.now(),
        attempts: 0,
        nextAttemptAt: 0,
    };
    fs.writeFileSync(fileFor(dir, id), JSON.stringify(rec), 'utf8');
    return true;
}

function has(dir, id) {
    return fs.existsSync(fileFor(dir, id));
}

function get(dir, id) {
    try {
        return JSON.parse(fs.readFileSync(fileFor(dir, id), 'utf8'));
    } catch (e) { return null; }
}

/**
 * Все записи очереди, старые первыми (FIFO). Битые файлы (обрыв записи)
 * пропускаем — они не мешают живым и не роняют flush.
 * Каждая запись получает служебное поле `_file` (имя файла) — по нему flush
 * удаляет запись НАДЁЖНО, даже если имя файла не совпадает с id внутри
 * (v4.51.0, итог смоука R3: ручной инжект с рассинхроном имени вызвал
 * бесконечные дубли доставки — удаление по id не находило файл).
 */
function list(dir) {
    let files = [];
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch (e) { return []; }
    const out = [];
    for (const f of files) {
        try {
            const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (rec && rec.id != null) {
                rec._file = f;
                out.push(rec);
            }
        } catch (e) { /* битый файл — пропускаем */ }
    }
    out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return out;
}

function remove(dir, id) {
    try { fs.unlinkSync(fileFor(dir, id)); return true; } catch (e) { return false; }
}

// Удаление по фактическому имени файла (см. list → _file).
function removeFile(dir, fileName) {
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..') {
        return false;
    }
    try { fs.unlinkSync(path.join(dir, fileName)); return true; } catch (e) { return false; }
}

/**
 * Точечное обновление записи (attempts / nextAttemptAt для backoff).
 * @returns {boolean} true — запись найдена и обновлена.
 */
function update(dir, id, patch) {
    const rec = get(dir, id);
    if (!rec) return false;
    try {
        fs.writeFileSync(fileFor(dir, id), JSON.stringify({ ...rec, ...patch }, null, 2), 'utf8');
        return true;
    } catch (e) { return false; }
}

module.exports = { DEFAULTS, append, has, get, list, remove, removeFile, update };
