#!/bin/bash
# upgrades/U010_tip-izdelie.sh
# v4.48.0: переименование типа позиции «Товар+Работа» → «Изделие».
#
# Зачем: семантика документов v4.48.0. «Товар+Работа» вводила в заблуждение
# (читалась как «и товар, и работа» и попадала в АКТ). Новый маршрут позиций:
#   Работа    → счёт + акт
#   Товар     → счёт + накладная
#   Изделие   → счёт + накладная (в АКТ не попадает)
# Плюс меняем дефолт колонки «Тип» (был «Товар+Работа» → «Работа»), чтобы новые
# позиции, заведённые в NocoDB UI без явного выбора типа, не «утекали» молча.
#
# Идемпотентно: если опции «Товар+Работа» уже нет — переименование пропускается;
# дефолт правится только если равен «Товар+Работа».
set -euo pipefail
NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "📦 U010: тип позиции «Товар+Работа» → «Изделие» (семантика документов v4.48.0)"

# ── 1. Переименование опции (модуль обновляет и данные в строках) ─────────────
OPT_COUNT=$(sqlite3 "$NOCO_DB" "
SELECT COUNT(*)
FROM nc_col_select_options_v2 o
JOIN nc_columns_v2 c ON c.id = o.fk_column_id
JOIN nc_models_v2 m ON m.id = c.fk_model_id
WHERE m.title = 'Позиции заказа' AND c.title = 'Тип' AND o.title = 'Товар+Работа';")

if [ "$OPT_COUNT" -gt 0 ]; then
    echo "   ✏️  Переименовываю опцию «Товар+Работа» → «Изделие»..."
    SKIP_RESTART=1 bash modules/edit-select-options.sh \
        "Позиции заказа" "Тип" "Товар+Работа" "Изделие" || exit 1
else
    echo "   ✅ Опция «Товар+Работа» уже переименована или отсутствует — пропуск"
fi

# ── 2. Дефолт колонки «Тип»: «Товар+Работа» → «Работа» ────────────────────────
MODEL_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_models_v2 WHERE title='Позиции заказа' AND base_id=(SELECT id FROM nc_bases_v2 LIMIT 1) LIMIT 1;")
if [ -n "$MODEL_ID" ]; then
    COL_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$MODEL_ID' AND title='Тип' LIMIT 1;")
    if [ -n "$COL_ID" ]; then
        CUR_CDF=$(sqlite3 "$NOCO_DB" "SELECT COALESCE(cdf,'') FROM nc_columns_v2 WHERE id='$COL_ID';")
        if [ "$CUR_CDF" = "Товар+Работа" ]; then
            sqlite3 "$NOCO_DB" "UPDATE nc_columns_v2 SET cdf='Работа' WHERE id='$COL_ID' AND cdf='Товар+Работа';"
            echo "   ✅ Дефолт «Тип»: «Товар+Работа» → «Работа»"
        else
            echo "   ℹ️  Дефолт «Тип» уже не «Товар+Работа» (сейчас: '$CUR_CDF') — пропуск"
        fi
    else
        echo "   ⚠️ Колонка «Тип» не найдена — шаг пропущен"
    fi
else
    echo "   ⚠️ Таблица «Позиции заказа» не найдена — шаг пропущен"
fi

echo "✅ U010 завершена"
