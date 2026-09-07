#!/bin/bash
# ============================================================================
# preserve-custom-assets.sh v1.0.0 — сохранение пользовательских файлов шаблонов
#
# Назначение: ДО обновления кода (git pull / git reset --hard) перенести
# кастомизированные файлы из templates/ (печать организации и т.п.) в зону
# данных /mnt/data/noco-static/img — она вне git, обновления её не затирают.
# Дополнительно снимает страховочный архив изменённых файлов templates/.
#
# Почему нужно: каталог templates/ живёт в git-репозитории, а upgrade.sh при
# обновлении приводит код к origin/main (reset --hard). Любая правка клиента
# внутри templates/ будет затёрта эталоном. Пользовательские файлы должны
# лежать в /mnt/data (данные), а не в templates (код).
#
# Вызов:    INSTALL_DIR=... [DATA_DIR=...] [BACKUP_DIR=...] bash modules/preserve-custom-assets.sh
#           (вызывается автоматически в начале upgrade.sh, можно и вручную)
# Идемпотентный: повторный запуск безопасен (cp -n, ничего не перезаписывает).
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_DIR="${DATA_DIR:-/mnt/data}"
NOCO_IMG="$DATA_DIR/noco-static/img"
BACKUP_DIR="${BACKUP_DIR:-$DATA_DIR/backups}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

STAMP_REL="templates/img/stamp.png"
STAMP="$INSTALL_DIR/$STAMP_REL"
TARGET="$NOCO_IMG/stamp.png"

# ────────────────────────────────────────────────────────────────────────────
# 1. Печать организации: кастомизированный stamp.png → /mnt/data/noco-static/img/
# ────────────────────────────────────────────────────────────────────────────
if [ ! -d "$DATA_DIR/noco-static" ]; then
    echo -e "${YELLOW}⚠️  Каталог $DATA_DIR/noco-static не найден — сохранение печати пропущено${NC}"
else
    mkdir -p "$NOCO_IMG"
    if [ ! -f "$STAMP" ]; then
        echo -e "${YELLOW}⚠️  $STAMP_REL отсутствует — если печать была кастомизирована, положи её в $TARGET${NC}"
    else
        CUSTOM=0
        if [ -d "$INSTALL_DIR/.git" ]; then
            BASE_MD5=$(cd "$INSTALL_DIR" && git show "HEAD:$STAMP_REL" 2>/dev/null | md5sum | cut -d' ' -f1) || BASE_MD5=""
            CUR_MD5=$(md5sum "$STAMP" | cut -d' ' -f1)
            if [ -z "$BASE_MD5" ] || [ "$BASE_MD5" != "$CUR_MD5" ]; then
                CUSTOM=1   # файл отсутствует в git или отличается от эталона — правка клиента
            fi
        else
            CUSTOM=1       # не git-репозиторий: считаем файл пользовательским (мог быть заменён)
        fi

        if [ "$CUSTOM" = "1" ]; then
            if [ ! -f "$TARGET" ]; then
                cp "$STAMP" "$TARGET"
                echo -e "${GREEN}💾 Пользовательская печать сохранена: $TARGET${NC}"
            else
                echo -e "${GREEN}✓ Пользовательская печать уже в $TARGET — не перезаписываю (cp -n)${NC}"
            fi
        else
            echo -e "✓ $STAMP_REL — эталонная, перенос не нужен"
        fi
    fi
fi

# ────────────────────────────────────────────────────────────────────────────
# 2. Страховочный архив изменённых/добавленных файлов templates/
#    (любая кастомизация восстановима, даже если что-то пойдёт не так)
# ────────────────────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
LIST_FILE=$(mktemp)
trap 'rm -f "$LIST_FILE"' EXIT

if [ -d "$INSTALL_DIR/.git" ]; then
    (cd "$INSTALL_DIR" \
        && { git diff --name-only -- templates/ 2>/dev/null; \
             git diff --cached --name-only -- templates/ 2>/dev/null; \
             git ls-files --others --exclude-standard -- templates/ 2>/dev/null; } \
        ) | sort -u > "$LIST_FILE"
else
    # не git-репозиторий: архивируем templates целиком как страховку
    (cd "$INSTALL_DIR" && find templates -type f 2>/dev/null) | sort > "$LIST_FILE"
fi

if [ -s "$LIST_FILE" ]; then
    ARCH="$BACKUP_DIR/pre-upgrade-templates-$(date '+%Y%m%d-%H%M%S').tar.gz"
    if tar -czf "$ARCH" -C "$INSTALL_DIR" -T "$LIST_FILE" 2>/dev/null; then
        echo -e "${GREEN}🗜  Страховочный архив кастомизаций templates: $ARCH${NC}"
    else
        echo -e "${YELLOW}⚠️  Не удалось создать архив кастомизаций templates/${NC}"
    fi
else
    echo "✓ Изменений в templates/ нет — архив не нужен"
fi

exit 0
