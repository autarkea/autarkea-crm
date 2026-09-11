// ============================================================================
// tests/webhook-utils.test.js — чистые помощники вебхука (shared/webhook-utils.js)
// ============================================================================
// Запуск (Node на хосте, без контейнеров и зависимостей):
//   node --test tests/
//
// Проверяет:
//   1. sanitizeFolderName: опасные символы, пробелы, фолбэк, обрезка (НЕ рвёт emoji).
//   2. sanitizeFileName: имя файла из Telegram.
//   3. formatContactName / getLinkedId — форматы полей NocoDB.
//   4. listFiles: рекурсия, скрытые файлы пропускаются.
//   5. generateClientId: формат ABC123 и уникальность.
//   6. findExistingProjectFolder: поиск папки по ID (защита от дублей).
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const u = require('../shared/webhook-utils');

// ─────────────────────────── sanitizeFolderName ─────────────────────────────
test('sanitizeFolderName: удаляет опасные для ФС символы', () => {
    assert.equal(u.sanitizeFolderName('a/b\\c:d*e?f"g<h>i|j@k\'l'), 'abcdefghijkl');
});

test('sanitizeFolderName: переносы строк → пробел, лишние пробелы схлопываются', () => {
    assert.equal(u.sanitizeFolderName('Первая\nВторая\r\n  Третья'), 'Первая Вторая Третья');
});

test('sanitizeFolderName: пустое/пробельное → «Без названия»', () => {
    assert.equal(u.sanitizeFolderName(''), 'Без названия');
    assert.equal(u.sanitizeFolderName(null), 'Без названия');
    assert.equal(u.sanitizeFolderName('   '), 'Без названия');
    assert.equal(u.sanitizeFolderName('...'), 'Без названия');
});

test('sanitizeFolderName: обрезка до maxLength с многоточием', () => {
    const out = u.sanitizeFolderName('A'.repeat(80), 20);
    assert.equal(out.length, 20);
    assert.equal(out, 'A'.repeat(17) + '...');
});

test('sanitizeFolderName: emoji не рвётся при обрезке (code points, не UTF-16)', () => {
    const name = '01😀456789012345';            // 15 code points
    const out = u.sanitizeFolderName(name, 10); // → 7 code points + '...'
    assert.equal(out, '01😀4567...');
    assert.equal(Buffer.from(out, 'utf8').toString('utf8'), out);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out));
});

test('sanitizeFolderName: по умолчанию 50 символов', () => {
    assert.equal(u.sanitizeFolderName('B'.repeat(100)), 'B'.repeat(47) + '...');
});

// ─────────────────────────── sanitizeFileName ───────────────────────────────
test('sanitizeFileName: разрешённые символы сохраняются, остальные → «_»', () => {
    assert.equal(u.sanitizeFileName('отчёт_2026.pdf'), 'отчёт_2026.pdf');
    assert.equal(u.sanitizeFileName('a/b\\c:d.pdf'), 'a_b_c_d.pdf');
    assert.equal(u.sanitizeFileName('file (1).PNG'), 'file _1_.PNG'); // скобки не разрешены
    assert.equal(u.sanitizeFileName('../../evil.sh'), '.._.._evil.sh'); // нет path traversal
    assert.equal(u.sanitizeFileName(''), '');
});

// ─────────────────────────── formatContactName ──────────────────────────────
test('formatContactName: @username → (username)', () => {
    assert.equal(u.formatContactName('Иван @petrov'), 'Иван (petrov)');
    assert.equal(u.formatContactName('Без собаки'), 'Без собаки');
    assert.equal(u.formatContactName(''), '');
    assert.equal(u.formatContactName(null), '');
});

// ─────────────────────────── getLinkedId ────────────────────────────────────
test('getLinkedId: массив / объект / число / строка / пусто', () => {
    assert.equal(u.getLinkedId([{ Id: 5 }]), 5);
    assert.equal(u.getLinkedId({ Id: 7 }), 7);
    assert.equal(u.getLinkedId(9), 9);
    assert.equal(u.getLinkedId('11'), '11');
    assert.equal(u.getLinkedId([]), null);
    assert.equal(u.getLinkedId({}), null);
    assert.equal(u.getLinkedId(null), null);
});

// ─────────────────────────── listFiles ──────────────────────────────────────
test('listFiles: рекурсия, скрытые файлы пропускаются', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-list-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    fs.writeFileSync(path.join(root, '.hidden'), 'x');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'x');

    const out = u.listFiles(root);
    assert.ok(out.includes('- a.txt\n'), 'обычный файл виден');
    assert.ok(out.includes('- sub/\n'), 'папка с «/»');
    assert.ok(out.includes('  - b.txt\n'), 'вложенный файл с отступом');
    assert.ok(!out.includes('.hidden'), 'скрытый файл пропущен');

    fs.rmSync(root, { recursive: true, force: true });
});

test('listFiles: несуществующая папка → [Ошибка чтения]', () => {
    assert.ok(u.listFiles('/no/such/dir/xyz').includes('[Ошибка чтения]'));
});

// ─────────────────────────── generateClientId ───────────────────────────────
test('generateClientId: формат AAA999', () => {
    for (let i = 0; i < 50; i++) {
        assert.match(u.generateClientId(), /^[A-Z]{3}\d{3}$/);
    }
});

test('generateClientId: значения различаются', () => {
    const set = new Set(Array.from({ length: 200 }, () => u.generateClientId()));
    assert.ok(set.size > 190, `уникальных: ${set.size} из 200`);
});

// ─────────────────── findExistingProjectFolder ──────────────────────────────
test('findExistingProjectFolder: находит папку по ID и разным разделителям', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-proj-'));
    fs.mkdirSync(path.join(root, '5 - Проект - Клиент'));
    fs.mkdirSync(path.join(root, '6_Другой - Клиент2'));

    assert.equal(
        u.findExistingProjectFolder(root, 5, 'Проект', 'Клиент'),
        path.join(root, '5 - Проект - Клиент')
    );
    assert.equal(
        u.findExistingProjectFolder(root, 6, 'Другой', 'Клиент2'),
        path.join(root, '6_Другой - Клиент2')  // разделитель «_» тоже распознан
    );
    assert.equal(u.findExistingProjectFolder(root, 999, 'x', 'y'), null);

    fs.rmSync(root, { recursive: true, force: true });
});

test('findExistingProjectFolder: несуществующий root → null', () => {
    assert.equal(u.findExistingProjectFolder('/no/such/root', 1, 'a', 'b'), null);
});
