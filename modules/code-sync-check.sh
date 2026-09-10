#!/usr/bin/env bash
# ============================================================================
# modules/code-sync-check.sh — сверка КОДА установленной CRM с git HEAD
# ============================================================================
# Зачем: установленная CRM (тестовая VM, клиентский сервер) — это СНИМОК кода
# на момент установки, а upgrade.sh на машине без .git код НЕ обновляет.
# Прогонять сценарии (SMOKE_TEST_INSTALL, RELIABILITY R*, TESTING F*/U*)
# на устаревшем коде нельзя — результат невалиден для релиза. Правило:
# ПЕРЕД прогоном сверь код машины с приватным репозиторием этим скриптом.
#
# Использование:
#   # удалённая машина по ssh (типовой случай: тестовая VM):
#   bash modules/code-sync-check.sh --remote test@192.168.2.164:/home/test/printed4u-crm
#   # локальная установка (без git):
#   bash modules/code-sync-check.sh --local /path/to/printed4u-crm
#   # эталон можно указать явно (по умолчанию — репозиторий, где лежит скрипт):
#   bash modules/code-sync-check.sh --repo /path/to/repo --remote user@host:/path
#
# Сверяются git-tracked файлы кода: *.sh *.js *.yml *.json-манифесты,
# .env.example, Dockerfile (docs/assets/templates исключены: не влияют на
# исполняемый код, а templates клиент может кастомизировать легально).
#
# Exit code: 0 — код совпадает с HEAD; 1 — есть расхождения; 2 — ошибка вызова.
# ============================================================================

set -uo pipefail

REMOTE=""
LOCAL_DIR=""
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
    sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
}

while [ $# -gt 0 ]; do
    case "$1" in
        --remote) REMOTE="${2:-}"; shift 2 ;;
        --local)  LOCAL_DIR="${2:-}"; shift 2 ;;
        --repo)   REPO_DIR="${2:-}"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "Неизвестный аргумент: $1" >&2; usage ;;
    esac
done

if [ -n "$REMOTE" ] && [ -n "$LOCAL_DIR" ]; then
    echo "Ошибка: задай только одну цель — --remote или --local" >&2
    exit 2
fi
if [ -z "$REMOTE" ] && [ -z "$LOCAL_DIR" ]; then
    echo "Ошибка: укажи цель сверки: --remote user@host:/path или --local /path" >&2
    exit 2
fi

# ── Эталон: git HEAD репозитория ────────────────────────────────────────────
cd "$REPO_DIR" || { echo "Нет каталога: $REPO_DIR" >&2; exit 2; }
if [ ! -d .git ]; then
    echo "Ошибка: $REPO_DIR — не git-репозиторий (эталоном должен быть клон с .git)" >&2
    exit 2
fi
HEAD=$(git rev-parse --short HEAD 2>/dev/null) || { echo "Ошибка: git rev-parse" >&2; exit 2; }
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "⚠️  В репозитории есть НЕзакоммиченные изменения — сверяю с HEAD ($HEAD),"
    echo "   незакоммиченное в расчёт не идёт. Закоммить правки и повтори."
fi

# Код-файлы из git (docs/assets/templates/markdown не трогаем).
FILES=$(git ls-files | grep -E '\.(sh|js|yml)$|\.env\.example$|Dockerfile$' || true)
[ -n "$FILES" ] || { echo "Ошибка: пустой список файлов для сверки" >&2; exit 2; }

# ── Контрольные суммы эталона (из git, не из рабочей копии) ─────────────────
TMP_REF=$(mktemp) TMP_TGT=$(mktemp)
trap 'rm -f "$TMP_REF" "$TMP_TGT"' EXIT
echo "$FILES" | while IFS= read -r f; do
    git show "HEAD:$f" 2>/dev/null | md5sum | awk -v p="$f" '{print p" "$1}'
done | sort > "$TMP_REF"

# ── Контрольные суммы цели ───────────────────────────────────────────────────
FILES_SPACE=$(echo "$FILES" | tr '\n' ' ')
TARGET_LABEL=""
if [ -n "$REMOTE" ]; then
    HOST="${REMOTE%:*}"
    RPATH="${REMOTE#*:}"
    TARGET_LABEL="$HOST:$RPATH"
    ssh -T -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "cd '$RPATH' 2>/dev/null && md5sum $FILES_SPACE 2>/dev/null || echo SSH_OR_PATH_ERROR" \
        | awk '{print $2" "$1}' | sort > "$TMP_TGT" || true
    if grep -q '^SSH_OR_PATH_ERROR' "$TMP_TGT"; then
        echo "Ошибка: не удалось подключиться или нет каталога $RPATH на $HOST" >&2
        exit 2
    fi
else
    TARGET_LABEL="$LOCAL_DIR"
    (cd "$LOCAL_DIR" 2>/dev/null && md5sum $FILES_SPACE 2>/dev/null) \
        | awk '{print $2" "$1}' | sort > "$TMP_TGT" || true
    [ -s "$TMP_TGT" ] || { echo "Ошибка: не удалось прочитать $LOCAL_DIR" >&2; exit 2; }
fi

# ── Сравнение ────────────────────────────────────────────────────────────────
MISMATCH=$(join -a1 "$TMP_REF" "$TMP_TGT" 2>/dev/null | awk '$2 != $3 {print $1}')
if [ -z "$MISMATCH" ]; then
    N=$(wc -l < "$TMP_REF")
    echo "✅ Код на «$TARGET_LABEL» совпадает с HEAD ($HEAD) — $N файлов, расхождений нет."
    exit 0
fi

echo "❌ Код на «$TARGET_LABEL» ОТСТАЁТ от HEAD ($HEAD). Расхождения:"
echo "$MISMATCH" | sed 's/^/   - /'
echo ""
echo "Синхронизируй перед прогоном:"
echo "   # вариант 1 — если на машине есть .git и remote: bash upgrade.sh (шаг «код»)"
echo "   # вариант 2 — скопировать файлы с dev-машины (см. список выше)"
exit 1
