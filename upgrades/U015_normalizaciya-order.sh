#!/bin/bash
# upgrades/U015_normalizaciya-order.sh
# v4.69.0: уникальный `order` в схеме (модели / колонки / виды / колонки видов).
#
# Зачем. Дубли `order` — класс «Проблемы 69»: при одинаковых позициях NocoDB UI
# сортирует список непредсказуемо, а колонки нельзя перетаскивать, скрывать и
# удалять. Экспортёр шаблона нормализует `order` только у колонок видов
# (подшаг 8.9) — на ЖИВОЙ базе клиента дубли так и живут. Эта дельта переносит
# ту же нормализацию в установки:
#   * `nc_models_v2."order"`              — 1..N (пересчёт целиком: у моделей
#     позиции глобальные, локально «дырку» не закрыть);
#   * `nc_columns_v2."order"`             — 1..N внутри «сломанных» моделей,
#     строки с NULL (служебные junction-колонки) остаются NULL;
#   * `nc_views_v2."order"`               — 1..N внутри «сломанных» моделей;
#   * 9 таблиц колонок видов              — 1..N внутри «сломанных» видов.
#
# Принципы:
#   * относительный порядок СОХРАНЯЕТСЯ (ROW_NUMBER по «order», затем id);
#   * трогаются только «сломанные» разделы (модель/вид с дублями): если дублей
#     нет — значения не сдвигаются, чужие числа не «причёсываются»;
#   * идемпотентно: повторный запуск находит 0 дублей и ничего не меняет.
#
# Версию схемы дельта не пишет — это делает движок `upgrade.sh` (upgrades/README.md).
set -euo pipefail

NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_FILE="/mnt/data/nocodb-data/upgrade.log"

# Таблицы колонок видов — как в export-template.sh (подшаг 8.9)
VIEW_COL_TABLES=(
    nc_grid_view_columns_v2 nc_gallery_view_columns_v2 nc_kanban_view_columns_v2
    nc_form_view_columns_v2 nc_calendar_view_columns_v2 nc_map_view_columns_v2
    nc_timeline_view_columns_v2 nc_gantt_view_columns_v2 nc_list_view_columns_v2
)

cd "$INSTALL_DIR"

echo "📦 U015: порядок в схеме — убираю дубли order (модели / колонки / виды)"

[ -f "$NOCO_DB" ] || { echo "❌ База не найдена: $NOCO_DB" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "❌ sqlite3 не установлен" >&2; exit 1; }

q() { sqlite3 "$NOCO_DB" ".timeout 5000" "$1" 2>/dev/null || true; }

log() {
    echo "$@"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE" 2>/dev/null || true
}

table_exists() {
    [ "$(q "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$1';")" = "1" ]
}

# Счётчики дублей (пустая строка от q() → 0)
model_dupes() { local v; v=$(q "SELECT COUNT(*) FROM (SELECT \"order\" FROM nc_models_v2 GROUP BY \"order\" HAVING COUNT(*) > 1);"); echo "${v:-0}"; }
col_dupes()   { local v; v=$(q "SELECT COUNT(*) FROM (SELECT fk_model_id, \"order\" FROM nc_columns_v2 WHERE \"order\" IS NOT NULL GROUP BY fk_model_id, \"order\" HAVING COUNT(*) > 1);"); echo "${v:-0}"; }
view_dupes()  { local v; v=$(q "SELECT COUNT(*) FROM (SELECT fk_model_id, \"order\" FROM nc_views_v2 WHERE \"order\" IS NOT NULL GROUP BY fk_model_id, \"order\" HAVING COUNT(*) > 1);"); echo "${v:-0}"; }
vcol_dupes()  { local v; v=$(q "SELECT COUNT(*) FROM (SELECT fk_view_id, \"order\" FROM \"$1\" WHERE \"order\" IS NOT NULL GROUP BY fk_view_id, \"order\" HAVING COUNT(*) > 1);"); echo "${v:-0}"; }

run_sql() {
    sqlite3 "$NOCO_DB" <<EOF
.timeout 5000
.bail on
$1
EOF
}

# ── Счётчики «до» ───────────────────────────────────────────────────────────
BEFORE_MODEL=$(model_dupes)
BEFORE_COL=$(col_dupes)
BEFORE_VIEW=$(view_dupes)
BEFORE_VCOL=0
for T in "${VIEW_COL_TABLES[@]}"; do
    table_exists "$T" || continue
    BEFORE_VCOL=$((BEFORE_VCOL + $(vcol_dupes "$T")))
done

log "   🔎 Дубли order до дельты: модели=$BEFORE_MODEL, колонки=$BEFORE_COL, виды=$BEFORE_VIEW, колонки видов=$BEFORE_VCOL"

if [ "$((BEFORE_MODEL + BEFORE_COL + BEFORE_VIEW + BEFORE_VCOL))" -eq 0 ]; then
    log "✅ Дублей order нет — пропуск"
    exit 0
fi

# ── 1. Модели: позиции глобальные → пересчёт 1..N целиком ───────────────────
if [ "$BEFORE_MODEL" -gt 0 ]; then
    log "   📐 Модели: пересчитываю order 1..N (групп с дублями: $BEFORE_MODEL)"
    # ⚠️ Позиции считаем в TEMP-таблице ДО UPDATE (как export-template.sh, 8.9):
    # коррелированный подзапрос по той же таблице SQLite пересчитывает по ходу
    # правки — на выходе получались новые дубли (проверено на копии эталона).
    run_sql "BEGIN TRANSACTION;
DROP TABLE IF EXISTS temp.p4u_norm;
CREATE TEMP TABLE p4u_norm AS
SELECT id, ROW_NUMBER() OVER (ORDER BY \"order\", id) AS rn FROM nc_models_v2;
UPDATE nc_models_v2
   SET \"order\" = (SELECT rn FROM temp.p4u_norm WHERE temp.p4u_norm.id = nc_models_v2.id);
DROP TABLE temp.p4u_norm;
COMMIT;"
fi

# ── 2. Колонки: только «сломанные» модели, только non-NULL ──────────────────
# Служебные junction-колонки имеют order = NULL — их не трогаем (иначе они
# получат числа и попадут в счётчики ОТК).
if [ "$BEFORE_COL" -gt 0 ]; then
    log "   📐 Колонки: нормализую order в моделях с дублями (групп: $BEFORE_COL)"
    run_sql "BEGIN TRANSACTION;
DROP TABLE IF EXISTS temp.p4u_norm;
CREATE TEMP TABLE p4u_norm AS
SELECT id, ROW_NUMBER() OVER (PARTITION BY fk_model_id ORDER BY \"order\", id) AS rn
FROM nc_columns_v2 WHERE \"order\" IS NOT NULL;
UPDATE nc_columns_v2
   SET \"order\" = (SELECT rn FROM temp.p4u_norm WHERE temp.p4u_norm.id = nc_columns_v2.id)
 WHERE \"order\" IS NOT NULL
   AND fk_model_id IN (
       SELECT fk_model_id FROM nc_columns_v2 WHERE \"order\" IS NOT NULL
       GROUP BY fk_model_id, \"order\" HAVING COUNT(*) > 1
   );
DROP TABLE temp.p4u_norm;
COMMIT;"
fi

# ── 3. Виды: только «сломанные» модели ──────────────────────────────────────
if [ "$BEFORE_VIEW" -gt 0 ]; then
    log "   📐 Виды: нормализую order в моделях с дублями (групп: $BEFORE_VIEW)"
    run_sql "BEGIN TRANSACTION;
DROP TABLE IF EXISTS temp.p4u_norm;
CREATE TEMP TABLE p4u_norm AS
SELECT id, ROW_NUMBER() OVER (PARTITION BY fk_model_id ORDER BY \"order\", id) AS rn
FROM nc_views_v2 WHERE \"order\" IS NOT NULL;
UPDATE nc_views_v2
   SET \"order\" = (SELECT rn FROM temp.p4u_norm WHERE temp.p4u_norm.id = nc_views_v2.id)
 WHERE \"order\" IS NOT NULL
   AND fk_model_id IN (
       SELECT fk_model_id FROM nc_views_v2 WHERE \"order\" IS NOT NULL
       GROUP BY fk_model_id, \"order\" HAVING COUNT(*) > 1
   );
DROP TABLE temp.p4u_norm;
COMMIT;"
fi

# ── 4. Колонки видов: только «сломанные» виды (как export-template.sh, 8.9) ─
for T in "${VIEW_COL_TABLES[@]}"; do
    table_exists "$T" || continue
    D=$(vcol_dupes "$T")
    [ "$D" -gt 0 ] || continue
    log "   📐 $T: нормализую order в видах с дублями (групп: $D)"
    run_sql "BEGIN TRANSACTION;
DROP TABLE IF EXISTS temp.p4u_norm;
CREATE TEMP TABLE p4u_norm AS
SELECT id, ROW_NUMBER() OVER (PARTITION BY fk_view_id ORDER BY \"order\", id) AS rn
FROM \"$T\";
UPDATE \"$T\"
   SET \"order\" = (SELECT rn FROM temp.p4u_norm WHERE temp.p4u_norm.id = \"$T\".id)
 WHERE fk_view_id IN (
     SELECT fk_view_id FROM \"$T\" WHERE \"order\" IS NOT NULL
     GROUP BY fk_view_id, \"order\" HAVING COUNT(*) > 1
 );
DROP TABLE temp.p4u_norm;
COMMIT;"
done

# ── Проверка ────────────────────────────────────────────────────────────────
AFTER_MODEL=$(model_dupes)
AFTER_COL=$(col_dupes)
AFTER_VIEW=$(view_dupes)
AFTER_VCOL=0
for T in "${VIEW_COL_TABLES[@]}"; do
    table_exists "$T" || continue
    AFTER_VCOL=$((AFTER_VCOL + $(vcol_dupes "$T")))
done

if [ "$AFTER_MODEL" != "0" ] || [ "$AFTER_COL" != "0" ] || [ "$AFTER_VIEW" != "0" ] || [ "$AFTER_VCOL" != "0" ]; then
    echo "❌ Дубли order остались: модели=$AFTER_MODEL, колонки=$AFTER_COL, виды=$AFTER_VIEW, колонки видов=$AFTER_VCOL" >&2
    exit 1
fi

log "   ✅ Дублей order не осталось (модели $BEFORE_MODEL→0, колонки $BEFORE_COL→0, виды $BEFORE_VIEW→0, колонки видов $BEFORE_VCOL→0)"
log "   🔄 NocoDB держит метаданные в памяти — нужен рестарт (upgrade.sh делает это сам)"
echo "✅ U015 завершена"
