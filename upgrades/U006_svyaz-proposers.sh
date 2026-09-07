#!/bin/bash
# upgrades/U006_svyaz-proposers.sh
# Связь «Кто предложил» (Дела → Сотрудники) + обратная «Делаs» (Сотрудники → Дела)
# Через add-link-m2o.sh (M2O + промежуточная M2M, имя с обработкой коллизий)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "📦 U006: Связь Дела.Кто предложил ↔ Сотрудники.Делаs"
bash modules/add-link-m2o.sh "Дела" "Кто предложил" "Сотрудники" "Делаs" || exit 1
echo "✅ U006 завершена"
