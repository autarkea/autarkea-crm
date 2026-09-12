// ============================================================================
// shared/webhook-utils.js — чистые помощники вебхука (webhook/server.js)
// ============================================================================
// Вынесены из webhook/server.js (v4.56.0), чтобы их можно было тестировать
// без запуска HTTP-сервера: tests/webhook-utils.test.js
// В контейнер webhook монтируется как ./shared (docker-compose: ./shared:/app/shared).
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Умная очистка имени для файловой системы (защита от ENAMETOOLONG).
// maxLength считается в code points (emoji = 1 символ), чтобы обрезка
// НЕ разрывала суррогатные пары (иначе в имени папки появляется «кракозябра»).
function sanitizeFolderName(name, maxLength = 50) {
    if (!name) return 'Без названия';

    let clean = String(name).replace(/[\r\n]+/g, ' ');   // переносы строк → пробел
    clean = clean.replace(/[\/\\:*?<>|@"']/g, '');       // опасные для ФС символы
    clean = clean.replace(/\s+/g, ' ').trim();           // лишние пробелы

    const chars = Array.from(clean);                     // code points, не UTF-16 units
    if (chars.length > maxLength) {
        clean = chars.slice(0, maxLength - 3).join('').trim() + '...';
    }

    if (!clean || clean === '...') clean = 'Без названия';
    return clean;
}

// Очистка имени загружаемого файла (бывший inline-regex в /upload-file).
function sanitizeFileName(originalName) {
    return String(originalName || '').replace(/[^a-zA-Z0-9а-яА-ЯёЁ._ -]/g, '_');
}

// «@username» → «(username)» — для отображения в HTML-страницах вебхука.
function formatContactName(name) {
    if (!name) return '';
    return String(name).replace(/@(\w+)/g, '($1)');
}

// Извлечь Id из поля-связи NocoDB (массив / объект / число / строка).
function getLinkedId(fieldData) {
    if (!fieldData) return null;
    if (Array.isArray(fieldData) && fieldData.length > 0) return fieldData[0]?.Id || null;
    if (typeof fieldData === 'object' && fieldData !== null) return fieldData.Id || null;
    if (typeof fieldData === 'string' || typeof fieldData === 'number') return fieldData;
    return null;
}

// Рекурсивный листинг папки (скрытые файлы пропускаются) → поле «Файлы в папке».
function listFiles(dir, prefix = '') {
    let result = '';
    try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
            if (item.name.startsWith('.')) continue;
            result += `${prefix}- ${item.name}${item.isDirectory() ? '/' : ''}\n`;
            if (item.isDirectory()) {
                result += listFiles(path.join(dir, item.name), prefix + '  ');
            }
        }
    } catch (e) {
        result += `${prefix}[Ошибка чтения]\n`;
    }
    return result;
}

// Client ID вида ABC123 (3 буквы + 3 цифры).
function generateClientId() {
    const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + crypto.randomInt(26))).join('');
    const digits = crypto.randomInt(1000).toString().padStart(3, '0');
    return `${letters}${digits}`;
}

// Поиск существующей папки проекта по ID. Устойчиво к разделителям «-», «_», « »:
// распознаёт папку даже после ручного переименования (иначе создаётся дубль).
// root передаётся явно (PROJECTS_ROOT), чтобы функцию можно было тестировать.
function findExistingProjectFolder(root, projectId, expectedProjName, expectedClientName) {
    if (!fs.existsSync(root)) return null;

    const folders = fs.readdirSync(root);
    const idPattern = new RegExp(`^${projectId}[ -_]`);
    const matchingFolders = folders.filter(f => idPattern.test(f));

    if (matchingFolders.length === 0) return null;

    if (matchingFolders.length === 1) {
        const folder = matchingFolders[0];
        const parts = folder.split(' - ');
        const folderClientName = parts.length > 2 ? parts[parts.length - 1] : '';
        if (folderClientName && folderClientName !== expectedClientName) {
            console.log(`⚠️ ВНИМАНИЕ: Клиент в NocoDB изменён! В папке: "${folderClientName}", в NocoDB: "${expectedClientName}"`);
            console.log(`💡 Используем существующую папку, чтобы не сломать файлы. Переименуйте вручную при необходимости.`);
        }
        return path.join(root, folder);
    }

    console.log(`❌ КРИТИЧЕСКАЯ ОШИБКА: Найдено ${matchingFolders.length} папок с ID=${projectId}!`);
    return path.join(root, matchingFolders[0]); // наименее разрушительный fallback
}

// Строгий разбор положительного целого id — общий «предохранитель» (shared/guard.js).
// Раньше в роутах стоял parseInt() + Number.isInteger: parseInt('1; DROP TABLE') === 1,
// проверка «проходила», и мусорный id молча трактовался как 1.
const { parsePositiveInt } = require('./guard');

// Проверка секрета (fail-closed, v4.27.3): нет секрета в .env → 503 (сервис не настроен),
// неверный секрет → 403. Возвращает результат, чтобы роут сам решил, что отдать.
function checkSecret(provided, expected) {
    if (!expected) {
        return { ok: false, status: 503, error: 'Сервис не настроен: WEBHOOK_SECRET отсутствует в .env' };
    }
    if (provided !== expected) {
        return { ok: false, status: 403, error: 'Неверный секретный ключ' };
    }
    return { ok: true };
}

// Сборка SQL-транзакции «снять связи ключа и поставить новые» для junction-таблиц NocoDB
// (CE не умеет PATCH Link-полей — правим напрямую). groups — по одной на таблицу:
// attach-client чистит сразу две (Контакты и Юрлица) в ОДНОЙ транзакции.
// id уже провалидированы parsePositiveInt (только числа) — интерполяция безопасна.
function buildJunctionReplaceSql(groups) {
    const statements = ['BEGIN IMMEDIATE;'];
    for (const group of groups) {
        const { table, keyColumn, keyValue, links = [] } = group;
        statements.push(`DELETE FROM "${table}" WHERE "${keyColumn}" = ${keyValue};`);
        for (const { column, value } of links) {
            statements.push(`INSERT INTO "${table}" ("${column}", "${keyColumn}") VALUES (${value}, ${keyValue});`);
        }
    }
    statements.push('COMMIT;');
    return statements.join('\n');
}

// Имя папки проекта «{id} - {Проект} - {Клиент}» с очисткой/обрезкой (клиент ≤40, проект ≤60).
// Возвращает и промежуточные safe-имена — они нужны для симлинка и поля «Файлы в папке».
function buildProjectFolderName(projectId, rawProjName, rawClientName) {
    const safeProjName = sanitizeFolderName(rawProjName || `Проект_${projectId}`, 60);
    const safeClientName = sanitizeFolderName(rawClientName || 'Без клиента', 40);
    return { safeProjName, safeClientName, folderName: `${projectId} - ${safeProjName} - ${safeClientName}` };
}

// Client ID из имени папки клиента «Имя (ABC123)» → 'ABC123' или null.
function parseClientFolderId(folderName) {
    const m = String(folderName || '').match(/\(([A-Z0-9]{6})\)$/);
    return m ? m[1] : null;
}

// HTTP-код для ошибки обработчика: «Не указан клиент» — вина клиента (400),
// остальное — серверная ошибка (500). Раньше /create-folder отдавал 500, а
// /refresh-files и /upload-file — 400 на ту же ситуацию (рассинхрон, v4.57.0).
function errorHttpStatus(message) {
    return String(message || '').includes('Не указан клиент') ? 400 : 500;
}

// Multer/busboy декодирует имя файла из multipart как latin1, поэтому кириллица
// приходит «кракозябрами» и sanitizeFileName превращает её в подчёркивания
// (тест.txt → ________.txt). Перекодируем latin1→utf8 (для ASCII — без изменений).
// Если после перекодировки получились «замещающие» символы (U+FFFD), значит строка
// не была latin1-мисдекодом — возвращаем как есть, чтобы ничего не испортить.
function decodeUploadFileName(originalname) {
    const raw = String(originalname || '');
    try {
        const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
        return utf8.includes('\uFFFD') ? raw : utf8;
    } catch (e) {
        return raw;
    }
}

module.exports = {
    sanitizeFolderName,
    sanitizeFileName,
    formatContactName,
    getLinkedId,
    listFiles,
    generateClientId,
    findExistingProjectFolder,
    parsePositiveInt,
    checkSecret,
    buildJunctionReplaceSql,
    buildProjectFolderName,
    parseClientFolderId,
    errorHttpStatus,
    decodeUploadFileName
};
