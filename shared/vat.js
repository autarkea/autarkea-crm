// ============================================================================
// shared/vat.js — единый расчёт НДС (v4.37.0)
// ============================================================================
// Используется:
//   - bot/bot.js   → сводка позиций в карточке проекта (getProjectSummary)
//   - bot/server.js → форма отправки email (baseTotal + разбивка НДС)
//   - tests/vat.test.js → тесты формул
// Значения селектов должны совпадать с опциями «Тип НДС» таблицы
// «Мои реквизиты» в NocoDB (проверка по template.db: Без НДС / Включен в цену /
// Начисляется сверху). Документировано: документация → раздел «Расчёт НДС».
//
// Формулы:
//   Без НДС:            НДС = 0,                  итого = база
//   Начисляется сверху: НДС = база × ставка / 100, итого = база + НДС
//   Включен в цену:     НДС = база × ставка / (100 + ставка), итого = база
//
// ⚠️ ЧТО ТАКОЕ «БАЗА» (это же пользователь вводит в «Цену» позиции):
//   Без НДС            — НДС не облагается (УСН); база = цена как есть;
//   Начисляется сверху — база = цена БЕЗ НДС, налог ДОБАВЛЯЕТСЯ (итого > базы);
//   Включен в цену     — база = цена С НДС (как в прайсе), налог ВЫНИМАЕТСЯ
//                        (итого = база). Не путать: тут база уже содержит НДС.
// Отсюда «сумма проекта» в разных режимах означает разное — интерфейс обязан
// подписывать это явно («сумма без НДС» / «в т.ч. НДС»), что и делают карточка
// бота (bot.js getProjectSummary) и форма email (bot/server.js).
// ============================================================================

const VAT_NONE = 'Без НДС';
const VAT_INCLUDED = 'Включен в цену';
const VAT_ON_TOP = 'Начисляется сверху';

// Значение «Тип» в «Позициях заказа» для материалов заказчика.
// Такие позиции НЕ платные: в документах идут отдельной таблицей БЕЗ цен,
// поэтому исключаются из суммы и из счётчика платных позиций.
const CUSTOMER_MATERIAL = 'Мат. заказчика';

// Позиция = материал заказчика? (не входит в выручку/счёт)
function isCustomerMaterial(item) {
    return !!(item && item['Тип'] === CUSTOMER_MATERIAL);
}

// ─── Маршрут «тип позиции → документ» (v4.64.5) ──────────────────────────────
// Нужен, чтобы сумма в предпросмотре email (/send-email) считалась по СОСТАВУ
// конкретного документа, а не по всему проекту (раньше акт в смешанном проекте
// «Работа + Изделие» показывал в письме одну сумму, а в PDF — другую).
// Правила совпадают с фильтрами PDF-шаблонов:
//   Счёт      → все платные позиции (кроме «Мат. заказчика»);
//   Акт       → ТОЛЬКО «Работа»;
//   Накладная → «Товар» + «Изделие» (легаси «Товар+Работа» → «Изделие»).
// ⚠️ Легаси-нормализация продублирована в HTML-шаблонах (templates/*.html):
// они рендерятся Puppeteer как отдельные файлы и этот модуль импортировать не
// могут. Меняешь правило здесь — правь и шаблоны; паритет стерегут тесты.
const LEGACY_GOODS = 'Товар+Работа';
const ITEM_WORK = 'Работа';
const ITEM_GOODS = ['Товар', 'Изделие'];

// Тип документа → допустимые типы позиций. Ключа нет = все платные
// (счёт и любое неизвестное значение — безопасный фоллбэк «как раньше»).
const DOC_ITEM_TYPES = {
    'Акт': [ITEM_WORK],
    'Акт (Физлицо)': [ITEM_WORK],
    'Накладная': ITEM_GOODS,
    'ТН': ITEM_GOODS
};

// Нормализация типа позиции: легаси «Товар+Работа» → «Изделие» (v4.48.0).
function normalizeItemType(type) {
    return type === LEGACY_GOODS ? 'Изделие' : type;
}

// Попадает ли позиция в документ этого типа? (false — не платим/не печатаем)
// docType не задан (undefined/null/'') → все платные = историческое поведение.
function isItemInDocument(item, docType) {
    if (!item || isCustomerMaterial(item)) return false;
    const types = DOC_ITEM_TYPES[docType];
    if (!types) return true;
    return types.includes(normalizeItemType(item['Тип']));
}

// ─── Валидация настройки НДС (v4.65.0) ──────────────────────────────────────
// «Мои реквизиты» могут быть настроены противоречиво: выбран тип с налогом, а
// ставка пуста. В этом случае документ формировать НЕЛЬЗЯ: он напечатает
// «Ставка НДС 0%» и нулевой налог — а «0%» это отдельный налоговый режим
// (напр. экспорт), не то же самое, что «Без НДС» (УСН). Поэтому fail-closed:
// генерация и отправка блокируются, интерфейс честно говорит что заполнить.
const VAT_TYPES = [VAT_NONE, VAT_INCLUDED, VAT_ON_TOP];
const VAT_RATE_MISSING = 'VAT_RATE_MISSING';
const VAT_TYPE_UNKNOWN = 'VAT_TYPE_UNKNOWN';

// Значения строки «Мои реквизиты» → нормализованный конфиг.
// Пустой/отсутствующий тип трактуем как «Без НДС» (штатный режим УСН) — как и
// раньше: свежая установка с пустыми реквизитами продолжает работать.
function parseVatConfig(row) {
    const r = row || {};
    const rawType = r['Тип НДС'] == null ? '' : String(r['Тип НДС']).trim();
    const rawRate = r['Ставка НДС'] == null ? '' : String(r['Ставка НДС']).replace(',', '.').trim();
    return {
        vatType: rawType || VAT_NONE,
        vatRate: rawRate === '' ? 0 : (parseFloat(rawRate) || 0)
    };
}

// Можно ли считать/печатать документы с таким конфигом?
// Возвращает { ok, code, message }. message — человеческий текст для менеджера.
function validateVatConfig(vatType, vatRate) {
    const type = vatType == null || String(vatType).trim() === '' ? VAT_NONE : String(vatType).trim();
    const rate = parseFloat(vatRate) || 0;

    if (!VAT_TYPES.includes(type)) {
        return {
            ok: false,
            code: VAT_TYPE_UNKNOWN,
            message: `Неизвестный «Тип НДС»: «${type}». Допустимо: «${VAT_NONE}», «${VAT_ON_TOP}», «${VAT_INCLUDED}».`
        };
    }
    // «Без НДС» — ставка не нужна (если заполнена, просто игнорируется).
    if (type !== VAT_NONE && !(rate > 0)) {
        return {
            ok: false,
            code: VAT_RATE_MISSING,
            message: `Тип НДС «${type}», но «Ставка НДС» не заполнена. Документ напечатал бы ставку «0%» и нулевой НДС — это не то же самое, что «Без НДС». Укажите ставку (например 20) или выберите тип «${VAT_NONE}».`
        };
    }
    return { ok: true, code: 'OK', message: '' };
}

// Обёртка «строка Мои реквизиты → конфиг + вердикт» (удобно звать из сервисов).
function checkVatConfig(row) {
    const cfg = parseVatConfig(row);
    const v = validateVatConfig(cfg.vatType, cfg.vatRate);
    return { vatType: cfg.vatType, vatRate: cfg.vatRate, ok: v.ok, code: v.code, message: v.message };
}


// ─── Округление и расчёт строки документа (v4.66.0, «Вариант C») ─────────────
// ЕДИНОЕ правило округления в проекте: half-up до копеек. Раньше в одном документе
// жили два механизма (toFixed(2) в колонках и Math.round(…*100) в сумме прописью) —
// из-за этого на дробных количествах/ценах «сумма колонок» не сходилась с «Итого».
// +1e-9 гасит погрешность двоичного представления денежных значений (у нас не больше
// 4–6 знаков после запятой) и делает округление предсказуемым (половина — вверх).
function round2(value) {
    const n = Number(value);
    if (!isFinite(n)) return 0;
    return Math.round((n + 1e-9) * 100) / 100;
}

// Расчёт ОДНОЙ строки документа. Округляем НА СТРОКЕ, итоги потом просто суммируем —
// тогда точно держатся два равенства, которые и проверяет бухгалтерия:
//   • «Стоимость без НДС» + «Сумма НДС» = «Стоимость с НДС» (в строке);
//   • Σ строк = «Итого» (в документе).
// price — то, что пользователь ввёл в «Цену» (смысл зависит от режима НДС, см. шапку).
// Для «Включен в цену» НДС считается как разность (с НДС − без НДС), а не «база×ставка»:
// иначе строка не сходилась бы на 1 копейку.
// Возвращает { priceNet, priceGross, net, vat, gross } — все значения уже округлены.
function computeLine(price, qty, vatType, vatRate) {
    const p = Number(price) || 0;
    const q = Number(qty) || 0;
    const rate = parseFloat(vatRate) || 0;
    const type = vatType || VAT_NONE;
    const useVat = rate > 0 && type !== VAT_NONE;

    if (useVat && type === VAT_INCLUDED) {
        const priceGross = round2(p);
        const gross = round2(priceGross * q);
        const priceNet = round2(priceGross * 100 / (100 + rate));
        const net = round2(priceNet * q);
        return { priceNet, priceGross, net, vat: round2(gross - net), gross };
    }

    const priceNet = round2(p);
    const net = round2(priceNet * q);
    if (useVat && type === VAT_ON_TOP) {
        const vat = round2(net * rate / 100);
        return { priceNet, priceGross: null, net, vat, gross: round2(net + vat) };
    }
    return { priceNet, priceGross: null, net, vat: 0, gross: net };
}

// Суммы по списку позиций (документ/проект): складываем УЖЕ округлённые строки.
// «Мат. заказчика» в платную часть не входят (как в документах и в боте).
function sumItems(items, vatType, vatRate) {
    let net = 0, vat = 0, gross = 0, count = 0;
    for (const it of items || []) {
        if (!it || isCustomerMaterial(it)) continue;
        const line = computeLine(it['Цена'], it['Кол-во'], vatType, vatRate);
        net += line.net;
        vat += line.vat;
        gross += line.gross;
        count++;
    }
    return { net: round2(net), vat: round2(vat), gross: round2(gross), count };
}

// Расчёт НДС по базовой сумме позиций. Смысл «базы» зависит от типа НДС
// (см. блок «ЧТО ТАКОЕ БАЗА» в шапке файла):
// база — число; vatRate — число (процент, 0/пусто = НДС нет);
// vatType — строка «Мои реквизиты» (по умолчанию «Без НДС»).
// Возвращает { baseTotal, vatRate, vatType, vatAmount, totalWithVat }.
function computeVat(baseTotal, vatRate, vatType) {
    const base = parseFloat(baseTotal) || 0;
    const rate = parseFloat(vatRate) || 0;
    const type = vatType || VAT_NONE;
    let vatAmount = 0;
    let totalWithVat = base;
    if (type === VAT_ON_TOP && rate > 0) {
        vatAmount = base * rate / 100;
        totalWithVat = base + vatAmount;
    } else if (type === VAT_INCLUDED && rate > 0) {
        vatAmount = base * rate / (100 + rate);
        totalWithVat = base; // НДС уже внутри базы
    }
    return { baseTotal: base, vatRate: rate, vatType: type, vatAmount, totalWithVat };
}

module.exports = {
    VAT_NONE,
    VAT_INCLUDED,
    VAT_ON_TOP,
    VAT_TYPES,
    VAT_RATE_MISSING,
    VAT_TYPE_UNKNOWN,
    CUSTOMER_MATERIAL,
    isCustomerMaterial,
    // Маршрут «тип позиции → документ» (v4.64.5)
    normalizeItemType,
    isItemInDocument,
    // Валидация настройки НДС (v4.65.0)
    parseVatConfig,
    validateVatConfig,
    checkVatConfig,
    // Округление и расчёт строки/сумм (v4.66.0, «Вариант C»)
    round2,
    computeLine,
    sumItems,
    computeVat
};
