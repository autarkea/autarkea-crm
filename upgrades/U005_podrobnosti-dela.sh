#!/bin/bash
# upgrades/U005_podrobnosti-dela.sh
# Дела: добавить колонку «Подробности» (LongText) — заметка к задаче (v4.18)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "📦 U005: Дела: колонка «Подробности» (LongText)"
bash modules/add-column.sh "Дела" "Подробности" "LONGTEXT" "Заметка к задаче" "" "250px" || exit 1
echo "✅ U005 завершена"
