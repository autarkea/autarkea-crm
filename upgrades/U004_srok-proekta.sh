#!/bin/bash
# upgrades/U004_srok-proekta.sh
# Проекты: добавить колонку «Срок проекта» (Date) — дедлайн проекта (v4.18)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "📦 U004: Проекты: колонка «Срок проекта» (Date)"
bash modules/add-column.sh "Проекты" "Срок проекта" "DATE" "Дедлайн проекта" "" "130px" || exit 1
echo "✅ U004 завершена"
