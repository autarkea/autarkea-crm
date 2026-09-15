#!/bin/bash
# upgrades/U017_kontakt-otvetstvennyy.sh
# v4.70.0: «Контакт/ответственный» стал ОДИНОЧНОЙ связью (mo) + «Контакты Юрлица».
#
# Зачем. На живой базе (июль–август 2026) связь «Юрлица.Контакт/ответственный» была
# создана В ИНТЕРФЕЙСЕ NocoDB как список (relation `om`, обратная «Контакты.Юрлица (я
# ответственный)»). Позже её сделали одиночной (relation `mo`), а старую связь-список
# переименовали в «Контакты Юрлица». Обе правки — только в UI: `template.db` их
# содержит, а на установки клиентов они не доехали. Итог на клиенте: поле с ТЕМ ЖЕ
# именем «Контакт/ответственный», но другого СМЫСЛА (список вместо одного), плюс
# отсутствуют «Контакты Юрлица» и «Контакты.Юрлица (я ответственный)».
#
# Почему это нельзя было «добавить колонкой»: имя занято, а `add-column.sh` /
# `add-link-m2o.sh` идемпотентны ПО ИМЕНИ — на клиенте они видят «Контакт/ответственный»,
# считают шаг выполненным и молча пропускают. Такой дрейф не видно ни по версии
# схемы, ни по именам полей (поэтому и появилась `modules/schema-fingerprint.sh`).
#
# Что делает дельта (стройно, в этом порядке):
#   1. «Контакт/ответственный» уже `mo` → шаги 2–3 пропускаются (идемпотентность);
#      связи нет вовсе → создаём сразу `mo`, переносить нечего;
#   2. «om/список» → ПЕРЕИМЕНОВЫВАЕМ в «Контакты Юрлица» (id колонки и вся
#      junction-начинка сохраняются → данные «списка» никуда не деваются);
#   3. создаём новую связь `mo` «Юрлица.Контакт/ответственный» ↔
#      «Контакты.Юрлица (я ответственный)» через `modules/add-link-m2o.sh`;
#   4. ПЕРЕНОС: из старого списка в нового одиночного — по ОДНОМУ контакту на
#      юрлицо (первый по `nc_order`). Идемпотентно: юрлица, у которых ответственный
#      уже назначен, повторно не вставляются; повторный запуск = «перенесено 0».
#      Контакт, уже назначенный ответственным за другого юрлица, второй раз не
#      ставится (иначе один человек = ответственный у двоих).
#
# Чего дельта НЕ делает: не удаляет колонки, не чистит старые связи, не переименовывает
# ничего сверх описанного. Данные старого списка остаются доступны в «Контакты Юрлица».
#
# Версию схемы дельта не пишет — это делает движок `upgrade.sh` (upgrades/README.md).
set -euo pipefail

NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_FILE="/mnt/data/nocodb-data/upgrade.log"

cd "$INSTALL_DIR"

LINK_TITLE="Контакт/ответственный"       # одиночная связь (эталон)
LIST_TITLE="Контакты Юрлица"             # бывший список (эталон)
REVERSE_TITLE="Юрлица (я ответственный)" # обратная колонка в «Контакты»

echo "📦 U017: «$LINK_TITLE» → одиночная связь (mo) + «$LIST_TITLE» (догон UI-правки)"

[ -f "$NOCO_DB" ] || { echo "❌ База не найдена: $NOCO_DB" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "❌ sqlite3 не установлен" >&2; exit 1; }

log() {
    echo "$@"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] U017: $*" >> "$LOG_FILE" 2>/dev/null || true
}

q() { sqlite3 "$NOCO_DB" ".timeout 5000" "$1" 2>/dev/null || true; }
esc() { echo "${1//\'/\'\'}"; }

run_sql() {
    sqlite3 "$NOCO_DB" <<EOF
.timeout 5000
.bail on
$1
EOF
}

# ── 0. Таблицы и их первичные ключи ─────────────────────────────────────────
LEGAL_MODEL=$(q "SELECT id FROM nc_models_v2 WHERE title='Юрлица' AND mm!=1 LIMIT 1;")
CONTACT_MODEL=$(q "SELECT id FROM nc_models_v2 WHERE title='Контакты' AND mm!=1 LIMIT 1;")
[ -n "$LEGAL_MODEL" ] && [ -n "$CONTACT_MODEL" ] || {
    echo "❌ Таблицы «Юрлица» / «Контакты» не найдены в $NOCO_DB — дельта не применима" >&2
    exit 1
}
LEGAL_PK=$(q "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$LEGAL_MODEL' AND title='Id' AND uidt='ID' AND ai=1 LIMIT 1;")
CONTACT_PK=$(q "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$CONTACT_MODEL' AND title='Id' AND uidt='ID' AND ai=1 LIMIT 1;")
[ -n "$LEGAL_PK" ] && [ -n "$CONTACT_PK" ] || {
    echo "❌ Не найдены первичные ключи «Юрлица»/«Контакты»" >&2
    exit 1
}

# id колонки по имени в таблице
col_id() { q "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$1' AND title='$(esc "$2")' LIMIT 1;"; }
# junction-модель (m2m) колонки
mm_of_col() { q "SELECT fk_mm_model_id FROM nc_col_relations_v2 WHERE fk_column_id='$1' AND fk_mm_model_id IS NOT NULL LIMIT 1;"; }
# физическая таблица модели
table_of_model() { q "SELECT table_name FROM nc_models_v2 WHERE id='$1' LIMIT 1;"; }
# тип relation колонки (mo/om/hm/mm)
rel_type_of_col() { q "SELECT type FROM nc_col_relations_v2 WHERE fk_column_id='$1' LIMIT 1;"; }

# ── 1. Текущее состояние «Контакт/ответственный» ───────────────────────────
LINK_ID=$(col_id "$LEGAL_MODEL" "$LINK_TITLE")
REL_TYPE=""
if [ -n "$LINK_ID" ]; then
    REL_TYPE=$(rel_type_of_col "$LINK_ID")
    log "   ℹ️  «$LINK_TITLE» уже есть: id=$LINK_ID, тип связи=${REL_TYPE:-нет relation}"
fi

# 1a. Колонки нет вовсе — создаём правильную (переносить нечего)
if [ -z "$LINK_ID" ]; then
    log "   ➕ Связи нет — создаю одиночную (mo): «Юрлица.$LINK_TITLE» ↔ «Контакты.$REVERSE_TITLE»"
    SKIP_RESTART=1 NOCO_DB="$NOCO_DB" bash modules/add-link-m2o.sh \
        "Юрлица" "$LINK_TITLE" "Контакты" "$REVERSE_TITLE" || {
        echo "❌ Не удалось создать связь «$LINK_TITLE»" >&2
        exit 1
    }
    LINK_ID=$(col_id "$LEGAL_MODEL" "$LINK_TITLE")
    REL_TYPE=$(rel_type_of_col "$LINK_ID")
    [ "$REL_TYPE" = "mo" ] || { echo "❌ Связь создана, но relation ≠ mo (${REL_TYPE:-пусто})" >&2; exit 1; }
    log "   ✅ Создана одиночная связь (mo). Переносить нечего — старого списка нет."
    echo "   🔄 NocoDB держит метаданные в памяти — нужен рестарт (upgrade.sh делает это сам)"
    echo "✅ U017 завершена"
    exit 0
fi

# 1b. Колонка есть, а связи (junction) нет — состояние нештатное, без «починки на глаз»
if [ -z "$REL_TYPE" ]; then
    log "   ⚠️  У «$LINK_TITLE» нет relation — состояние нештатное, дельта не трогает."
    log "       Разбери вручную (NocoDB UI), затем запусти upgrade.sh повторно."
    echo "✅ U017 завершена (без изменений)"
    exit 0
fi

# ── 2. Список (не mo) → переименовываем в «Контакты Юрлица» ────────────────
if [ "$REL_TYPE" != "mo" ]; then
    CONFLICT=$(col_id "$LEGAL_MODEL" "$LIST_TITLE")
    if [ -n "$CONFLICT" ]; then
        log "   ⚠️  Уже есть колонка «$LIST_TITLE» (id=$CONFLICT), а «$LINK_TITLE» — это $REL_TYPE."
        log "       Переименование создало бы дубль имени → ничего не меняю. Разбери вручную (NocoDB UI)."
        echo "✅ U017 завершена (без изменений)"
        exit 0
    fi

    log "   🔤 Переименовываю старую связь-$REL_TYPE «$LINK_TITLE» → «$LIST_TITLE» (id сохраняется)"
    run_sql "BEGIN TRANSACTION;
UPDATE nc_columns_v2
   SET title='$LIST_TITLE',
       meta=CASE WHEN json_valid(meta) THEN json_set(meta,'\$.plural','Контакты','\$.singular','Контакты')
                 ELSE meta END,
       updated_at=CURRENT_TIMESTAMP
 WHERE id='$LINK_ID';
COMMIT;"

    RENAMED=$(q "SELECT COUNT(*) FROM nc_columns_v2 WHERE id='$LINK_ID' AND title='$LIST_TITLE';")
    [ "${RENAMED:-0}" -eq 1 ] || { echo "❌ Переименование не удалось" >&2; exit 1; }

    log "   ➕ Создаю одиночную связь (mo): «Юрлица.$LINK_TITLE» ↔ «Контакты.$REVERSE_TITLE»"
    SKIP_RESTART=1 NOCO_DB="$NOCO_DB" bash modules/add-link-m2o.sh \
        "Юрлица" "$LINK_TITLE" "Контакты" "$REVERSE_TITLE" || {
        echo "❌ Не удалось создать связь «$LINK_TITLE» (старый список уже переименован в «$LIST_TITLE»)" >&2
        exit 1
    }
    LINK_ID=$(col_id "$LEGAL_MODEL" "$LINK_TITLE")
    REL_TYPE=$(rel_type_of_col "$LINK_ID")
    [ "$REL_TYPE" = "mo" ] || { echo "❌ Новая связь «$LINK_TITLE» имеет relation «${REL_TYPE:-пусто}», ожидался mo" >&2; exit 1; }
    log "   ✅ Схема приведена к эталону: «$LIST_TITLE» (список) + «$LINK_TITLE» (mo)"
else
    log "   ⏭️  «$LINK_TITLE» уже одиночная (mo) — схему не меняю (эталон совпадает)"
fi

# ── 3. ПЕРЕНОС: из списка — по одному контакту на юрлицо ───────────────────
LIST_ID=$(col_id "$LEGAL_MODEL" "$LIST_TITLE")
if [ -z "$LIST_ID" ]; then
    log "   ℹ️  «$LIST_TITLE» отсутствует — переносить нечего"
    echo "✅ U017 завершена"
    exit 0
fi

OLD_MM=$(mm_of_col "$LIST_ID")
NEW_MM=$(mm_of_col "$LINK_ID")
[ -n "$OLD_MM" ] && [ -n "$NEW_MM" ] || {
    log "   ⚠️  Не найдены junction-модели связей (старая: ${OLD_MM:-нет}, новая: ${NEW_MM:-нет}) — перенос пропущен"
    echo "✅ U017 завершена"
    exit 0
}
[ "$OLD_MM" != "$NEW_MM" ] || { log "   ℹ️  Старая и новая связь делят junction — перенос не нужен"; echo "✅ U017 завершена"; exit 0; }

OLD_TABLE=$(table_of_model "$OLD_MM")
NEW_TABLE=$(table_of_model "$NEW_MM")
[ -n "$OLD_TABLE" ] && [ -n "$NEW_TABLE" ] || {
    log "   ⚠️  Не найдены физические таблицы junction — перенос пропущен"
    echo "✅ U017 завершена"
    exit 0
}

# Колонки-FK внутри junction. Надёжно — через hm-relation junction-колонки
# (fk_parent_column_id = PK целевой таблицы), с запасным вариантом «по имени».
fk_of_junction() {
    local mm="$1" pk="$2" like="$3" by_rel
    by_rel=$(q "SELECT r.fk_child_column_id FROM nc_col_relations_v2 r WHERE r.fk_related_model_id='$mm' AND r.fk_parent_column_id='$pk' LIMIT 1;")
    if [ -n "$by_rel" ]; then echo "$by_rel"; return; fi
    q "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$mm' AND uidt='ForeignKey' AND title LIKE '%$like%' LIMIT 1;"
}

OLD_LEGAL_FK=$(fk_of_junction "$OLD_MM" "$LEGAL_PK" "Юрлица")
OLD_CONTACT_FK=$(fk_of_junction "$OLD_MM" "$CONTACT_PK" "Контакты")
NEW_LEGAL_FK=$(fk_of_junction "$NEW_MM" "$LEGAL_PK" "Юрлица")
NEW_CONTACT_FK=$(fk_of_junction "$NEW_MM" "$CONTACT_PK" "Контакты")

if [ -z "$OLD_LEGAL_FK" ] || [ -z "$OLD_CONTACT_FK" ] || [ -z "$NEW_LEGAL_FK" ] || [ -z "$NEW_CONTACT_FK" ]; then
    log "   ⚠️  Не удалось определить FK-колонки junction (старая: «$OLD_LEGAL_FK»/«$OLD_CONTACT_FK», новая: «$NEW_LEGAL_FK»/«$NEW_CONTACT_FK») — перенос пропущен"
    echo "✅ U017 завершена"
    exit 0
fi

OLD_LEGAL_NAME=$(q "SELECT column_name FROM nc_columns_v2 WHERE id='$OLD_LEGAL_FK' LIMIT 1;")
OLD_CONTACT_NAME=$(q "SELECT column_name FROM nc_columns_v2 WHERE id='$OLD_CONTACT_FK' LIMIT 1;")
NEW_LEGAL_NAME=$(q "SELECT column_name FROM nc_columns_v2 WHERE id='$NEW_LEGAL_FK' LIMIT 1;")
NEW_CONTACT_NAME=$(q "SELECT column_name FROM nc_columns_v2 WHERE id='$NEW_CONTACT_FK' LIMIT 1;")

if [ -z "$OLD_LEGAL_NAME" ] || [ -z "$OLD_CONTACT_NAME" ] || [ -z "$NEW_LEGAL_NAME" ] || [ -z "$NEW_CONTACT_NAME" ]; then
    log "   ⚠️  У junction-колонок пустые column_name — перенос пропущен"
    echo "✅ U017 завершена"
    exit 0
fi

OLD_ROWS=$(q "SELECT COUNT(*) FROM \"$OLD_TABLE\";")
NEW_ROWS=$(q "SELECT COUNT(*) FROM \"$NEW_TABLE\";")

# «Первый по порядку»: nc_order есть у junction, созданных NocoDB в UI; если
# колонки нет — порядок задаёт сам contact-id (детерминированно).
HAS_ORDER=$(q "SELECT COUNT(*) FROM pragma_table_info('$OLD_TABLE') WHERE name='nc_order';")
if [ "${HAS_ORDER:-0}" -gt 0 ]; then
    ORDER_EXPR="COALESCE(o.\"nc_order\", 0), o.\"$OLD_CONTACT_NAME\""
else
    ORDER_EXPR="o.\"$OLD_CONTACT_NAME\""
fi

log "   🔁 Перенос «$LIST_TITLE» → «$LINK_TITLE»: строк в списке $OLD_ROWS, уже назначено $NEW_ROWS"
run_sql "BEGIN TRANSACTION;
DROP TABLE IF EXISTS temp.p4u_u017_map;
CREATE TEMP TABLE p4u_u017_map AS
SELECT legal_fk, MIN(contact_fk) AS contact_fk FROM (
    SELECT o.\"$OLD_LEGAL_NAME\" AS legal_fk,
           o.\"$OLD_CONTACT_NAME\" AS contact_fk,
           ROW_NUMBER() OVER (PARTITION BY o.\"$OLD_LEGAL_NAME\" ORDER BY $ORDER_EXPR) AS rn
      FROM \"$OLD_TABLE\" o
     WHERE o.\"$OLD_LEGAL_NAME\" IS NOT NULL AND o.\"$OLD_CONTACT_NAME\" IS NOT NULL
) WHERE rn = 1
  AND legal_fk NOT IN (SELECT \"$NEW_LEGAL_NAME\" FROM \"$NEW_TABLE\")
  AND contact_fk NOT IN (SELECT \"$NEW_CONTACT_NAME\" FROM \"$NEW_TABLE\")
GROUP BY legal_fk;
INSERT INTO \"$NEW_TABLE\" (\"$NEW_CONTACT_NAME\", \"$NEW_LEGAL_NAME\")
SELECT contact_fk, legal_fk FROM p4u_u017_map;
DROP TABLE temp.p4u_u017_map;
COMMIT;"

NEW_ROWS_AFTER=$(q "SELECT COUNT(*) FROM \"$NEW_TABLE\";")
MOVED=$(( ${NEW_ROWS_AFTER:-0} - ${NEW_ROWS:-0} ))
LEGAL_IN_LIST=$(q "SELECT COUNT(DISTINCT \"$OLD_LEGAL_NAME\") FROM \"$OLD_TABLE\" WHERE \"$OLD_LEGAL_NAME\" IS NOT NULL;")
log "   ✅ Перенесено: $MOVED (юрлиц со списком: $LEGAL_IN_LIST, теперь с ответственным: ${NEW_ROWS_AFTER:-0})"

# ── 4. Контроль ────────────────────────────────────────────────────────────
FINAL_TYPE=$(rel_type_of_col "$LINK_ID")
[ "$FINAL_TYPE" = "mo" ] || { echo "❌ «$LINK_TITLE» имеет relation «$FINAL_TYPE», ожидался mo" >&2; exit 1; }
[ "$(col_id "$LEGAL_MODEL" "$LIST_TITLE")" = "$LIST_ID" ] || { echo "❌ «$LIST_TITLE» потеряна" >&2; exit 1; }
REVERSE_ID=$(col_id "$CONTACT_MODEL" "$REVERSE_TITLE")
[ -n "$REVERSE_ID" ] || { echo "❌ Обратная колонка «Контакты.$REVERSE_TITLE» не создана" >&2; exit 1; }
AFTER_OLD_ROWS=$(q "SELECT COUNT(*) FROM \"$OLD_TABLE\";")
[ "${AFTER_OLD_ROWS:-0}" -ge "${OLD_ROWS:-0}" ] || { echo "❌ Данные старого списка потеряны ($OLD_ROWS → ${AFTER_OLD_ROWS:-0})" >&2; exit 1; }

if [ "${LEGAL_IN_LIST:-0}" -gt "${NEW_ROWS_AFTER:-0}" ]; then
    log "   ⚠️  Часть юрлиц осталась без ответственного (в списке $LEGAL_IN_LIST, назначено ${NEW_ROWS_AFTER}):"
    log "       контакт мог быть уже ответственным за другое юрлицо, либо в списке только пустые значения."
    log "       Проставь вручную в карточке юрлица (поле «$LINK_TITLE»)."
fi
log "   ✅ Схема и данные приведены к эталону (контакты никуда не делись: список — в «$LIST_TITLE»)"
echo "   🔄 NocoDB держит метаданные в памяти — нужен рестарт (upgrade.sh делает это сам)"
echo "✅ U017 завершена"
