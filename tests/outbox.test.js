// ============================================================================
// tests/outbox.test.js — персистентная очередь исходящих (v4.49.0, Волна 1)
// ============================================================================
// Чистый модуль shared/outbox.js работает только с fs (никакой сети/Telegram).
// Тесты используют временный каталог, ничего не пишут в /mnt/data.
//
// Запуск (Node на хосте, без контейнеров):
//   node --test tests/
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const outbox = require('../shared/outbox');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-test-'));
}

// ─────────────────────────── Базовый цикл жизни ─────────────────────────────
test('append → has → list → update → remove', () => {
    const dir = tmpDir();

    assert.equal(outbox.append(dir, { id: 'task_42_777', chatId: 777, text: 'привет' }), true);
    assert.equal(outbox.has(dir, 'task_42_777'), true);

    const all = outbox.list(dir);
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'task_42_777');
    assert.equal(all[0].chatId, 777);
    assert.equal(all[0].text, 'привет');
    assert.equal(all[0].attempts, 0);
    assert.equal(all[0].nextAttemptAt, 0);

    // backoff-обновление
    assert.equal(outbox.update(dir, 'task_42_777', { attempts: 1, nextAttemptAt: 999 }), true);
    const upd = outbox.get(dir, 'task_42_777');
    assert.equal(upd.attempts, 1);
    assert.equal(upd.nextAttemptAt, 999);

    assert.equal(outbox.remove(dir, 'task_42_777'), true);
    assert.equal(outbox.has(dir, 'task_42_777'), false);
    assert.equal(outbox.list(dir).length, 0);
});

test('дубликат по id не добавляется и не перезаписывает текст', () => {
    const dir = tmpDir();
    outbox.append(dir, { id: 'k1', chatId: 1, text: 'первый текст' });
    // повторная генерация того же уведомления (тик раз в 5 мин) — должна игнорироваться
    assert.equal(outbox.append(dir, { id: 'k1', chatId: 1, text: 'другой текст' }), false);
    const rec = outbox.get(dir, 'k1');
    assert.equal(rec.text, 'первый текст');
    assert.equal(outbox.list(dir).length, 1);
});

test('записи отдаются FIFO (старые первыми) даже при разнобое имён файлов', () => {
    const dir = tmpDir();
    outbox.append(dir, { id: 'b', createdAt: 200 });
    outbox.append(dir, { id: 'a', createdAt: 100 });
    outbox.append(dir, { id: 'c', createdAt: 300 });
    const ids = outbox.list(dir).map(r => r.id);
    assert.deepEqual(ids, ['a', 'b', 'c']);
});

// ─────────────────────── Устойчивость к мусору/границам ─────────────────────
test('list не падает и не спотыкается о битые файлы', () => {
    const dir = tmpDir();
    outbox.append(dir, { id: 'good1', chatId: 1, text: 'x' });
    fs.writeFileSync(path.join(dir, 'crashed.json'), '{не-json');
    fs.writeFileSync(path.join(dir, 'note.txt'), 'не очередь');
    fs.mkdirSync(path.join(dir, 'subdir'));

    const all = outbox.list(dir);
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'good1');
});

test('list/append не падают, если каталога нет', () => {
    assert.deepEqual(outbox.list('/no/such/outbox-dir'), []);
    const dir = path.join(tmpDir(), 'nested', 'deep');
    assert.equal(outbox.append(dir, { id: 'x', chatId: 1, text: 't' }), true);
    assert.equal(outbox.has(dir, 'x'), true); // каталог создан рекурсивно
});

test('переполнение (maxRecords) НЕ кладёт запись', () => {
    const dir = tmpDir();
    for (let i = 0; i < outbox.DEFAULTS.maxRecords; i++) {
        assert.equal(outbox.append(dir, { id: `rec_${i}`, chatId: i, text: 'x' }), true);
    }
    assert.equal(outbox.append(dir, { id: 'overflow', chatId: 1, text: 'x' }), false);
    assert.equal(outbox.has(dir, 'overflow'), false);
});

test('id с небезопасными символами превращается в валидное имя файла', () => {
    const dir = tmpDir();
    assert.equal(outbox.append(dir, { id: 'задача/№12_тг', chatId: 1, text: 'x' }), true);
    assert.equal(outbox.has(dir, 'задача/№12_тг'), true);
    // имя файла без слэшей — единственный .json в каталоге
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);
    assert.equal(files[0].includes('/'), false);
});

test('parseMode и journal сохраняются в записи', () => {
    const dir = tmpDir();
    outbox.append(dir, { id: 'r1', chatId: 1, text: 't', parseMode: 'Markdown', journal: 'deadlines' });
    const rec = outbox.get(dir, 'r1');
    assert.equal(rec.parseMode, 'Markdown');
    assert.equal(rec.journal, 'deadlines');
});

// ───────────────────────────── replyMarkup (v4.53.0) ─────────────────────────
test('replyMarkup сохраняется в записи и отдаётся в get/list', () => {
    const dir = tmpDir();
    const kb = { inline_keyboard: [[{ text: '👁 Открыть задачу', callback_data: 'view_42' }]] };
    outbox.append(dir, { id: 'r_kb', chatId: 1, text: 't', replyMarkup: kb, journal: 'tasks' });

    const rec = outbox.get(dir, 'r_kb');
    assert.deepEqual(rec.replyMarkup, kb);
    assert.equal(rec.replyMarkup.inline_keyboard[0][0].callback_data, 'view_42');

    const listed = outbox.list(dir).find(r => r.id === 'r_kb');
    assert.deepEqual(listed.replyMarkup, kb);
});

test('replyMarkup отсутствует → в записи null (старые записи совместимы)', () => {
    const dir = tmpDir();
    outbox.append(dir, { id: 'r_no_kb', chatId: 1, text: 't' });
    const rec = outbox.get(dir, 'r_no_kb');
    assert.equal(rec.replyMarkup, null);
    assert.equal('replyMarkup' in rec, true); // поле есть всегда → flush не спотыкается
});

// ─────────────────────── Рассинхрон имени файла и id (кейс смоука R3) ───────
test('list отдаёт _file; removeFile удаляет запись даже при рассинхроне имени и id', () => {
    const dir = tmpDir();
    // «ручной инжект»: имя файла НЕ совпадает с id внутри → старый remove по id не находил файл → дубли
    fs.writeFileSync(path.join(dir, 'manual.json'),
        JSON.stringify({ id: 'real_id_1', chatId: 1, text: 'x', createdAt: 1 }));

    const all = outbox.list(dir);
    assert.equal(all.length, 1);
    assert.equal(all[0]._file, 'manual.json'); // flush знает фактическое имя файла

    // старое поведение: удаление по id не находит файл (источник дублей)
    assert.equal(outbox.remove(dir, 'real_id_1'), false);
    assert.equal(outbox.list(dir).length, 1);

    // новое поведение: удаление по _file работает
    assert.equal(outbox.removeFile(dir, all[0]._file), true);
    assert.equal(outbox.list(dir).length, 0);
});

test('removeFile защищён от path traversal и пустых имён', () => {
    const dir = tmpDir();
    assert.equal(outbox.removeFile(dir, '../etc/passwd'), false);
    assert.equal(outbox.removeFile(dir, 'a/b.json'), false);
    assert.equal(outbox.removeFile(dir, ''), false);
    assert.equal(outbox.removeFile(dir, '.'), false);
});
