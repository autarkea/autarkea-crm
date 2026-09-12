// ============================================================================
// shared/guard.js — «предохранители» ввода: безопасные пути и строгие id.
// ============================================================================
// Вынесено, чтобы покрыть юнит-тестами без запуска HTTP-сервисов.
//   - safeJoinWithin: сборка пути внутри каталога (защита от path traversal,
//     Проблема 124 — /pdfs/:filename читал любой файл контейнера);
//   - parsePositiveInt: строгий разбор положительного целого id
//     (parseInt('1; DROP TABLE') === 1 — Проблема 122).
// Тесты: tests/guard.test.js
// ============================================================================

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

module.exports = { safeJoinWithin, parsePositiveInt };
