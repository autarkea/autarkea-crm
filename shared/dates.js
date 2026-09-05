// ============================================================================
// shared/dates.js — ЧИСТЫЕ утилиты дат/сроков (таймзона — параметром)
// ============================================================================
// В bot.js таймзона приходила из config.TZ. Здесь функции НЕ зависят от
// глобалов: tz передаётся аргументом → можно тестировать (tests/dates.test.js)
// и переиспользовать. Поведение = как было в bot.js до выноса (v4.41.0).
// ============================================================================

// «26.08.2026, 10:00» — полный формат (аналог formatMinskDate/formatMinskDateShort)
function formatFull(dateStr, tz) {
    if (!dateStr) return null;
    try {
        return new Intl.DateTimeFormat('ru-RU', {
            timeZone: tz, day: '2-digit', month: '2-digit',
            year: 'numeric', hour: '2-digit', minute: '2-digit'
        }).format(new Date(dateStr));
    } catch (e) { return dateStr; }
}

// «26.08 10:00» — без года (аналог formatTaskShortDate)
function formatDayTime(dateStr, tz) {
    if (!dateStr) return '';
    try {
        return new Intl.DateTimeFormat('ru-RU', {
            timeZone: tz, day: '2-digit', month: '2-digit',
            hour: '2-digit', minute: '2-digit'
        }).format(new Date(dateStr));
    } catch (e) { return String(dateStr); }
}

// «10:00» — только время (аналог formatTaskTime)
function formatTime(dateStr, tz) {
    if (!dateStr) return '';
    try {
        return new Intl.DateTimeFormat('ru-RU', {
            timeZone: tz, hour: '2-digit', minute: '2-digit'
        }).format(new Date(dateStr));
    } catch (e) { return String(dateStr); }
}

// Текущее смещение таймзоны относительно UTC в миллисекундах.
function getTZOffsetMs(tz) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const p = Object.fromEntries(dtf.formatToParts(new Date()).map(x => [x.type, x.value]));
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUTC - Date.now();
}

// Построение даты «N дней от сегодня» в H:M по таймзоне tz.
// В БД хранится UTC: берём «сейчас» в поясе, строим целевую дату в координатах
// пояса и вычитаем смещение — получаем корректный UTC-момент.
function buildDateInTZ(tz, daysOffset, hourLocal, minute = 0) {
    const offsetMs = getTZOffsetMs(tz);
    const nowInTZ = new Date(Date.now() + offsetMs); // «сейчас» в поясе (в UTC-координатах)
    const targetUTC = Date.UTC(nowInTZ.getUTCFullYear(), nowInTZ.getUTCMonth(), nowInTZ.getUTCDate() + daysOffset, hourLocal, minute, 0);
    return new Date(targetUTC - offsetMs);
}

// v2: Умный парсер дедлайна. Поддерживает:
//   быстрые слова: «сегодня»(+3ч), «завтра»(09:00 Минск), «послезавтра»(09:00), «неделя»(+7 дней в то же время)
//   слово + время: «завтра 14:00», «сегодня 18:00»
//   относительные: «через 2 дня», «через 5 часов», «через 7 дней»
//   время: «14:00» (сегодня если ещё не прошло, иначе завтра)
//   даты: 17.06, 17.06.2026, 17/06/2026, 2026-06-17 (+ время)
//   дни недели: пн/понедельник ... вс/воскресенье (ближайший будущий, 09:00 Минск)
// Валидация: несуществующие даты (32.06, 17.13, 25:00) → null
function parseSmartDeadline(text, tz) {
    const now = new Date(); text = text.toLowerCase().trim();

    // ==== Быстрые слова ====
    if (text === 'сегодня' || text === 'через 3 часа' || text === 'через три часа') {
        const d = new Date(now); d.setHours(d.getHours() + 3); return d;
    }
    if (text === 'завтра') return buildDateInTZ(tz, 1, 9, 0);
    if (text === 'послезавтра') return buildDateInTZ(tz, 2, 9, 0);
    if (text === 'неделя' || text === 'через неделю' || text === 'через 7 дней' || text === 'через семь дней') {
        const d = new Date(now); d.setDate(d.getDate() + 7); return d;
    }

    // ==== Слово-день + время: "завтра 14:00", "сегодня 18:00" ====
    const whenTimeMatch = text.match(/^(сегодня|завтра|послезавтра)\s+(\d{1,2}):(\d{2})$/);
    if (whenTimeMatch) {
        const dayOffset = whenTimeMatch[1] === 'сегодня' ? 0 : whenTimeMatch[1] === 'завтра' ? 1 : 2;
        const hour = parseInt(whenTimeMatch[2]), minute = parseInt(whenTimeMatch[3]);
        if (hour > 23 || minute > 59) return null;
        return buildDateInTZ(tz, dayOffset, hour, minute);
    }

    // ==== Относительные: "через 2 дня", "через 5 часов" ====
    const relMatch = text.match(/через\s+(\d+)\s*(день|дня|дней|час|часа|часов|неделю|недели|недель|минуту|минуты|минут)/);
    if (relMatch) {
        const n = parseInt(relMatch[1]);
        const d = new Date(now);
        const unit = relMatch[2];
        if (unit === 'день' || unit === 'дня' || unit === 'дней') d.setDate(d.getDate() + n);
        else if (unit === 'час' || unit === 'часа' || unit === 'часов') d.setHours(d.getHours() + n);
        else if (unit === 'неделю' || unit === 'недели' || unit === 'недель') d.setDate(d.getDate() + n * 7);
        else d.setMinutes(d.getMinutes() + n);
        return d;
    }

    // ==== Только время: "14:00" (сегодня, если ещё не прошло, иначе завтра) ====
    const timeOnlyMatch = text.match(/^(\d{1,2}):(\d{2})$/);
    if (timeOnlyMatch) {
        const hour = parseInt(timeOnlyMatch[1]), minute = parseInt(timeOnlyMatch[2]);
        if (hour > 23 || minute > 59) return null;
        let d = buildDateInTZ(tz, 0, hour, minute);
        if (d.getTime() <= Date.now()) d = buildDateInTZ(tz, 1, hour, minute);
        return d;
    }
    return parseDateOrWeekday(text, tz, now);
}

// Дата «17.06», «17.06.2026», «2026-06-17» (+время) и дни недели — вынесено,
// чтобы parseSmartDeadline не разрастался (логика перенесена как была).
function parseDateOrWeekday(text, tz, now) {
    // ==== Дата: 17.06, 17.06.2026, 17/06, 17/06/2026, 2026-06-17 ====
    const dateMatch = text.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?/) || text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (dateMatch) {
        let day, month, year;
        if (text.includes('-')) {
            year = parseInt(dateMatch[1]); month = parseInt(dateMatch[2]) - 1; day = parseInt(dateMatch[3]);
        } else {
            day = parseInt(dateMatch[1]); month = parseInt(dateMatch[2]) - 1; year = dateMatch[3] ? parseInt(dateMatch[3]) : now.getFullYear();
        }
        const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
        const hour = timeMatch ? parseInt(timeMatch[1]) : 10, minute = timeMatch ? parseInt(timeMatch[2]) : 0;
        // Валидация существующей даты
        if (month < 0 || month > 11 || day < 1 || hour > 23 || minute > 59) return null;
        const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        if (day > daysInMonth) return null;
        return new Date(Date.UTC(year, month, day, hour - 3, minute, 0));
    }

    // ==== Дни недели: пн/понедельник ... вс/воскресенье (ближайший будущий, 09:00 Минск) ====
    const weekdayNames = [
        ['понедельник', 1], ['вторник', 2], ['среда', 3], ['четверг', 4], ['пятница', 5], ['суббота', 6], ['воскресенье', 0],
        ['пн', 1], ['вт', 2], ['ср', 3], ['чт', 4], ['пт', 5], ['сб', 6], ['вс', 0]
    ];
    for (const [name, target] of weekdayNames) {
        if (text === name || text.startsWith(name + ' ') || text.includes(' ' + name)) {
            const nowTZ = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
            let days = (target - nowTZ.getDay() + 7) % 7;
            if (days === 0) days = 7; // сегодняшний день не берём — только будущий
            return buildDateInTZ(tz, days, 9, 0);
        }
    }

    return null;
}

// Быстрые кнопки выбора срока (callback_data dl_*) → дата через parseSmartDeadline
function parseQuickDeadline(option, tz) {
    if (option === '3h') return parseSmartDeadline('через 3 часа', tz);
    if (option === 'tomorrow9') return parseSmartDeadline('завтра', tz);
    if (option === 'week') return parseSmartDeadline('через неделю', tz);
    return null;
}

module.exports = {
    formatFull,
    formatDayTime,
    formatTime,
    getTZOffsetMs,
    buildDateInTZ,
    parseSmartDeadline,
    parseQuickDeadline
};

