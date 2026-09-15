#!/bin/bash
# ============================================================================
# modules/schema-drift.sh v1.0.0 — «дрейф эталона»: что изменилось в template.db
# относительно последнего коммита и покрыто ли это дельтой (v4.70.0)
# ============================================================================
# Зачем. Контроль «правка в UI ⇒ дельта» (tests/template-schema.test.js, инвариант
# ОТК) срабатывает уже ПОСЛЕ переэкспорта шаблона и только по составу. Этот модуль
# отвечает на тот же вопрос в момент подготовки эталона — и сразу говорит, ЧТО ДЕЛАТЬ.
# Вызывается из export-template.sh (подшаг 12.7) и руками перед коммитом шаблона.
#
# Сравнивается ТЕКУЩИЙ `template.db` с эталоном из последнего коммита (git HEAD).
# Изменения делятся на два класса — ровно по границе миграции (upgrades/README.md):
#
#   🧩 МИГРИРУЕМОЕ — таблицы, колонки с типом (uidt), СМЫСЛ связей (mo/om),
#      опции селектов. У клиентов это появляется ТОЛЬКО дельтой, поэтому для
#      каждого элемента печатается: ✅ покрыто дельтой U0NN или ⚠️ нужна дельта.
#   🖼  ЭТАЛОН-ОНЛИ — виды (набор, тип): раскладка UI. Дельты НЕ требуют: клиент
#      настраивает виды/порядок/фильтры под себя, мы это не навязываем и не откатываем.
#
# Использование:
#   bash modules/schema-drift.sh                  # отчёт (код возврата 0)
#   bash modules/schema-drift.sh --strict         # код 1, если мигрируемое не покрыто дельтой
#   bash modules/schema-drift.sh --prev file.db   # сравнить с конкретной базой (без git)
#   bash modules/schema-drift.sh --quiet          # только итог
#   TEMPLATE=/path/template.db bash modules/schema-drift.sh
#
# Коды возврата: 0 — отчёт построен (даже если есть непокрытое); 1 — только в --strict.
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TEMPLATE="${TEMPLATE:-$INSTALL_DIR/template.db}"
UPGRADES_DIR="${UPGRADES_DIR:-$INSTALL_DIR/upgrades}"
PREV="${PREV:-}"
STRICT=false
QUIET=false

while [ $# -gt 0 ]; do
    case "$1" in
        --strict)  STRICT=true ;;
        --quiet)   QUIET=true ;;
        --prev)    shift; PREV="${1:-}" ;;
        --prev=*)  PREV="${1#--prev=}" ;;
        -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)
            echo "❌ Неизвестный аргумент: $1" >&2
            echo "   Использование: bash modules/schema-drift.sh [--strict] [--quiet] [--prev file.db]" >&2
            exit 1
            ;;
    esac
    shift
done

command -v sqlite3 >/dev/null 2>&1 || { echo "❌ sqlite3 не установлен" >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "❌ Эталон не найден: $TEMPLATE" >&2; exit 1; }

# Фильтры — те же, что в schema-fingerprint.sh / schema-compare.sh (системные таблицы
# NocoDB и junction-начинка в состав эталона не входят).
MODEL_FILTER="m.title NOT LIKE 'nc\\_%' ESCAPE '\\' AND m.title!='workspace' AND m.table_name IS NOT NULL AND m.table_name!='' AND COALESCE(m.mm,0)!=1"
COL_FILTER="c.uidt IS NOT NULL AND c.title NOT IN ('Id','CreatedAt','UpdatedAt','nc_created_by','nc_updated_by') AND c.title NOT LIKE 'nc\\_%' ESCAPE '\\'"

# --- Элементы эталона: kind|таблица|имя|значение ---------------------------------
# T — таблица, C — колонка+uidt, L — смысл связи, S — опция селекта (мигрируемые),
# V — вид (эталон-онли).
elements_of() {
    sqlite3 "$1" <<SQL 2>/dev/null || true
.timeout 5000
SELECT 'T|' || m.title
  FROM nc_models_v2 m WHERE $MODEL_FILTER
UNION ALL
SELECT 'C|' || m.title || '|' || c.title || '|' || c.uidt
  FROM nc_columns_v2 c JOIN nc_models_v2 m ON m.id=c.fk_model_id
 WHERE $MODEL_FILTER AND $COL_FILTER
UNION ALL
SELECT 'L|' || m.title || '|' || c.title || '|' ||
       COALESCE((SELECT MIN(r.type) FROM nc_col_relations_v2 r WHERE r.fk_column_id=c.id),'нет')
  FROM nc_columns_v2 c JOIN nc_models_v2 m ON m.id=c.fk_model_id
 WHERE $MODEL_FILTER AND $COL_FILTER AND c.uidt='LinkToAnotherRecord'
UNION ALL
SELECT 'S|' || m.title || '|' || c.title || '|' || o.title
  FROM nc_col_select_options_v2 o
  JOIN nc_columns_v2 c ON c.id=o.fk_column_id
  JOIN nc_models_v2 m ON m.id=c.fk_model_id
 WHERE $MODEL_FILTER
UNION ALL
SELECT 'V|' || m.title || '|' || v.title || '|' || COALESCE(CAST(v.type AS TEXT),'')
  FROM nc_views_v2 v JOIN nc_models_v2 m ON m.id=v.fk_model_id
 WHERE $MODEL_FILTER;
SQL
}

# --- Предыдущий эталон: --prev/PREV или последний коммит template.db -------------
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
PREV_DB="$WORK_DIR/prev.db"
PREV_LABEL=""

if [ -n "$PREV" ]; then
    [ -f "$PREV" ] || { echo "❌ База для сравнения не найдена: $PREV" >&2; exit 1; }
    cp "$PREV" "$PREV_DB"
    PREV_LABEL="$PREV"
elif command -v git >/dev/null 2>&1 && git -C "$INSTALL_DIR" -c safe.directory='*' rev-parse --git-dir >/dev/null 2>&1; then
    HEAD_SHA=$(git -C "$INSTALL_DIR" -c safe.directory='*' log --format=%h -n 1 -- template.db 2>/dev/null || true)
    if [ -n "$HEAD_SHA" ] && git -C "$INSTALL_DIR" -c safe.directory='*' show "$HEAD_SHA:template.db" > "$PREV_DB" 2>/dev/null; then
        PREV_LABEL="git HEAD ($HEAD_SHA)"
    else
        rm -f "$PREV_DB"
    fi
fi

if [ ! -s "$PREV_DB" ]; then
    echo "ℹ️  Предыдущий эталон недоступен (нет git-истории template.db) — дрейф считать не с чем."
    echo "   Эталон: $TEMPLATE"
    exit 0
fi

# --- Ключ элемента для «изменилось» ----------------------------------------------
# C и L: ключ без значения (uidt / тип связи) — чтобы смена ТИПА была видна как
# «изменилось», а не как «удалили + добавили». S и V: ключ включает последнее поле
# (опция селекта и тип вида — это отдельные элементы; добавление второй опции значит
# «появилась опция», а не «изменилась колонка»).
key_of() {
    if [ "${1%%|*}" = "S" ] || [ "${1%%|*}" = "V" ]; then
        printf '%s' "$1"
    else
        printf '%s' "$(echo "$1" | cut -d'|' -f1-3)"
    fi
}

# --- Состав двух эталонов --------------------------------------------------------
elements_of "$TEMPLATE" > "$WORK_DIR/cur.elems"
elements_of "$PREV_DB"  > "$WORK_DIR/prev.elems"

declare -A CUR_BY_KEY=() PREV_BY_KEY=() CUR_LINE=() PREV_LINE=()
while IFS= read -r line; do
    [ -z "$line" ] && continue
    CUR_LINE["$line"]=1
    CUR_BY_KEY["$(key_of "$line")"]="$line"
done < "$WORK_DIR/cur.elems"
while IFS= read -r line; do
    [ -z "$line" ] && continue
    PREV_LINE["$line"]=1
    PREV_BY_KEY["$(key_of "$line")"]="$line"
done < "$WORK_DIR/prev.elems"

# --- Классификация: появилось / изменилось (та же таблица+имя) / исчезло ---------
ADDED=(); CHANGED=(); VANISHED=()
for line in "${!CUR_LINE[@]}"; do
    key="$(key_of "$line")"
    if [ -z "${PREV_BY_KEY[$key]:-}" ]; then
        ADDED+=("$line")
    elif [ "${PREV_BY_KEY[$key]}" != "$line" ]; then
        CHANGED+=("$line")
    fi
done
for line in "${!PREV_LINE[@]}"; do
    key="$(key_of "$line")"
    [ -z "${CUR_BY_KEY[$key]:-}" ] && VANISHED+=("$line")
done

# --- Покрытие дельтами: только дельты НОМЕРОМ ВЫШЕ маркера прошлого эталона ------
PREV_MARKER="$(sqlite3 "$PREV_DB" "SELECT value FROM nc_store WHERE key='printed4u_schema_version' LIMIT 1;" 2>/dev/null | tr -cd '0-9')"
[ -z "$PREV_MARKER" ] && PREV_MARKER=0
DELTA_MAX=0
for f in "$UPGRADES_DIR"/U*.sh; do
    [ -e "$f" ] || continue
    n=$(basename "$f" | sed -n 's/^U0*\([0-9][0-9]*\)_.*/\1/p')
    [ -n "$n" ] || continue
    [ "$n" -gt "$DELTA_MAX" ] && DELTA_MAX="$n"
done

delta_for() { # строка элемента → «U0NN», если её имя упоминается в НОВЫХ дельтах
    local kind model name val cname f n best=""
    IFS='|' read -r kind model name val <<< "$1"
    case "$kind" in
        T) cname="$model" ;;
        S) cname="$val" ;;
        *) cname="$name" ;;
    esac
    [ -n "$cname" ] || return 0
    for f in "$UPGRADES_DIR"/U*.sh; do
        [ -e "$f" ] || continue
        n=$(basename "$f" | sed -n 's/^U0*\([0-9][0-9]*\)_.*/\1/p')
        [ -n "$n" ] || continue
        [ "$n" -gt "$PREV_MARKER" ] || continue
        if grep -qF -- "$cname" "$f" 2>/dev/null; then
            # Из нескольких дельт, упоминающих имя, показываем самую свежую
            if [ -z "$best" ] || [ "$n" -gt "$best" ]; then
                best="$n"
            fi
        fi
    done
    [ -n "$best" ] && printf 'U%03d' "$best"
    return 0
}

describe() { # строка элемента → человекочитаемое описание
    local kind model name val
    IFS='|' read -r kind model name val <<< "$1"
    case "$kind" in
        T) printf 'таблица «%s»' "$model" ;;
        C) printf 'колонка «%s» в «%s» (uidt=%s)' "$name" "$model" "$val" ;;
        L) printf 'смысл связи «%s» в «%s» (%s)' "$name" "$model" "$val" ;;
        S) printf 'опция «%s» у «%s.%s»' "$name" "$model" "$val" ;;
        V) printf 'вид «%s» у «%s» (type=%s)' "$name" "$model" "$val" ;;
        *) printf '%s' "$1" ;;
    esac
}

# --- Разбор по классам + вывод ---------------------------------------------------
MIGRATE=(); REFONLY=()
while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [ "${line%%|*}" = "V" ]; then REFONLY+=("$line"); else MIGRATE+=("$line"); fi
done < <(printf '%s\n' "${ADDED[@]}" "${CHANGED[@]}" | LC_ALL=C sort)

UNCOVERED=0
UNCOVERED_LIST=()
for line in "${MIGRATE[@]}"; do
    [ -z "$(delta_for "$line")" ] && { UNCOVERED=$((UNCOVERED + 1)); UNCOVERED_LIST+=("$line"); }
done

DIFF_TOTAL=$(( ${#ADDED[@]} + ${#CHANGED[@]} + ${#VANISHED[@]} ))

if [ "$QUIET" != true ]; then
    echo "═══════════════════════════════════════════════════════════"
    echo "🧭 schema-drift.sh v1.0.0 — дрейф эталона относительно git"
    echo "   Эталон:     $TEMPLATE"
    echo "   Предыдущий: $PREV_LABEL (маркер схемы $PREV_MARKER)"
    echo "   Дельт в репо до: U$(printf '%03d' "$DELTA_MAX")"
    echo "═══════════════════════════════════════════════════════════"

    if [ ${#MIGRATE[@]} -gt 0 ]; then
        echo ""
        echo "🧩 МИГРИРУЕМОЕ (у клиентов появится ТОЛЬКО дельтой):"
        for line in "${MIGRATE[@]}"; do
            key="$(key_of "$line")"
            delta="$(delta_for "$line")"
            if [ -n "$delta" ]; then
                echo "   ✅ покрыто [$delta]: $(describe "$line")"
            else
                echo "   ⚠️  НЕТ ДЕЛЬТЫ: $(describe "$line")"
            fi
            if [ -n "${PREV_BY_KEY[$key]:-}" ]; then
                echo "        было: $(describe "${PREV_BY_KEY[$key]}")"
            fi
        done
    fi

    if [ ${#REFONLY[@]} -gt 0 ]; then
        echo ""
        echo "🖼  ЭТАЛОН-ОНЛИ — раскладка UI (дельта НЕ нужна, клиент настроит сам):"
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            echo "   + $(describe "$line")"
        done < <(printf '%s\n' "${REFONLY[@]}" | LC_ALL=C sort)
    fi

    if [ ${#VANISHED[@]} -gt 0 ]; then
        echo ""
        echo "🧹 ИСЧЕЗЛО ИЗ ЭТАЛОНА (дельтами не «догоняется» — проверь, что это осознанно):"
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            echo "   − $(describe "$line")"
        done < <(printf '%s\n' "${VANISHED[@]}" | LC_ALL=C sort)
    fi

    echo ""
    echo "═══════════════════════════════════════════════════════════"
    if [ "$DIFF_TOTAL" -eq 0 ]; then
        echo "✅ Состав эталона не менялся относительно последнего коммита."
    else
        echo "📊 Итог: мигрируемых изменений ${#MIGRATE[@]} (без дельты: $UNCOVERED),"
        echo "        эталон-онли (виды) ${#REFONLY[@]}, исчезло ${#VANISHED[@]}"
        if [ "$UNCOVERED" -gt 0 ]; then
            echo "💡 Под каждый «НЕТ ДЕЛЬТЫ» нужен upgrades/U0NN_*.sh (upgrades/README.md):"
            echo "   иначе правка уезжает только в template.db — то есть лишь на свежую установку."
            echo "   Так разъехались «Фото» в «Контакты»/«Юрлица» и связь «Контакт/ответственный»."
        fi
    fi
    echo "═══════════════════════════════════════════════════════════"
fi

if [ "$STRICT" = true ] && [ "$UNCOVERED" -gt 0 ]; then
    for line in "${UNCOVERED_LIST[@]}"; do
        echo "❌ без дельты: $(describe "$line")" >&2
    done
    exit 1
fi
exit 0
