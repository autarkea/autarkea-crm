// ============================================================================
// shared/guard.js — «предохранители» ввода: безопасные пути и строгие id.
// ============================================================================
// Вынесено, чтобы покрыть юнит-тестами без запуска HTTP-сервисов.
//   - safeJoinWithin: сборка пути внутри каталога (защита от path traversal,
//     Проблема 124 — /pdfs/:filename читал любой файл контейнера);
//   - parsePositiveInt: строгий разбор положительного целого id
//     (parseInt('1; DROP TABLE') === 1 — Проблема 122).
//   - isSymlink / removeSymlinkIfAny: работа с путями, где может оказаться
//     симлинк (см. документацию, раздел «Проблема 135»: пара ссылок, ведущих
//     друг на друга, обрывается в ELOOP и файл перестаёт открываться).
// Тесты: tests/guard.test.js
// ============================================================================

const fs = require('fs');
const path = require('path');

// Собирает путь root/name, гарантируя, что результат лежит ВНУТРИ root.
// Возвращает абсолютный путь или null, если имя пытается выйти наружу.
// Отклоняем: пустое имя, NUL-байт, любые разделители пути ('/' и '\'),
// '.' и '..', абсолютные пути — и на всякий случай сверяем префикс результата.
function safeJoinWithin(root, name) {
    if (typeof name !== 'string' || name.length === 0) return null;
    if (name.includes('\0')) return null;
    if (name.includes('/') || name.includes('\\')) return null;
    if (name === '.' || name === '..') return null;

    const base = path.resolve(root);
    const full = path.resolve(base, name);
    if (full === base) return null;                       // «пустое» имя
    if (!full.startsWith(base + path.sep)) return null;   // вышли за каталог
    return full;
}

// Строгий разбор положительного целого id (защита от мусора и инъекций).
// Принимает только число или строку из цифр; всё остальное → null.
function parsePositiveInt(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) && value > 0 ? value : null;
    }
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const n = parseInt(value.trim(), 10);
        return n > 0 ? n : null;
    }
    return null;
}

// Симлинк ли это. lstat НЕ разыменовывает ссылку, поэтому работает и на битой,
// и на «зацикленной» ссылке (у которой existsSync уже возвращает false).
function isSymlink(filePath) {
    try {
        return fs.lstatSync(filePath).isSymbolicLink();
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
        throw e;
    }
}

// Убирает симлинк по пути, НЕ трогая его цель (реальный файл).
// Зачем: если записать файл по пути, где лежит ссылка, и одновременно держать
// обратную ссылку на этот же путь — получаются две ссылки друг на друга. Ядро
// обрывает такой обход на 40 переходах ошибкой ELOOP, и документ становится
// недоступен (ни сгенерировать, ни отправить — «файл не найден»).
// Возвращает true, если ссылку действительно удалили.
function removeSymlinkIfAny(filePath) {
    if (!isSymlink(filePath)) return false;
    fs.rmSync(filePath, { force: true }); // удаляется сама ссылка, цель остаётся на месте
    return true;
}

module.exports = { safeJoinWithin, parsePositiveInt, isSymlink, removeSymlinkIfAny };
