#!/usr/bin/env bash
# ============================================================================
# tests/webhook-e2e.sh — black-box проверка вебхука (HTTP-контракт + безопасность)
# ============================================================================
# Запускается на VM/песочнице, где поднят контейнер printed4u-webhook.
# По умолчанию НЕ трогает данные (только auth + валидация). Мутирующие проверки
# (создают папку и файл проекта) — только с --mutate <ID> и на ТЕСТОВОЙ базе.
#
# Использование:
#   bash tests/webhook-e2e.sh                    # безопасные проверки (секрет из ./.env)
#   bash tests/webhook-e2e.sh --url http://localhost:3001 --secret "xxx"
#   bash tests/webhook-e2e.sh --mutate 15        # + мутирующие для проекта #15
# ============================================================================
set -u

URL="http://localhost:3001"
SECRET=""
MUTATE_ID=""
DIR="$(cd "$(dirname "$0")" && pwd)"

while [ $# -gt 0 ]; do
    case "$1" in
        --url)    URL="$2"; shift 2 ;;
        --secret) SECRET="$2"; shift 2 ;;
        --mutate) MUTATE_ID="$2"; shift 2 ;;
        -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
        *) echo "Неизвестный аргумент: $1"; exit 2 ;;
    esac
done

if [ -z "$SECRET" ] && [ -f "$DIR/../.env" ]; then
    SECRET=$(grep -m1 '^WEBHOOK_SECRET=' "$DIR/../.env" | cut -d= -f2-)
fi
if [ -z "$SECRET" ]; then
    echo "❌ Не задан WEBHOOK_SECRET (используй --secret или ./.env)"; exit 1
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
S1="$TMP/small.txt";  printf 'hello' > "$S1"
BIG="$TMP/big.bin";   dd if=/dev/zero of="$BIG" bs=1M count=51 >/dev/null 2>&1

PASS=0; FAIL=0
ok()    { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()   { FAIL=$((FAIL+1)); echo "  ❌ $1 (ожидалось $2, получено '$3')"; }
check() { [ "$3" = "$2" ] && ok "$1" || bad "$1" "$2" "$3"; }
code()  { curl -s -o /dev/null -w '%{http_code}' "$@"; }
J='-H Content-Type:application/json'

echo "🚀 Проверяю вебхук: $URL"
echo
echo "— Auth / доступ —"
check "GET /health без секрета → 200"            200 "$(code "$URL/health")"
check "/create-folder без секрета → 403"          403 "$(code "$URL/create-folder?docId=1")"
check "/create-folder неверный секрет → 403"      403 "$(code "$URL/create-folder?docId=1&secret=wrong")"
check "/transfer-project без секрета → 403"       403 "$(code -X POST "$URL/transfer-project" $J -d '{}')"
check "/upload-file без секрета → 403"            403 "$(code -X POST "$URL/upload-file" -F "file=@$S1")"

echo
echo "— Валидация —"
check "/create-folder секрет, без docId → 400"    400 "$(code "$URL/create-folder?secret=$SECRET")"
check "/refresh-files секрет, без docId → 400"    400 "$(code "$URL/refresh-files?secret=$SECRET")"
check "/transfer-project пустые ids → 400"        400 "$(code -X POST "$URL/transfer-project?secret=$SECRET" $J -d '{}')"
check "/attach-client без ids → 400"              400 "$(code -X POST "$URL/attach-client?secret=$SECRET" $J -d '{"projectId":1}')"
check "/set-contact-org невалидный → 400"         400 "$(code -X POST "$URL/set-contact-org?secret=$SECRET" $J -d '{"contactId":"abc"}')"
check "/upload-file без projectId → 400"          400 "$(code -X POST "$URL/upload-file?secret=$SECRET" -F "file=@$S1")"
check "/upload-file без файла → 400"              400 "$(code -X POST "$URL/upload-file?secret=$SECRET" -F "projectId=1")"
check "/upload-file >50МБ → 413"                  413 "$(code -X POST "$URL/upload-file?secret=$SECRET" -F "file=@$BIG" -F "projectId=1")"

if [ -n "$MUTATE_ID" ]; then
    echo
    echo "— Мутирующие (проект #$MUTATE_ID; тестовая база!) —"
    check "/create-folder проект → 200"           200 "$(code "$URL/create-folder?docId=$MUTATE_ID&secret=$SECRET")"
    check "/create-folder повтор → 200 (идемпотентно)" 200 "$(code "$URL/create-folder?docId=$MUTATE_ID&secret=$SECRET")"
    check "/upload-file успех → 200"              200 "$(code -X POST "$URL/upload-file?secret=$SECRET" -F "file=@$S1" -F "projectId=$MUTATE_ID")"
    check "/upload-file тот же файл → 200"        200 "$(code -X POST "$URL/upload-file?secret=$SECRET" -F "file=@$S1" -F "projectId=$MUTATE_ID")"
    echo "  ℹ️  Проверь вручную: папку /mnt/data/projects/$MUTATE_ID* и отсутствие дублей файла в «Рабочие»"
fi

echo
echo "════════════════════════════════════════"
echo "  PASS: $PASS   FAIL: $FAIL"
echo "════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
