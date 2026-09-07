#!/bin/bash
# upgrades/U001_role-rukovoditel.sh
# Роль сотрудников: «Админ» → «Руководитель» (миграция данных, цвет из эталона)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "📦 U001: Сотрудники.Роль: «Админ» → «Руководитель»"
bash modules/edit-select-options.sh "Сотрудники" "Роль" "Админ" "Руководитель" "#07FB09FF" || exit 1
echo "✅ U001 завершена"
