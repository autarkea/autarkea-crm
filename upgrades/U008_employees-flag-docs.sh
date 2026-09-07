#!/bin/bash
# upgrades/U008_employees-flag-docs.sh
# Флаг «Отправка документов» (Checkbox) в таблице «Сотрудники».
#
# Модель прав «внутри/наружу» (Волна A):
#   - ведение сделки (позиции заказа, черновики) — право роли Менеджер, БЕЗ флага;
#   - «выстрел наружу» (отправить документ email/вручную, статус «Отправлен»,
#     «Закрыт», внесение оплат) — только с этим флагом.
#   Руководитель — всегда (решает код roles.js), Исполнитель — никогда.
#
# Backfill: существующим Менеджерам галочку СТАВИМ — апгрейд не должен отбирать
# возможность, которая была (сейчас Менеджер может слать PDF через веб-форму).
#
# Аддитивно и идемпотентно: add-column.sh пропустит шаг, если колонка есть;
# повторный backfill безвреден (UPDATE идемпотентен).
set -euo pipefail
NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "📦 U008: флаг «Отправка документов» (Checkbox) в «Сотрудники»"
SKIP_RESTART=1 bash modules/add-column.sh \
    "Сотрудники" "Отправка документов" "BOOLEAN" \
    "Может отправлять документы клиентам (email/вручную) и вносить оплаты. Руководитель — всегда." \
    "0" "120px" || exit 1

# Backfill: существующим Менеджерам ставим галочку (сохраняем текущее поведение)
EMP_INFO=$(sqlite3 "$NOCO_DB" "SELECT id, table_name FROM nc_models_v2 WHERE title='Сотрудники' AND base_id=(SELECT id FROM nc_bases_v2 LIMIT 1) LIMIT 1;")
EMP_MODEL_ID=$(echo "$EMP_INFO" | cut -d'|' -f1)
EMP_TABLE=$(echo "$EMP_INFO" | cut -d'|' -f2)
FLAG_COL=$(sqlite3 "$NOCO_DB" "SELECT column_name FROM nc_columns_v2 WHERE fk_model_id='$EMP_MODEL_ID' AND title='Отправка документов' LIMIT 1;")

if [ -n "$EMP_TABLE" ] && [ -n "$FLAG_COL" ]; then
    sqlite3 "$NOCO_DB" "UPDATE \"$EMP_TABLE\" SET \"$FLAG_COL\" = 1 WHERE \"Роль\" = 'Менеджер' AND (\"$FLAG_COL\" IS NULL OR \"$FLAG_COL\" = 0 OR \"$FLAG_COL\" = '0');"
    echo "✅ Менеджерам проставлена галочка «Отправка документов»"
else
    echo "⚠️ Колонка/таблица не найдена — backfill пропущен"
fi

echo "✅ U008 завершена"
