#!/bin/bash
# ============================================================================
# Printed4U CRM - Применение шаблона базы данных v4.8.1
# ============================================================================
# Копирует template.db, восстанавливает пользователя, workspace, 
# API-токены и динамически обновляет fk_workspace_id во всех системных таблицах.
# ============================================================================
set -e

DB_PATH="/mnt/data/nocodb-data/noco.db"
TEMPLATE="template.db"
BACKUP="/tmp/noco_backup_$$.db"

echo -e "\e[34m🔧 Применение шаблона базы данных v4.8.1...\e[0m"

# 1. Делаем бэкап текущей базы
echo -e "\e[33m💾 Делаю бэкап текущей базы...\e[0m"
if [ -f "$DB_PATH" ]; then
    sudo cp "$DB_PATH" "$BACKUP"
    sudo chmod 600 "$BACKUP"
else
    echo -e "\e[31m❌ Текущая база $DB_PATH не найдена!\e[0m"
    exit 1
fi

# 2. Функция для выполнения SQL в бэкапе
run_sql_backup() {
    docker run --rm -v /tmp:/tmp alpine:latest sh -c '
        apk add --no-cache sqlite >/dev/null 2>&1
        sqlite3 /tmp/noco_backup_'"$$"'.db "'"$1"'"
    '
}

# 3. Ищем workspace и пользователя в бэкапе
WORKSPACE_ID=$(run_sql_backup "SELECT id FROM workspace LIMIT 1;")
USER_ID=$(run_sql_backup "SELECT id FROM nc_users_v2 LIMIT 1;")

if [ -z "$WORKSPACE_ID" ] || [ -z "$USER_ID" ]; then
    echo -e "\e[31m❌ Workspace или пользователь не найдены в бэкапе.\e[0m"
    sudo rm -f "$BACKUP"
    exit 1
fi
echo -e "\e[32m   ✅ Workspace: $WORKSPACE_ID\e[0m"
echo -e "\e[32m   ✅ User: $USER_ID\e[0m"

# 4. Копируем template.db как новую рабочую базу
echo -e "\e[34m📦 Копирую template.db...\e[0m"
sudo rm -f "$DB_PATH"
cp "$TEMPLATE" "$DB_PATH"
sudo chown 1000:1000 "$DB_PATH"

# 5. Создаём SQL-патч
SQL_FILE="/tmp/patch_$$.sql"
cat > "$SQL_FILE" <<EOF
ATTACH DATABASE '/tmp/noco_backup_$$.db' AS backup;

DELETE FROM nc_users_v2;
DELETE FROM nc_org_users;
DELETE FROM nc_base_users_v2;
DELETE FROM nc_user_refresh_tokens;

DELETE FROM workspace;
DELETE FROM workspace_user;
DELETE FROM nc_org;

INSERT INTO nc_users_v2 SELECT * FROM backup.nc_users_v2;
INSERT INTO nc_user_refresh_tokens SELECT * FROM backup.nc_user_refresh_tokens;

DELETE FROM nc_api_tokens;
INSERT INTO nc_api_tokens SELECT * FROM backup.nc_api_tokens;

INSERT INTO workspace SELECT * FROM backup.workspace;
INSERT INTO workspace_user SELECT * FROM backup.workspace_user;

DELETE FROM nc_store WHERE key IN ('nc_auth_jwt_secret', 'nc_server_id', 'NC_DEFAULT_WORKSPACE_ID');
INSERT INTO nc_store (type, key, value, created_at, updated_at)
SELECT type, key, value, created_at, updated_at FROM backup.nc_store
WHERE key IN ('nc_auth_jwt_secret', 'nc_server_id', 'NC_DEFAULT_WORKSPACE_ID');

DELETE FROM nc_models_v2 WHERE table_name = '' OR table_name IS NULL;

INSERT INTO nc_base_users_v2 (base_id, fk_user_id, roles, fk_workspace_id, created_at, updated_at)
SELECT b.id, '$USER_ID', '["owner"]', '$WORKSPACE_ID', datetime('now'), datetime('now')
FROM nc_bases_v2 b LIMIT 1;

VACUUM;

DETACH backup;
EOF

# 6. Применяем основной SQL-патч
echo -e "\e[34m🔧 Применяю базовые настройки...\e[0m"
docker run --rm \
    -v /mnt/data/nocodb-data:/data \
    -v /tmp:/tmp \
    alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/noco.db < /tmp/patch_'"$$"'.sql
'

# 7. Заполняем nc_sources_v2.config
echo -e "\e[34m🔧 Заполняю nc_sources_v2.config...\e[0m"
docker run --rm -v /mnt/data/nocodb-data:/data alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/noco.db "UPDATE nc_sources_v2 SET config = '"'"'{\"client\":\"sqlite3\",\"connection\":{\"client\":\"sqlite3\",\"filename\":\"/usr/app/data/noco.db\"}}'"'"' WHERE type = '"'"'sqlite3'"'"';"
'

# 8. Динамически находим таблицы с fk_workspace_id
echo -e "\e[34m🔧 Нахожу таблицы с fk_workspace_id...\e[0m"

TABLES_WITH_WS=$(docker run --rm -v /mnt/data/nocodb-data:/data alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/noco.db "
        SELECT DISTINCT m.name 
        FROM sqlite_master m
        JOIN pragma_table_info(m.name) p
        WHERE p.name = '"'"'fk_workspace_id'"'"'
        AND m.type = '"'"'table'"'"'
        AND m.name NOT IN ('"'"'workspace'"'"', '"'"'workspace_user'"'"', '"'"'nc_org'"'"', '"'"'nc_org_users'"'"', '"'"'nc_users_v2'"'"', '"'"'nc_base_users_v2'"'"', '"'"'nc_api_tokens'"'"');
    "
')

TABLE_COUNT=$(echo "$TABLES_WITH_WS" | grep -c . || echo 0)
echo -e "\e[32m   ✅ Найдено таблиц для обновления: $TABLE_COUNT\e[0m"

# 9. Генерируем SQL-файл
UPDATE_SQL="/tmp/update_ws_$$.sql"
> "$UPDATE_SQL"

echo "$TABLES_WITH_WS" | while IFS= read -r TABLE; do
    if [ -n "$TABLE" ] && [ "$(echo "$TABLE" | tr -d '[:space:]')" != "" ]; then
        echo "UPDATE \"$TABLE\" SET fk_workspace_id = '$WORKSPACE_ID';" >> "$UPDATE_SQL"
    fi
done

# 10. Выполняем обновление fk_workspace_id
echo -e "\e[34m🔧 Обновляю fk_workspace_id во всех найденных таблицах...\e[0m"
docker run --rm \
    -v /mnt/data/nocodb-data:/data \
    -v "$UPDATE_SQL":/tmp/update_ws.sql:ro \
    alpine:latest sh -c '
        apk add --no-cache sqlite >/dev/null 2>&1
        sqlite3 /data/noco.db < /tmp/update_ws.sql
    '

# 11. Очистка
rm -f "$UPDATE_SQL" "$SQL_FILE"
sudo rm -f "$BACKUP"

# 12. Версия схемы = max-дельта (шаблон уже содержит ВСЕ фичи до текущего кода).
# Без этого маркер остаётся старым → diagnose.sh предупредит о «рассинхроне»,
# а первый upgrade.sh впустую погонит дельты (они идемпотентны, но шумно).
echo -e "\e[34m🔢 Инициализирую версию схемы (nc_store)...\e[0m"
MAX_DELTA=0
for f in upgrades/U*.sh; do
    [ -e "$f" ] || continue
    n=$(basename "$f" | sed -n 's/^U0*\([0-9][0-9]*\)_.*/\1/p')
    [ -n "$n" ] && [ "$n" -gt "$MAX_DELTA" ] && MAX_DELTA="$n"
done
if [ "$MAX_DELTA" -gt 0 ]; then
    NOCO_DB="$DB_PATH" bash modules/version.sh set "$MAX_DELTA"
    echo -e "\e[32m✅ Версия схемы инициализирована: $MAX_DELTA\e[0m"
else
    echo -e "\e[33m⚠️  Дельт в каталоге upgrades/ нет — версия схемы не инициализирована\e[0m"
fi

echo -e "\e[32m✅ Шаблон успешно применён! База готова к работе.\e[0m"