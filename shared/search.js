// ============================================================================
// shared/search.js — ЧИСТЫЕ предикаты поиска по справочникам (Контакты/Юрлица)
// ============================================================================
// v4.54.0: единый поиск по клиентской базе для всех флоу бота:
//   - справочники «📇 Контакты» / «🏢 Юрлица» (кнопка «🔍 Найти …» в списке),
//   - выбор клиента в визарде проекта (v4.16.0, автопоиск),
//   - привязка юрлица к контакту (v4.43.0).
// Раньше фильтр был ЗАДУБЛИРОВАН в трёх местах bot/bot.js — при добавлении поля
// в поиск приходилось править все копии (и забывалось). Теперь один источник.
//
// Семантика совпадения (сохранена как в bot.js до выноса):
//   регистронезависимо + транслит кириллица↔латиница (shared/text.normalizeSearch):
//   «ivan» находит «Иван», «ё» = «е», «й» = «и». Подстрока: «нов» найдёт «Иванов».
//   Пустой/слишком короткий запрос → [] (пустой массив, ничего не находим).
// Тесты: tests/search.test.js.
// ============================================================================

const { normalizeSearch } = require('./text');

// Один ли из полей содержит запрос (по нормализованной подстроке).
function _anyFieldMatches(fields, q) {
    if (!q) return false;
    for (const f of fields) {
        if (f === null || f === undefined) continue;
        if (normalizeSearch(f).includes(q)) return true;
    }
    return false;
}

// Контакты (физлица): имя, телефон, ссылка (@username), e-mail.
function filterContactsByQuery(rows, query) {
    const q = normalizeSearch(query);
    if (!q) return [];
    return rows.filter(c => _anyFieldMatches([c['Имя'], c['Телефон'], c['Ссылка'], c['E-mail']], q));
}

// Юрлица: краткое/полное имя, телефон, e-mail, УНП, адрес.
function filterLegalsByQuery(rows, query) {
    const q = normalizeSearch(query);
    if (!q) return [];
    return rows.filter(l => _anyFieldMatches(
        [l['Краткое Имя'], l['Имя'], l['Телефон'], l['E-mail'], l['УНП'], l['Адрес']], q
    ));
}

module.exports = {
    filterContactsByQuery,
    filterLegalsByQuery
};
