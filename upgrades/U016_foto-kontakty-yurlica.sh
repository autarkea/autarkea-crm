#!/bin/bash
# upgrades/U016_foto-kontakty-yurlica.sh
# v4.70.0: колонка-вложение «Фото» в таблицах «Контакты» и «Юрлица».
#
# Зачем. Поле «Фото» было только в «Сотрудниках» (ещё в эталоне v4.48.0). На живой
# базе (август 2026) «Фото» добавили в UI NocoDB ещё двум таблицам, но дельты под
# это не написали — при экспорте эталона поля уехали в `template.db`, а на
# установки клиентов не доехали (в этом и был корень «Контакт/ответственный» +
# новые поля не появились после апдейта»). Эта дельта закрывает «Фото».
#
# Что делает:
#   * «Контакты».«Фото» — вложение (Attachment);
#   * «Юрлица».«Фото»  — вложение (Attachment);
#   * идемпотентно: модуль `add-column.sh` по имени находит существующую колонку
#     и просто пропускает шаг (повторный запуск — «пропуск»);
#   * тип `ATTACHMENT` — `add-column.sh` v4.5.0 (uidt=Attachment, dt=text,
#     dtx=specificType — ровно как создаёт UI NocoDB).
#
# Версию схемы дельта не пишет — это делает движок `upgrade.sh` (upgrades/README.md).
set -euo pipefail

NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

cd "$INSTALL_DIR"

echo "📦 U016: колонка-вложение «Фото» в «Контакты» и «Юрлица»"

[ -f "$NOCO_DB" ] || { echo "❌ База не найдена: $NOCO_DB" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "❌ sqlite3 не установлен" >&2; exit 1; }

q() { sqlite3 "$NOCO_DB" ".timeout 5000" "$1" 2>/dev/null || true; }

# Таблицы обязаны существовать: если нет — это не «наша» база, молча портить нельзя
for T in "Контакты" "Юрлица"; do
    n=$(q "SELECT COUNT(*) FROM nc_models_v2 WHERE title='$T' AND mm!=1;")
    if [ "${n:-0}" -eq 0 ]; then
        echo "❌ Таблица «$T» не найдена в $NOCO_DB — дельта не применима" >&2
        exit 1
    fi
done

# «Фото» уже есть? — сообщаем и пропускаем (идемпотентность на уровне дельты:
# модуль тоже умеет, но так в логе видно, что именно было пропущено)
for T in "Контакты" "Юрлица"; do
    have=$(q "SELECT COUNT(*) FROM nc_columns_v2 c JOIN nc_models_v2 m ON m.id=c.fk_model_id WHERE m.title='$T' AND c.title='Фото';")
    if [ "${have:-0}" -gt 0 ]; then
        echo "   ⏭️  Уже есть: $T.Фото (пропуск)"
    else
        echo "   ➕ Добавляю: $T.Фото (Attachment)"
        SKIP_RESTART=1 NOCO_DB="$NOCO_DB" bash modules/add-column.sh "$T" "Фото" "ATTACHMENT" "Фото" >/dev/null || {
            echo "❌ Не удалось добавить колонку «$T».«Фото»" >&2
            exit 1
        }
    fi
done

# ── Проверка ────────────────────────────────────────────────────────────────
BAD=0
for T in "Контакты" "Юрлица"; do
    row=$(q "SELECT c.uidt FROM nc_columns_v2 c JOIN nc_models_v2 m ON m.id=c.fk_model_id WHERE m.title='$T' AND c.title='Фото' LIMIT 1;")
    if [ "$row" != "Attachment" ]; then
        echo "❌ $T.Фото: ожидался тип Attachment, получено «${row:-нет колонки}»" >&2
        BAD=1
    fi
done
[ "$BAD" -eq 0 ] || exit 1

echo "   ✅ Контакты.Фото и Юрлица.Фото — Attachment (тип совпадает с эталоном)"
echo "   🔄 NocoDB держит метаданные в памяти — нужен рестарт (upgrade.sh делает это сам)"
echo "✅ U016 завершена"
