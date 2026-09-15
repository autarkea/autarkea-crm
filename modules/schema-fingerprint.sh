#!/bin/bash
# ============================================================================
# modules/schema-fingerprint.sh v1.0.0 — «слепок» состава схемы (v4.70.0)
# ============================================================================
# Зачем. Версия схемы (`printed4u_schema_version`) — это маркер «до какой дельты
# догнали», а НЕ состав. Дельта, которая на установке ничего не сделала (например,
# идемпотентно пропустила шаг, потому что поле с таким ИМЕНЕМ уже есть, но другого
# СМЫСЛА), всё равно поднимает маркер — и проверки «маркер == максимум дельт»
# показывают зелёное при реально разъехавшейся схеме. Так и случилось с «Контакт/
# ответственный»: на клиенте это был список (om), в эталоне — одиночная связь (mo).
#
# Слепок — это хеш состава ЭТАЛОНА, как он виден в базе:
#   T|<таблица>
#   C|<таблица>|<колонка>|<uidt>
#   L|<таблица>|<колонка>|<mo|om|hm|mm>      (смысл связи, а не только имя!)
#   S|<таблица>|<колонка>|<опция селекта>
# Отсутствующий элемент получает значение MISSING, поэтому хеш совпадает ТОЛЬКО
# когда весь эталонный состав на месте и типы/смысл связей совпадают. Свои колонки
# клиента слепок не учитывает (он про эталон) — дрейф «у клиента больше» не мешает.
#
# ⚠️ ГРАНИЦА (важно, не «дописывать» сюда виды): в слепок НЕ входят ВИДЫ и раскладка
# UI (набор/тип видов, порядок и видимость колонок, фильтры, сортировки). Это
# осознанное «эталон-онли»: вид — рабочее место клиента, он настраивает его сам,
# мы не навязываем и не откатываем. Правило: upgrades/README.md («Что мигрируем
# дельтами, а что живёт только в эталоне»). Если добавить сюда `V|…`, у каждого
# клиента появится вечное расхождение на любой свой вид. Изменения эталона
# относительно git разбирает `modules/schema-drift.sh`: он помечает виды как
# «эталон-онли», а состав (таблицы/колонки/связи/опции) — как «нужна дельта».
#
# Использование:
#   bash modules/schema-fingerprint.sh get                 # слепок из nc_store (живой базы)
#   bash modules/schema-fingerprint.sh compute             # слепок базы NOCO_DB как ЭТАЛОНА
#   bash modules/schema-fingerprint.sh set                 # записать слепок в nc_store (для эталона)
#   bash modules/schema-fingerprint.sh check               # сверить NOCO_DB с TEMPLATE → 0/1 + детали
#   bash modules/schema-fingerprint.sh check --quiet       # без деталей (только итог)
#   NOCO_DB=/path/live.db TEMPLATE=/path/template.db bash modules/schema-fingerprint.sh check
#
# Коды возврата: 0 — состав совпадает (или сверять не с чем), 1 — расхождение.
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
TEMPLATE="${TEMPLATE:-$INSTALL_DIR/template.db}"
KEY="printed4u_schema_fingerprint"

QUIET=false
for arg in "$@"; do
    [ "$arg" = "--quiet" ] && QUIET=true
done

CMD="${1:-}"
[ -f "$NOCO_DB" ] || { echo "❌ База не найдена: $NOCO_DB" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "❌ sqlite3 не установлен" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "❌ sha256sum не установлен" >&2; exit 1; }

# Фильтры эталонного состава — те же, что в schema-compare.sh (иначе «свои» системы
# таблицы NocoDB и junction-начинка начали бы влиять на сверку).
MODEL_FILTER="m.title NOT LIKE 'nc\\_%' ESCAPE '\\' AND m.title!='workspace' AND m.table_name IS NOT NULL AND m.table_name!='' AND COALESCE(m.mm,0)!=1"
COL_FILTER="c.uidt IS NOT NULL AND c.title NOT IN ('Id','CreatedAt','UpdatedAt','nc_created_by','nc_updated_by') AND c.title NOT LIKE 'nc\\_%' ESCAPE '\\'"

snapshot() {
    # $1 — префикс схемы, где лежит ЭТАЛОН (tpl или main). Живая база — всегда main.
    local ref="$1" attach=""
    [ "$ref" = "tpl" ] && attach="ATTACH DATABASE '$TEMPLATE' AS tpl;"
    sqlite3 "$NOCO_DB" <<SQL 2>/dev/null
.timeout 5000
$attach
SELECT 'T|' || t.title || '|' ||
       CASE WHEN EXISTS (SELECT 1 FROM main.nc_models_v2 m WHERE m.title=t.title) THEN 'ok' ELSE 'MISSING' END
  FROM $ref.nc_models_v2 t
 WHERE t.title NOT LIKE 'nc\_%' ESCAPE '\' AND t.title!='workspace'
   AND t.table_name IS NOT NULL AND t.table_name!='' AND COALESCE(t.mm,0)!=1
UNION ALL
SELECT 'C|' || m.title || '|' || c.title || '|' ||
       COALESCE((SELECT c2.uidt FROM main.nc_columns_v2 c2 JOIN main.nc_models_v2 m2 ON m2.id=c2.fk_model_id
                  WHERE m2.title=m.title AND c2.title=c.title LIMIT 1), 'MISSING')
  FROM $ref.nc_columns_v2 c JOIN $ref.nc_models_v2 m ON m.id=c.fk_model_id
 WHERE $MODEL_FILTER AND $COL_FILTER
UNION ALL
SELECT 'L|' || m.title || '|' || c.title || '|' ||
       COALESCE((SELECT MIN(r.type) FROM main.nc_col_relations_v2 r
                  WHERE r.fk_column_id = (SELECT c2.id FROM main.nc_columns_v2 c2 JOIN main.nc_models_v2 m2 ON m2.id=c2.fk_model_id
                                           WHERE m2.title=m.title AND c2.title=c.title LIMIT 1)), 'MISSING')
  FROM $ref.nc_columns_v2 c JOIN $ref.nc_models_v2 m ON m.id=c.fk_model_id
 WHERE $MODEL_FILTER AND c.uidt='LinkToAnotherRecord' AND c.title NOT LIKE 'nc\_%' ESCAPE '\'
UNION ALL
SELECT 'S|' || m.title || '|' || c.title || '|' || o.title || '|' ||
       CASE WHEN EXISTS (SELECT 1 FROM main.nc_col_select_options_v2 o2
                           JOIN main.nc_columns_v2 c2 ON c2.id=o2.fk_column_id
                           JOIN main.nc_models_v2 m2 ON m2.id=c2.fk_model_id
                          WHERE m2.title=m.title AND c2.title=c.title AND o2.title=o.title)
            THEN 'ok' ELSE 'MISSING' END
  FROM $ref.nc_col_select_options_v2 o
  JOIN $ref.nc_columns_v2 c ON c.id=o.fk_column_id
  JOIN $ref.nc_models_v2 m ON m.id=c.fk_model_id
 WHERE $MODEL_FILTER
 ORDER BY 1;
SQL
}

same_file() {
    [ "$(realpath "$1" 2>/dev/null || echo "$1")" = "$(realpath "$2" 2>/dev/null || echo "$2")" ]
}

# Слепок базы $1, сверяемый с эталоном $2 → 16 hex-символов
fingerprint_of() {
    local live_db="$1" ref_db="$2" out
    if same_file "$live_db" "$ref_db"; then
        out=$(NOCO_DB="$live_db" TEMPLATE="$ref_db" snapshot main) || true
    else
        out=$(NOCO_DB="$live_db" TEMPLATE="$ref_db" snapshot tpl) || true
    fi
    printf '%s' "$out" | sha256sum | cut -c1-16
}

# Человекочитаемые расхождения: что именно в базе не как в эталоне
differences() {
    sqlite3 "$NOCO_DB" <<SQL 2>/dev/null || true
.timeout 5000
ATTACH DATABASE '$TEMPLATE' AS tpl;
SELECT '⚠️  [MISSING] таблица: ' || t.title
  FROM tpl.nc_models_v2 t
 WHERE t.title NOT LIKE 'nc\_%' ESCAPE '\' AND t.title!='workspace'
   AND t.table_name IS NOT NULL AND t.table_name!='' AND COALESCE(t.mm,0)!=1
   AND NOT EXISTS (SELECT 1 FROM main.nc_models_v2 m WHERE m.title=t.title);
SELECT '⚠️  [MISSING] колонка: ' || m.title || '.' || c.title || ' (' || c.uidt || ')'
  FROM tpl.nc_columns_v2 c JOIN tpl.nc_models_v2 m ON m.id=c.fk_model_id
 WHERE $MODEL_FILTER AND $COL_FILTER
   AND NOT EXISTS (SELECT 1 FROM main.nc_columns_v2 c2 JOIN main.nc_models_v2 m2 ON m2.id=c2.fk_model_id
                    WHERE m2.title=m.title AND c2.title=c.title);
SELECT '🟠 [ТИП] ' || m.title || '.' || c.title || ': в базе ' ||
       COALESCE((SELECT c2.uidt FROM main.nc_columns_v2 c2 JOIN main.nc_models_v2 m2 ON m2.id=c2.fk_model_id
                  WHERE m2.title=m.title AND c2.title=c.title LIMIT 1),'нет') ||
       ', в эталоне ' || c.uidt
  FROM tpl.nc_columns_v2 c JOIN tpl.nc_models_v2 m ON m.id=c.fk_model_id
 WHERE $MODEL_FILTER AND $COL_FILTER
   AND EXISTS (SELECT 1 FROM main.nc_columns_v2 c2 JOIN main.nc_models_v2 m2 ON m2.id=c2.fk_model_id
                WHERE m2.title=m.title AND c2.title=c.title AND c2.uidt != c.uidt);
SELECT '🔗 [СВЯЗЬ] ' || m.title || '.' || c.title || ': в базе ' ||
       COALESCE((SELECT MIN(r.type) FROM main.nc_col_relations_v2 r
                  WHERE r.fk_column_id=(SELECT c2.id FROM main.nc_columns_v2 c2 JOIN main.nc_models_v2 m2 ON m2.id=c2.fk_model_id
                                         WHERE m2.title=m.title AND c2.title=c.title LIMIT 1)),'нет') ||
       ', в эталоне ' || (SELECT MIN(r.type) FROM tpl.nc_col_relations_v2 r WHERE r.fk_column_id=c.id)
  FROM tpl.nc_columns_v2 c JOIN tpl.nc_models_v2 m ON m.id=c.fk_model_id
 WHERE $MODEL_FILTER AND c.uidt='LinkToAnotherRecord' AND c.title NOT LIKE 'nc\_%' ESCAPE '\'
   AND COALESCE((SELECT MIN(r.type) FROM main.nc_col_relations_v2 r
                  WHERE r.fk_column_id=(SELECT c2.id FROM main.nc_columns_v2 c2 JOIN main.nc_models_v2 m2 ON m2.id=c2.fk_model_id
                                         WHERE m2.title=m.title AND c2.title=c.title LIMIT 1)),'нет')
       != COALESCE((SELECT MIN(r.type) FROM tpl.nc_col_relations_v2 r WHERE r.fk_column_id=c.id),'нет');
SELECT '🎨 [ОПЦИЯ] ' || m.title || '.' || c.title || ' = «' || o.title || '» (не хватает)'
  FROM tpl.nc_col_select_options_v2 o
  JOIN tpl.nc_columns_v2 c ON c.id=o.fk_column_id
  JOIN tpl.nc_models_v2 m ON m.id=c.fk_model_id
 WHERE $MODEL_FILTER
   AND NOT EXISTS (SELECT 1 FROM main.nc_col_select_options_v2 o2
                     JOIN main.nc_columns_v2 c2 ON c2.id=o2.fk_column_id
                     JOIN main.nc_models_v2 m2 ON m2.id=c2.fk_model_id
                    WHERE m2.title=m.title AND c2.title=c.title AND o2.title=o.title);
SQL
}

get_stored() {
    sqlite3 "$NOCO_DB" ".timeout 5000" \
        "SELECT value FROM nc_store WHERE key='$KEY' AND (base_id IS NULL OR base_id='') LIMIT 1;" 2>/dev/null || echo ""
}

set_stored() {
    local fp="$1"
    sqlite3 "$NOCO_DB" ".timeout 5000" \
        "BEGIN; \
         DELETE FROM nc_store WHERE key='$KEY' AND (base_id IS NULL OR base_id=''); \
         INSERT INTO nc_store (type, key, value, db_alias, created_at, updated_at) \
         VALUES ('printed4u', '$KEY', '$fp', 'db', datetime('now'), datetime('now')); \
         COMMIT;"
}


cmd_get() {
    local fp
    fp=$(get_stored)
    if [ -z "$fp" ]; then
        echo "0"
    else
        echo "$fp"
    fi
}

cmd_compute() {
    fingerprint_of "$NOCO_DB" "$NOCO_DB"
    echo ""
}

cmd_set() {
    local fp
    fp=$(fingerprint_of "$NOCO_DB" "$NOCO_DB")
    set_stored "$fp"
    echo "✅ Слепок состава записан в nc_store: $KEY = $fp"
}

cmd_check() {
    if ! [ -f "$TEMPLATE" ]; then
        echo "ℹ️ Эталон не найден ($TEMPLATE) — сверка состава невозможна."
        echo "   Слепок последнего выравнивания (nc_store): $(get_stored | sed 's/^$/нет/')"
        return 0
    fi

    if same_file "$NOCO_DB" "$TEMPLATE"; then
        echo "ℹ️ Проверяемая база и есть эталон ($NOCO_DB) — сверять нечего."
        return 0
    fi

    local live_hash ref_hash
    live_hash=$(fingerprint_of "$NOCO_DB" "$TEMPLATE")
    ref_hash=$(fingerprint_of "$TEMPLATE" "$TEMPLATE")

    if [ "$live_hash" = "$ref_hash" ]; then
        echo "✅ Состав схемы совпадает с эталоном (слепок $live_hash)"
        return 0
    fi

    echo "⚠️  Состав схемы РАСХОДИТСЯ с эталоном: в базе $live_hash, эталон $ref_hash"
    if [ "$QUIET" != true ]; then
        differences | sed 's/^/   /'
        echo "   💡 Догнать: bash upgrade.sh (дельты идемпотентны)."
        echo "      Если пункт не лечится дельтами — правка была только в UI NocoDB:"
        echo "      напиши дельту U<NNN> и прогони export-template.sh (upgrades/README.md)."
    fi
    return 1
}

case "$CMD" in
    get)     cmd_get ;;
    compute) cmd_compute ;;
    set)     cmd_set ;;
    check)   cmd_check || exit 1 ;;
    *)
        echo "Использование: bash modules/schema-fingerprint.sh {get|compute|set|check [--quiet]}" >&2
        echo "  NOCO_DB=/path/live.db TEMPLATE=/path/template.db — указать базы" >&2
        exit 1
        ;;
esac

