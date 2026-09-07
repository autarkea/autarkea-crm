// ============================================================================
// shared/text.js — ЧИСТЫЕ текстовые утилиты бота (без config/сети/Telegram)
// ============================================================================
// Markdown-экранирование, plain-text fallback, подписи кнопок, транслит-поиск.
// Используются bot/bot.js (и тестами tests/text.test.js). Поведение = как было
// в bot.js до выноса (v4.41.0): НИЧЕГО не меняем, только переносим и тестируем.
// ============================================================================

// Экранирование спецсимволов Telegram Markdown v1 (для parse_mode: 'Markdown').
function escapeMarkdown(text) {
    if (!text) return '';
    return String(text)
        .replace(/\\/g, '\\\\')  // Сначала экранируем обратный слэш
        .replace(/[_*`\[]/g, '\\$&');  // Только спецсимволы Markdown v1
}

// Подпись кнопки-пункта в списках-«меню» (Проекты/Контакты/Юрлица/Архив).
// Inline-кнопки Telegram не переваривают переносы строк и очень длинные подписи
// → схлопываем пробелы и режем до максимума с многоточием.
const BUTTON_TEXT_MAX = 60;
function cleanButtonText(text, max = BUTTON_TEXT_MAX) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

// Стрип Markdown-разметки и обрезка до лимита Telegram (4096) для fallback-отправки.
// Раньше ошибка 400 (напр. '_' в ссылке контакта ломает Markdown v1) молча
// глоталась — бот НЕ отвечал на команду. Теперь в этом случае шлём plain text.
function plainTextFromMarkdown(text) {
    let out = String(text || '')
        .replace(/[*_`[\]]/g, '')  // спецсимволы Markdown v1 (bold/italic/code/link)
        .replace(/\\/g, '');        // экранирующие бэкслеши от escapeMarkdown
    if (out.length > 3900) out = out.slice(0, 3900) + '\n…(обрезано, полный список — в NocoDB)';
    return out;
}

// ──────────────────── Нормализация поиска (транслит) ────────────────────────
// Нужна, чтобы «ivan» и «Иван»/«іван» находили одно и то же. Нижний регистр + транслит.
const TRANSLIT_MAP = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'u', 'я': 'ya'
};
function normalizeSearch(text) {
    if (!text) return '';
    let out = '';
    for (const ch of String(text).toLowerCase().trim()) {
        out += TRANSLIT_MAP[ch] || ch;
    }
    return out;
}

module.exports = {
    escapeMarkdown,
    cleanButtonText,
    plainTextFromMarkdown,
    normalizeSearch
};
