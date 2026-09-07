#!/bin/bash
# upgrades/U003_messenger-colors.sh
# Контакты.Мессенджер: фирменные цвета существующих + добавить 4 новых опции
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "📦 U003: Контакты.Мессенджер — фирменные цвета + новые опции"

# Перекрасить существующие (новое название пустое — только цвет)
bash modules/edit-select-options.sh "Контакты" "Мессенджер" "Telegram" "" "#229ED9" || exit 1
bash modules/edit-select-options.sh "Контакты" "Мессенджер" "Viber" "" "#7360F2" || exit 1
bash modules/edit-select-options.sh "Контакты" "Мессенджер" "Куфар" "" "#0AA99A" || exit 1

# Добавить новые опции с цветами
bash modules/add-select-options.sh "Контакты" "Мессенджер" "WhatsApp:#25D366,Instagram:#E1306C,ВКонтакте:#0077FF,Иное:#9E9E9E" || exit 1

echo "✅ U003 завершена"
