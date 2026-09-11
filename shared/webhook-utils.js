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

module.exports = {
    sanitizeFolderName,
    sanitizeFileName,
    formatContactName,
    getLinkedId,
    listFiles,
    generateClientId,
    findExistingProjectFolder
};
