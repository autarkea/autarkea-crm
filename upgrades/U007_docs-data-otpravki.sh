#!/bin/bash
# upgrades/U007_docs-data-otpravki.sh
# Колонка «Дата отправки» (Date) в таблице «Документы».
#
# Зачем: server.js при отправке email PATCHит «Дата отправки», но такой колонки
# в схеме НЕТ (см. Шаг 0, Волна A) — аудит «писал в воздух». Добавляем честную
# Date-колонку: когда документ реально отправлен клиенту (email/вручную/почтой).
#
# Аддитивно и идемпотентно: add-column.sh сам пропустит шаг, если колонка есть.
set -euo pipefail
NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "📦 U007: колонка «Дата отправки» (Date) в «Документы»"
SKIP_RESTART=1 bash modules/add-column.sh \
    "Документы" "Дата отправки" "DATE" \
    "Когда документ отправлен клиенту (email/вручную/почтой)" || exit 1

echo "✅ U007 завершена"
