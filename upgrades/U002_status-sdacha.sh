#!/bin/bash
# upgrades/U002_status-sdacha.sh
# Статус проектов: «Готов к выдаче» → «Готов к сдаче» (миграция данных, цвет из эталона)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "📦 U002: Проекты.Статус: «Готов к выдаче» → «Готов к сдаче»"
bash modules/edit-select-options.sh "Проекты" "Статус" "Готов к выдаче" "Готов к сдаче" "#06F7E0FF" || exit 1
echo "✅ U002 завершена"
