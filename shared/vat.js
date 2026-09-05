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

// Расчёт НДС по базовой сумме позиций (база БЕЗ НДС).
// baseTotal — число; vatRate — число (процент, 0/пусто = НДС нет);
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
    CUSTOMER_MATERIAL,
    isCustomerMaterial,
    computeVat
};
