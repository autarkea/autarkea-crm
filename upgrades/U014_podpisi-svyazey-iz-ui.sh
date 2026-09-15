#!/bin/bash
# upgrades/U014_podpisi-svyazey-iz-ui.sh
# v4.69.0: подписи связей, созданных В ИНТЕРФЕЙСЕ NocoDB — правило U012 для новых связей.
#
# Зачем. U012 вычистила `plural` = «<таблица>s» у связей, которые создавал наш
# `modules/add-link-m2o.sh` (причина устранена в v1.1.0). Но у UI NocoDB своя
# автоподстановка: создавая связь руками, он пишет `plural` = `singular` + «s».
# Так на живой базе (июль 2026) появились две видимые связи с подписями-опечатками:
#   «Юрлица.Контакт/ответственный»      → «Контактыs»
#   «Контакты.Юрлица (я ответственный)» → «Юрлицаs»
# Правило U012 к ним применимо, но сама U012 уже применена (версия схемы 13) и
# повторно движком не запускается — эта дельта несёт то же правило НОВЫМ связям.
#
# Что меняется: ТОЛЬКО `meta.plural` у ВИДИМЫХ связей, где
# `plural` = `singular` + «s» → `plural := singular` (ровно как у «Контакты Юрлица»,
# где обе подписи — «Контакты»). Внутренние M2M-колонки (`nc_...`) не трогаются:
# их подписи NocoDB перезаписывает сам при правке схемы в UI.
# `title`, данные, связи, порядок/видимость колонок НЕ меняются.
#
# Идемпотентно: повторный запуск находит 0 кандидатов и ничего не делает.
# Версию схемы дельта не пишет — это делает движок `upgrade.sh` (upgrades/README.md).
set -euo pipefail

NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_FILE="/mnt/data/nocodb-data/upgrade.log"

cd "$INSTALL_DIR"

echo "📦 U014: подписи связей из UI — убираю «s» в plural («Контактыs» → «Контакты»)"

[ -f "$NOCO_DB" ] || { echo "❌ База не найдена: $NOCO_DB" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "❌ sqlite3 не установлен" >&2; exit 1; }

q() { sqlite3 "$NOCO_DB" ".timeout 5000" "$1" 2>/dev/null || true; }

log() {
    echo "$@"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE" 2>/dev/null || true
}

# Условие «кандидата» = правило U012: видимая связь, валидный meta, plural = singular + 's'.
# UPDATE в SQLite не поддерживает алиасы → собираем условие с префиксом колонок:
#   ''   — для одиночных запросов к nc_columns_v2
#   'c.' — для запросов с JOIN (иначе `title` неоднозначен)
artifact_where() {
    local p="${1:-}"
    cat <<TXT
uidt = 'LinkToAnotherRecord'
    AND ${p}title NOT LIKE 'nc\_%' ESCAPE '\'
    AND ${p}meta IS NOT NULL AND json_valid(${p}meta)
    AND json_extract(${p}meta, '\$.plural') IS NOT NULL
    AND json_extract(${p}meta, '\$.singular') IS NOT NULL
    AND json_extract(${p}meta, '\$.plural') = json_extract(${p}meta, '\$.singular') || 's'
TXT
}

WHERE_FLAT=$(artifact_where "")
WHERE_JOIN=$(artifact_where "c.")

BEFORE=$(q "SELECT COUNT(*) FROM nc_columns_v2 WHERE $WHERE_FLAT;")

if [ "${BEFORE:-0}" = "0" ]; then
    log "✅ Кривых подписей нет — пропуск"
    exit 0
fi

log "   🔎 Найдено подписей с лишним «s» (связи из UI): $BEFORE"
q "SELECT '      • ' || m.title || '.' || c.title || ' (' || json_extract(c.meta,'\$.plural') || ' → ' || json_extract(c.meta,'\$.singular') || ')'
   FROM nc_columns_v2 c JOIN nc_models_v2 m ON m.id = c.fk_model_id
   WHERE $WHERE_JOIN ORDER BY m.title LIMIT 20;" | grep -v '^$' || true

sqlite3 "$NOCO_DB" <<EOF
.timeout 5000
.bail on
BEGIN TRANSACTION;
UPDATE nc_columns_v2
   SET meta = json_set(meta, '\$.plural', json_extract(meta, '\$.singular')),
       updated_at = datetime('now')
 WHERE $WHERE_FLAT;
COMMIT;
EOF

AFTER=$(q "SELECT COUNT(*) FROM nc_columns_v2 WHERE $WHERE_FLAT;")
if [ "${AFTER:-0}" != "0" ]; then
    echo "❌ Осталось кривых подписей: $AFTER (ожидалось 0)" >&2
    exit 1
fi

log "   ✅ Исправлено подписей: $BEFORE"
log "   🔄 NocoDB держит метаданные в памяти — нужен рестарт (upgrade.sh делает это сам)"
echo "✅ U014 завершена"
