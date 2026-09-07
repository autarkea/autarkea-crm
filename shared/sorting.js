// ============================================================================
// shared/sorting.js — ЧИСТЫЕ компараторы для списков бота (v4.38.0)
// ============================================================================
// Проблема: fetchAllRows() ходит в NocoDB БЕЗ параметра sort → Data API отдаёт
// строки по Id asc («самые старые сверху»). Пока данных мало — незаметно, но
// при росте базы «рабочие очереди» (Задачи/Проекты) начинают показывать на
// странице 1 старьё, а в лентах (История/Архив) свежие записи прячутся в хвосте.
//
// Решение (гибрид, согласовано с владельцем 04.09.2026):
//   Задачи активные      — по «Когда делаем» asc: просроченные сверху (самые
//                           старые из просроченных — первыми), далее по дате,
//                           БЕЗ срока — в конец (свежие сверху).
//   Задачи «На сегодня»  — тот же компаратор: внутри дня порядок по времени.
//   Задачи проекта       — сначала НЕ выполненные (по сроку asc), потом
//                           выполненные (свежезакрытые сверху).
//   История задач        — по UpdatedAt desc (лента: свежие сверху).
//   Архив проектов       — по UpdatedAt desc (недавно закрытые сверху).
//   Контакты / Юрлица    — алфавит по имени (ru), пустые имена в конец.
//   Проекты (активные)   — по этапу работы: «Готов к сдаче» → «В работе» →
//                           «Обсуждение»; внутри этапа по «Срок проекта» asc,
//                           без срока — в конец (новые сверху).
//
// Общее правило: компаратор детерминирован — при РАВНЫХ ключах tie-break по Id
// (по умолчанию новые раньше = Id desc), чтобы порядок не «плавал» между
// рендерами одной и той же страницы.
//
// Используется ботом (bot/bot.js, перед slicePage после ролевого фильтра)
// и тестами (tests/sorting.test.js). Схему БД не меняет.
// ============================================================================

// ─────────────────────────────── Хелперы ────────────────────────────────────
// Timestamp из значения NocoDB (ISO/`YYYY-MM-DD`); null/''/битое → null.
function _ms(v) {
    if (v === null || v === undefined || v === '') return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
}

// Tie-break: при равном ключе выше — НОВАЯ запись (Id desc).
function _idDesc(a, b) {
    return (b.Id || 0) - (a.Id || 0);
}

// Tie-break для справочников: при полностью одинаковых именах выше — СТАРАЯ
// запись (Id asc), чтобы дубли не «прыгали» при каждой перерисовке.
function _idAsc(a, b) {
    return (a.Id || 0) - (b.Id || 0);
}

// ──────────────────────── Задачи: общий «дедлайн asc» ───────────────────────
// Просроченные автоматически оказываются сверху (их дата в прошлом и самая
// старая из них даёт наименьший ключ). Без срока (null) → +∞, т.е. в конец;
// внутри «без срока» — свежие сверху (Id desc).
function compareTasksActive(a, b) {
    const da = _ms(a['Когда делаем']);
    const db = _ms(b['Когда делаем']);
    const ka = da === null ? Infinity : da;
    const kb = db === null ? Infinity : db;
    if (ka !== kb) return ka - kb;
    return _idDesc(a, b);
}

// ──────────────────── Задачи проекта (активные + закрытые) ──────────────────
// Сначала невыполненные (по сроку asc, как в общем списке), затем выполненные
// (свежезакрытые сверху — по UpdatedAt desc). «Готово» не мешает сортировке
// внутри групп: группа активных всегда выше группы закрытых.
function compareProjectTasks(a, b) {
    const doneA = !!a['Готово'];
    const doneB = !!b['Готово'];
    if (doneA !== doneB) return doneA ? 1 : -1;
    if (!doneA) return compareTasksActive(a, b);
    const ua = _ms(a['UpdatedAt']) || 0;
    const ub = _ms(b['UpdatedAt']) || 0;
    if (ua !== ub) return ub - ua;
    return _idDesc(a, b);
}


// ─────────────────────────── Ленты: свежие сверху ───────────────────────────
// История задач и Архив проектов: последние изменения — первыми.
// Если UpdatedAt пуст — запись уходит в самый конец (ключ 0), а не «зависает»
// в начале ленты навсегда.
function compareByUpdatedAtDesc(a, b) {
    const ua = _ms(a['UpdatedAt']) || 0;
    const ub = _ms(b['UpdatedAt']) || 0;
    if (ua !== ub) return ub - ua;
    return _idDesc(a, b);
}

// ─────────────────── Справочники: алфавит (Контакты/Юрлица) ─────────────────
// Нормализуем имя (схлопывание пробелов, нижний регистр, русская локаль).
// Пустые/безымянные записи — в конец. Полностью одинаковые имена — по Id asc.
function _normName(v) {
    return String(v || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
}

function _compareByName(naRaw, nbRaw, a, b) {
    const na = _normName(naRaw);
    const nb = _normName(nbRaw);
    if (!na && !nb) return _idAsc(a, b);
    if (!na) return 1;
    if (!nb) return -1;
    const r = na.localeCompare(nb, 'ru');
    if (r !== 0) return r;
    return _idAsc(a, b);
}

function compareContactsByName(a, b) {
    return _compareByName(a['Имя'], b['Имя'], a, b);
}

function compareLegalsByName(a, b) {
    return _compareByName(a['Краткое Имя'] || a['Имя'], b['Краткое Имя'] || b['Имя'], a, b);
}

// ─────────────────── Проекты активные: этап → срок → свежесть ──────────────
// Порядок этапов (должен совпадать с активными статусами в bot.js):
//   «Готов к сдаче» — проекты, требующие финального действия (сдать/документы),
//   «В работе»      — текущие производства,
//   «Обсуждение»    — потенциальные/новые (ещё не запущены).
// Неизвестный/новый статус (добавили в NocoDB, но не обновили код) — в конец,
// чтобы не потерялся и не сломал сортировку.
const PROJECT_ACTIVE_STAGES = ['Готов к сдаче', 'В работе', 'Обсуждение'];

function _stageRank(status) {
    const i = PROJECT_ACTIVE_STAGES.indexOf(status);
    return i === -1 ? PROJECT_ACTIVE_STAGES.length : i;
}

function compareActiveProjectsByStage(a, b) {
    const ra = _stageRank(a['Статус']);
    const rb = _stageRank(b['Статус']);
    if (ra !== rb) return ra - rb;
    const da = _ms(a['Срок проекта']);
    const db = _ms(b['Срок проекта']);
    const ka = da === null ? Infinity : da;
    const kb = db === null ? Infinity : db;
    if (ka !== kb) return ka - kb;
    return _idDesc(a, b);
}

module.exports = {
    PROJECT_ACTIVE_STAGES,
    compareTasksActive,
    compareProjectTasks,
    compareByUpdatedAtDesc,
    compareContactsByName,
    compareLegalsByName,
    compareActiveProjectsByStage
};
