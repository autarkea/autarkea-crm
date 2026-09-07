// ============================================================================
// shared/callback-parse.js — разбор callback_data ПОЗИЦИЙ заказа (v4.42.1)
// ============================================================================
// Чистая функция без зависимостей (тесты: tests/callback-parse.test.js).
//
// Зачем: у колбэков pitem_* projectId сидит НА РАЗНЫХ позициях в зависимости
// от подвида («pitem_5_1» — карточка, pid в конце; «pitem_price_5_1» — тоже
// в конце, но между ними два сегмента; «pitem_del_yes_5_1» — ещё длиннее).
// Ручной разбор в трёх местах дал баг: тап по карточке позиции читал пустой
// сегмент → «Сессия устарела». Единый парсер — единственный источник разбора.
//
// Форматы:
//   pitem_save / pitem_cancel            → { kind, itemId:null, projectId:null }
//   pitem_new_{pid}                      → kind='new'
//   pitem_type_{тип}_{pid}               → kind='type', value=тип
//   pitem_unit_{ед}_{pid}                → kind='unit', value=ед
//   pitem_{itemId}_{pid}                 → kind='view' (карточка)
//   pitem_price_{itemId}_{pid}           → kind='price'
//   pitem_qty_{itemId}_{pid}             → kind='qty'
//   pitem_del_{itemId}_{pid}             → kind='del'
//   pitem_del_yes_{itemId}_{pid}         → kind='del_yes'
// ============================================================================

// Возвращает { kind, itemId, projectId, value } или null (битый колбэк).
// projectId у save/cancel — null: проект берётся из черновика сессии (main.js).
function parseItemCallback(data) {
    if (typeof data !== 'string' || !data.startsWith('pitem_')) return null;
    const P = data.split('_');
    const kind = P[1];
    if (!kind) return null;

    if (kind === 'save' || kind === 'cancel') {
        return { kind, itemId: null, projectId: null, value: null };
    }

    // Во всех остальных формах projectId — ПОСЛЕДНИЙ сегмент
    const projectId = parseInt(P[P.length - 1], 10);
    if (!Number.isInteger(projectId)) return null;

    switch (kind) {
        case 'new':
            return { kind, itemId: null, projectId, value: null };
        case 'type':
        case 'unit': {
            const value = P.slice(2, -1).join('_');
            if (!value) return null;
            return { kind, itemId: null, projectId, value };
        }
        case 'del': {
            // pitem_del_yes_{itemId}_{projectId} — подтверждение удаления
            if (P[2] === 'yes') {
                const itemId = parseInt(P[3], 10);
                if (!Number.isInteger(itemId)) return null;
                return { kind: 'del_yes', itemId, projectId, value: null };
            }
            const itemId = parseInt(P[2], 10);
            if (!Number.isInteger(itemId)) return null;
            return { kind: 'del', itemId, projectId, value: null };
        }
        case 'price':
        case 'qty': {
            const itemId = parseInt(P[2], 10);
            if (!Number.isInteger(itemId)) return null;
            return { kind, itemId, projectId, value: null };
        }
        default: {
            // карточка позиции: pitem_{itemId}_{projectId} — ровно 3 сегмента
            if (P.length !== 3) return null;
            const itemId = parseInt(kind, 10);
            if (!Number.isInteger(itemId)) return null;
            return { kind: 'view', itemId, projectId, value: null };
        }
    }
}

module.exports = { parseItemCallback };
