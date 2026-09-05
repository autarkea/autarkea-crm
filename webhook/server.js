require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { execFileSync } = require('child_process');

const app = express();
app.use(express.json());

// Multer для загрузки файлов (в память, потом сохраняем сами)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// 🎨 Раздача общих стилей
app.use('/shared-styles.css', express.static(path.join(__dirname, 'templates/shared-styles.css')));

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ================== ЗАЩИТА ЭНДПОИНТОВ ==================
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

function requireSecret(req, res, next) {
    const secret = req.query?.secret || req.body?.secret;

    // v4.27.3 (fail-closed): нет секрета в .env — НЕ открываем роуты.
    // Раньше было fail-open («пропускаем проверку») — при ручной установке (плейсхолдер
    // your_secret_here) или потере строки в .env все защищённые роуты были открыты всем.
    if (!WEBHOOK_SECRET) {
        console.error('❌ WEBHOOK_SECRET не установлен в .env — все защищённые роуты закрыты. Проверь .env и перезапусти setup-formulas.sh');
        return res.status(503).json({ error: 'Сервис не настроен: WEBHOOK_SECRET отсутствует в .env' });
    }

    if (secret !== WEBHOOK_SECRET) {
        console.log(`❌ Попытка доступа без секретного ключа: ${req.path} (IP: ${req.ip})`);
        return res.status(403).json({ error: 'Неверный секретный ключ' });
    }
    next();
}

const PORT = 3001;
const NOCO_URL = process.env.NOCO_URL || 'http://nocodb:8080';
const NOCO_TOKEN = process.env.NOCO_TOKEN;
const BASE_ID = process.env.BASE_ID;
const TABLE_PROJECTS = process.env.TABLE_PROJECTS;
const TABLE_CONTACTS = process.env.TABLE_CONTACTS;
const TABLE_LEGAL_ENTITIES = process.env.TABLE_LEGAL_ENTITIES;
const TABLE_DOCUMENTS = process.env.TABLE_DOCUMENTS;

const PROJECTS_ROOT = '/mnt/data/projects';
const CLIENTS_ROOT = '/mnt/data/clients';
const PDF_DIR = '/mnt/data/noco-static/pdfs';
const NOCO_TIMEOUT = 10000; // ⏱️ Проблема 90: таймаут запросов webhook→NocoDB. Без него зависшая NocoDB вешает /upload-file → бот получает «timeout of 30000ms exceeded»

// ================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==================

// 🆕 УМНАЯ ОЧИСТКА ИМЕН ДЛЯ ФАЙЛОВОЙ СИСТЕМЫ (защита от ENAMETOOLONG)
function sanitizeFolderName(name, maxLength = 50) {
    if (!name) return 'Без названия';
    
    // 1. Заменяем переносы строк на пробелы
    let clean = String(name).replace(/[\r\n]+/g, ' ');
    
    // 2. Удаляем опасные символы для файловой системы
    clean = clean.replace(/[\/\\:*?<>|@"']/g, '');
    
    // 3. Убираем лишние пробелы
    clean = clean.replace(/\s+/g, ' ').trim();
    
    // 4. Обрезаем до безопасной длины (с учетом многоточия)
    if (clean.length > maxLength) {
        clean = clean.substring(0, maxLength - 3).trim() + '...';
    }
    
    // 5. Финальная проверка (если после очистки строка пустая)
    if (!clean || clean === '...') {
        clean = 'Без названия';
    }
    
    return clean;
}

function generateClientId() {
    const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + crypto.randomInt(26))).join('');
    const digits = crypto.randomInt(1000).toString().padStart(3, '0');
    return `${letters}${digits}`;
}

function formatContactName(name) {
    if (!name) return '';
    return name.replace(/@(\w+)/g, '($1)');
}

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

function getLinkedId(fieldData) {
    if (!fieldData) return null;
    if (Array.isArray(fieldData) && fieldData.length > 0) return fieldData[0]?.Id || null;
    if (typeof fieldData === 'object' && fieldData !== null) return fieldData.Id || null;
    if (typeof fieldData === 'string' || typeof fieldData === 'number') return fieldData;
    return null;
}

// 🆕 УМНЫЙ ПОИСК СУЩЕСТВУЮЩЕЙ ПАПКИ (Защита от коллизий ID)
function findExistingProjectFolder(projectId, expectedProjName, expectedClientName) {
    if (!fs.existsSync(PROJECTS_ROOT)) return null;
    
    const folders = fs.readdirSync(PROJECTS_ROOT);
    // 🔍 Ищем папку с ID в начале имени, допуская разные разделители:
    // "123 - Имя", "123-Имя", "123_Имя" — чтобы распознать папку даже после ручного переименования
    // (раньше жёсткий префикс "123 - " пропускал переименованную вручную папку → дубликат)
    const idPattern = new RegExp(`^${projectId}[ -_]`);
    const matchingFolders = folders.filter(f => idPattern.test(f));
    
    if (matchingFolders.length === 0) return null;
    
    if (matchingFolders.length === 1) {
        const folder = matchingFolders[0];
        // Проверяем, не изменилось ли имя клиента в названии папки
        const parts = folder.split(' - ');
        const folderClientName = parts.length > 2 ? parts[parts.length - 1] : '';
        
        if (folderClientName && folderClientName !== expectedClientName) {
            console.log(`⚠️ ВНИМАНИЕ: Клиент в NocoDB изменён! В папке: "${folderClientName}", в NocoDB: "${expectedClientName}"`);
            console.log(`💡 Используем существующую папку, чтобы не сломать файлы. Переименуйте вручную при необходимости.`);
        }
        return path.join(PROJECTS_ROOT, folder);
    }
    
    // Если найдено несколько папок с одним ID (аномалия)
    console.log(`❌ КРИТИЧЕСКАЯ ОШИБКА: Найдено ${matchingFolders.length} папок с ID=${projectId}!`);
    return path.join(PROJECTS_ROOT, matchingFolders[0]); // Возвращаем первую как наименее разрушительный fallback
}

// Получаем данные проекта и формируем путь к папке
async function getProjectFolderPath(projectId) {
    // 1. Получаем данные проекта
    const projectRes = await axios.get(`${NOCO_URL}/api/v1/db/data/noco/${BASE_ID}/${TABLE_PROJECTS}/${projectId}`, {
        headers: { 'xc-token': NOCO_TOKEN },
        timeout: NOCO_TIMEOUT
    });
    const project = projectRes.data;

    // 2. Извлекаем ID
    const contactId = getLinkedId(project['Контакт']);
    const legalEntityId = getLinkedId(project['Юрлицо']);

    // 3. 🛡️ ВАЛИДАЦИЯ: Блокируем создание папки без клиента (решение v4.16.1 после ревью:
    // папка «- Без клиента» не переименовывается при привязке клиента автоматически и
    // создаёт ручную возню + ломает симлинки. Проект без клиента создаётся в боте,
    // а папка — после привязки Контакта или Юрлица).
    if (!contactId && !legalEntityId) {
        throw new Error('❌ Не указан клиент!\n\n💡 Заполните поле "Юрлицо" или "Контакт" в карточке проекта перед созданием папки.');
    }

    let legalEntityName = '';
    let contactName = '';
    let clientId = null;

    // 4. Получаем полные данные для надёжного извлечения "Краткое Имя" и Client ID
    if (legalEntityId) {
        try {
            const leRes = await axios.get(`${NOCO_URL}/api/v1/db/data/noco/${BASE_ID}/${TABLE_LEGAL_ENTITIES}/${legalEntityId}`, {
                headers: { 'xc-token': NOCO_TOKEN },
                timeout: NOCO_TIMEOUT
            });
            const le = leRes.data;
            // 🎯 Приоритет: Краткое Имя → Имя
            legalEntityName = le['Краткое Имя'] || le['Краткое_Имя'] || le['Имя'] || '';
            clientId = le['Client ID'] || null;
            
            if (!clientId) {
                clientId = generateClientId();
                await axios.patch(`${NOCO_URL}/api/v1/db/data/noco/${BASE_ID}/${TABLE_LEGAL_ENTITIES}/${legalEntityId}`, {
                    'Client ID': clientId
                }, { headers: { 'xc-token': NOCO_TOKEN }, timeout: NOCO_TIMEOUT });
                console.log(`🆕 Сгенерирован Client ID для юрлица: ${clientId}`);
            }
        } catch (err) {
            console.error(`❌ Ошибка загрузки юрлица ${legalEntityId}: ${err.message}`);
        }
    } 
    
    if (contactId) {
        try {
            const cRes = await axios.get(`${NOCO_URL}/api/v1/db/data/noco/${BASE_ID}/${TABLE_CONTACTS}/${contactId}`, {
                headers: { 'xc-token': NOCO_TOKEN },
                timeout: NOCO_TIMEOUT
            });
            const c = cRes.data;
            contactName = formatContactName(c['Имя'] || '');
            
            // Если юрлица нет, берем Client ID из контакта
            if (!legalEntityId) {
                clientId = c['Client ID'] || null;
                if (!clientId) {
                    clientId = generateClientId();
                    await axios.patch(`${NOCO_URL}/api/v1/db/data/noco/${BASE_ID}/${TABLE_CONTACTS}/${contactId}`, {
                        'Client ID': clientId
                    }, { headers: { 'xc-token': NOCO_TOKEN }, timeout: NOCO_TIMEOUT });
                    console.log(`🆕 Сгенерирован Client ID для контакта: ${clientId}`);
                }
            }
        } catch (err) {
            console.error(`❌ Ошибка загрузки контакта ${contactId}: ${err.message}`);
        }
    }

    // 5. Определяем итоговое имя клиента для папки
    const rawClientName = legalEntityName || contactName || 'Без клиента';
    const rawProjName = project['Что делаем?'] || `Проект_${projectId}`;
    
    // 🆕 БЕЗОПАСНАЯ ОЧИСТКА ИМЕН (защита от ENAMETOOLONG)
    const safeClientName = sanitizeFolderName(rawClientName, 40);
    const safeProjName = sanitizeFolderName(rawProjName, 60);
    
    const expectedFolderName = `${projectId} - ${safeProjName} - ${safeClientName}`;

    // 6. 🛡️ ПРОВЕРКА НА СУЩЕСТВОВАНИЕ (Защита от дубликатов при смене клиента)
    const existingPath = findExistingProjectFolder(projectId, safeProjName, safeClientName);
    
    if (existingPath) {
        console.log(`🔄 Найдена существующая папка: ${existingPath}`);
        return {
            project, projName: safeProjName, clientName: safeClientName, contactName, legalEntityName, clientId,
            folderPath: existingPath,
            isExisting: true
        };
    }

    // 7. Если папки нет, возвращаем путь для создания новой
    return {
        project, projName: safeProjName, clientName: safeClientName, contactName, legalEntityName, clientId,
        folderPath: path.join(PROJECTS_ROOT, expectedFolderName),
        isExisting: false
    };
}

function createClientFolderAndSymlink(clientId, clientName, projectId, projName, projectFolderPath) {
    if (!clientId) return;

    const existingFolders = fs.existsSync(CLIENTS_ROOT) ? fs.readdirSync(CLIENTS_ROOT) : [];
    const safeClientName = sanitizeFolderName(clientName, 40);
    
    const matchingFolder = existingFolders.find(f => {
        const match = f.match(/^(.+)\s+\(([A-Z0-9]{6})\)$/);
        return match && match[1] === safeClientName;
    });

    let clientFolderPath;
    let actualClientId = clientId;

    if (matchingFolder) {
        const match = matchingFolder.match(/\(([A-Z0-9]{6})\)$/);
        if (match) {
            actualClientId = match[1];
            if (actualClientId !== clientId) {
                console.log(`🔒 Client ID в NocoDB изменён (${clientId} → ${actualClientId}), используем ID из папки`);
            }
        }
        clientFolderPath = path.join(CLIENTS_ROOT, matchingFolder);
    } else {
        const clientFolderName = `${safeClientName} (${clientId})`;
        clientFolderPath = path.join(CLIENTS_ROOT, clientFolderName);
        fs.mkdirSync(clientFolderPath, { recursive: true });
        fs.chmodSync(clientFolderPath, 0o755);
        console.log(`📁 Создана папка клиента: ${clientFolderPath}`);
    }

    const safeProjName = sanitizeFolderName(projName, 60);
    const symlinkName = `${projectId} - ${safeProjName}`;
    const symlinkPath = path.join(clientFolderPath, symlinkName);

    if (!fs.existsSync(symlinkPath)) {
        try {
            fs.symlinkSync(projectFolderPath, symlinkPath, 'dir');
            console.log(`🔗 Создан symlink: ${symlinkPath} → ${projectFolderPath}`);
        } catch (err) {
            console.error(`❌ Ошибка создания symlink: ${err.message}`);
        }
    }
}

// 🆕 УМНАЯ СИНХРОНИЗАЦИЯ ДОКУМЕНТОВ (PDF) с надёжной JS-фильтрацией M2M
async function syncProjectDocuments(projectId, projectFolderPath) {
    const docsFolder = path.join(projectFolderPath, 'Документы');
    
    if (!fs.existsSync(PDF_DIR)) {
        console.log('⚠️ Папка с PDF не найдена, пропускаем синхронизацию');
        return;
    }

    try {
        // 1. Загружаем последние документы из NocoDB (с запасом)
        const docsRes = await axios.get(`${NOCO_URL}/api/v1/db/data/noco/${BASE_ID}/${TABLE_DOCUMENTS}`, {
            headers: { 'xc-token': NOCO_TOKEN },
            timeout: NOCO_TIMEOUT,
            params: { 
                sort: '-CreatedAt', // Сортируем по убыванию даты создания
                limit: 200          // Берём с запасом на случай большого количества документов
            }
        });
        
        const allDocs = docsRes.data.list || [];
        console.log(`📄 Загружено последних документов из NocoDB: ${allDocs.length}`);

        // 2. 🎯 НАДЁЖНАЯ JS-ФИЛЬТРАЦИЯ M2M связи
        // NocoDB CE под капотом использует M2M даже для связей Many-to-One,
        // поэтому API-фильтр where=(Проект,eq,X) часто возвращает 0 результатов.
        // Решение: загружаем пакет и фильтруем в коде (best practice для NocoDB CE).
        const projectDocs = allDocs.filter(doc => {
            // Вариант А: NocoDB иногда "сплющивает" M2M в объект первой связанной записи
            if (doc['Проект'] && doc['Проект']['Id'] == projectId) {
                return true;
            }
            // Вариант Б: Полная M2M структура (как в нашем template.db)
            if (doc['nc_nw7q___nc_m2m_Документы_Проектыs'] && Array.isArray(doc['nc_nw7q___nc_m2m_Документы_Проектыs'])) {
                return doc['nc_nw7q___nc_m2m_Документы_Проектыs'].some(link => 
                    link['Проекты'] && link['Проекты']['Id'] == projectId
                );
            }
            return false;
        });

        console.log(`🎯 Найдено документов, привязанных к проекту ${projectId}: ${projectDocs.length}`);

        // Если документов нет — выходим сразу, не читая папку PDF
        if (projectDocs.length === 0) {
            console.log(`ℹ️ Для проекта ${projectId} документов не найдено, пропускаем синхронизацию`);
            return;
        }

        let syncedCount = 0;
        const allFilesInPdfDir = fs.readdirSync(PDF_DIR);

        // 3. Создаём симлинки для найденных документов
        for (const doc of projectDocs) {
            const docId = doc.Id;
            // 🆕 Гибкий regex: ищет дефис ИЛИ подчёркивание перед ID документа
            const regex = new RegExp(`.*[-_]${docId}(?:_notsigned)?\\.pdf$`);
            const matchingPdf = allFilesInPdfDir.find(f => regex.test(f));

            if (matchingPdf) {
                const sourcePath = path.join(PDF_DIR, matchingPdf);
                const symlinkPath = path.join(docsFolder, matchingPdf);

                if (!fs.existsSync(symlinkPath)) {
                    try {
                        fs.symlinkSync(sourcePath, symlinkPath);
                        console.log(`🔗 Создан symlink документа: ${matchingPdf}`);
                        syncedCount++;
                    } catch (err) {
                        console.error(`❌ Ошибка создания symlink для ${matchingPdf}: ${err.message}`);
                    }
                } else {
                    console.log(`ℹ️ Симлинк уже существует: ${matchingPdf}`);
                }
            } else {
                console.log(`⚠️ PDF для документа ID=${docId} не найден в ${PDF_DIR}. Имя файла не совпало с regex.`);
            }
        }
        console.log(`✅ Синхронизировано ${syncedCount} документов в папку 'Документы'`);
    } catch (err) {
        console.error(`❌ Ошибка синхронизации документов: ${err.message}`);
    }
}

// ================== РОУТ: СОЗДАТЬ ПАПКУ ==================
app.all('/create-folder', requireSecret, async (req, res) => {
    try {
        const projectId = req.query.docId || req.body?.Id || req.body?.id || req.body?.rowId || req.body?.recordId;
        console.log('📦 Получен запрос. ID:', projectId, 'Method:', req.method);

        if (!projectId) {
            return res.status(400).send(getErrorHTML('Id проекта не найден. Используйте ?docId=123 в URL'));
        }

        const { projName, clientName, contactName, legalEntityName, clientId, folderPath, isExisting } = await getProjectFolderPath(projectId);

        if (isExisting) {
            console.log(`ℹ️ Используем существующую папку: ${folderPath}`);
        }

        // 🛡️ ГАРАНТИЯ: Создаем папку и подпапки, если их нет (даже если основная папка уже существовала)
        // 🔒 Права: каркас 0755 (только владелец пишет), Рабочие 0775 (песочница для записи), Документы 0755 (только чтение)
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
            fs.chmodSync(folderPath, 0o755);
            console.log(`✅ Создана папка проекта: ${folderPath}`);
        } else {
            // Если папка существовала — приводим права к безопасной схеме
            fs.chmodSync(folderPath, 0o755);
        }

        const workingDir = path.join(folderPath, 'Рабочие');
        const docsDir = path.join(folderPath, 'Документы');

        if (!fs.existsSync(workingDir)) {
            fs.mkdirSync(workingDir, { recursive: true });
            fs.chmodSync(workingDir, 0o775);
        } else {
            fs.chmodSync(workingDir, 0o775);
        }
        if (!fs.existsSync(docsDir)) {
            fs.mkdirSync(docsDir, { recursive: true });
            fs.chmodSync(docsDir, 0o755);
        } else {
            fs.chmodSync(docsDir, 0o755);
        }

        createClientFolderAndSymlink(clientId, clientName, projectId, projName, folderPath);
        await syncProjectDocuments(projectId, folderPath);

        const fileList = listFiles(folderPath);
        const fieldText = `📁 Путь: ${folderPath}\n\n📄 Содержимое:\n${fileList}`;

        await axios.patch(`${NOCO_URL}/api/v1/db/data/noco/${BASE_ID}/${TABLE_PROJECTS}/${projectId}`, {
            'Файлы в папке': fieldText
        }, { headers: { 'xc-token': NOCO_TOKEN }, timeout: NOCO_TIMEOUT });

        if (req.method === 'GET') {
            res.send(getSuccessHTML(projectId, projName, contactName, legalEntityName, folderPath, !isExisting, isExisting));
        } else {
            res.json({ 
                success: true, 
                message: isExisting ? 'Используется существующая папка' : 'Папка создана', 
                path: folderPath 
            });
        }

    } catch (error) {
        console.error('❌ Ошибка вебхука:', error.message);
        res.status(500).send(getErrorHTML(error.message));
    }
});

// ================== РОУТ: ОБНОВИТЬ СПИСОК ФАЙЛОВ ==================
app.all('/refresh-files', requireSecret, async (req, res) => {
    try {
        const projectId = req.query.docId || req.body?.Id || req.body?.id;
        console.log('🔄 Обновление файлов и документов для проекта ID:', projectId);

        if (!projectId) {
            return res.status(400).send(getErrorHTML('Id проекта не найден. Используйте ?docId=123 в URL'));
        }

        // Пробуем получить путь — если нет клиента, будет ошибка
        // 🎨 Отдаём HTML-страницу ошибки (как /create-folder), а не сырой JSON,
        // чтобы при открытии URL кнопкой NocoDB в браузере показывалась красивая ошибка
        let folderPath;
        try {
            const result = await getProjectFolderPath(projectId);
            folderPath = result.folderPath;
        } catch (e) {
            return res.status(400).send(getErrorHTML(e.message));
        }

        if (!fs.existsSync(folderPath)) {
            return res.status(404).send(getErrorHTML(`Папка не найдена: ${folderPath}. Сначала создайте папку.`));
        }

        // Гарантия наличия подпапок
        const docsDir = path.join(folderPath, 'Документы');
        if (!fs.existsSync(docsDir)) {
            fs.mkdirSync(docsDir, { recursive: true });
            fs.chmodSync(docsDir, 0o755);
        } else {
            fs.chmodSync(docsDir, 0o755);
        }

        await syncProjectDocuments(projectId, folderPath);

        const fileList = listFiles(folderPath);
        const fieldText = `📁 Путь: ${folderPath}\n\n📄 Содержимое:\n${fileList}`;

        await axios.patch(`${NOCO_URL}/api/v1/db/data/noco/${BASE_ID}/${TABLE_PROJECTS}/${projectId}`, {
            'Файлы в папке': fieldText
        }, { headers: { 'xc-token': NOCO_TOKEN }, timeout: NOCO_TIMEOUT });

        if (req.method === 'GET') {
            res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Обновлено ✅</title>
<link rel="stylesheet" href="/shared-styles.css">
<style>body { background: var(--success-gradient); } h1 { color: var(--success-color); } .info-box { border-left-color: var(--success-color); } .btn { background: var(--success-gradient); }</style>
</head><body><div class="container"><div class="icon">📂</div><h1>Файлы и документы обновлены</h1>
<div class="info-box" style="background: #d4edda; border-left-color: #28a745;"><h3 style="color: #155724;">✅ Статус</h3>
<p style="color: #155724;">Список файлов синхронизирован, новые PDF-документы добавлены в папку "Документы".</p></div>
<p class="auto-close">Эта вкладка закроется автоматически через 3 секунды...</p></div>
<script>setTimeout(() => { window.close(); }, 3000);</script></body></html>`);
        } else {
            res.json({ success: true, message: 'Список файлов и документов обновлён' });
        }

    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        res.status(500).send(getErrorHTML(error.message));
    }
});

// ================== HTML СТРАНИЦЫ ==================
function getSuccessHTML(projectId, projName, contactName, legalEntityName, folderPath, isNewFolder, isExisting) {
    let title, icon, subtitle, themeColor, themeGradient;
    
    if (isExisting) {
        title = 'Используется существующая папка';
        icon = '🔄';
        subtitle = 'Папка уже была создана ранее';
        themeColor = 'var(--primary-color)';
        themeGradient = 'var(--primary-gradient)';
    } else if (isNewFolder) {
        title = 'Папка проекта создана';
        icon = '📁';
        subtitle = 'Проект подготовлен к работе';
        themeColor = 'var(--success-color)';
        themeGradient = 'var(--success-gradient)';
    } else {
        title = 'Папка проекта уже существует';
        icon = 'ℹ️';
        subtitle = 'Папка уже была создана ранее';
        themeColor = 'var(--primary-color)';
        themeGradient = 'var(--primary-gradient)';
    }

    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title><link rel="stylesheet" href="/shared-styles.css">
<style>body { background: ${themeGradient}; } h1 { color: ${themeColor}; } .info-box { border-left-color: ${themeColor}; }</style>
</head><body><div class="container"><div class="icon">${icon}</div><h1>${title}</h1><p class="subtitle">${subtitle}</p>
<div class="info-box"><h3>📋 Название проекта</h3><p><strong>${projName}</strong></p></div>
<div class="info-box"><h3>👤 Клиент</h3><p>${contactName}${legalEntityName ? ` (${legalEntityName})` : ''}</p></div>
<div class="info-box"><h3>📂 Путь к папке</h3><p><code style="background: var(--bg-light); padding: 4px 8px; border-radius: 4px; font-family: monospace;">${folderPath}</code></p></div>
<div style="display: flex; justify-content: space-around; margin: 20px 0; flex-wrap: wrap; gap: 10px;">
    <div class="folder-item" style="background: var(--primary-color); color: white; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 500;">📂 Рабочие</div>
    <div class="folder-item" style="background: var(--primary-color); color: white; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 500;">📑 Документы</div>
</div>
<p class="auto-close">Эта вкладка закроется автоматически через 3 секунды...</p></div>
<script>setTimeout(() => { window.close(); }, 3000);</script></body></html>`;
}

function getErrorHTML(errorMessage) {
    // Заменяем переносы строк на <br> для красивого отображения в HTML
    const formattedMessage = errorMessage.replace(/\n/g, '<br>');
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Ошибка ❌</title>
<link rel="stylesheet" href="/shared-styles.css">
<style>body { background: var(--error-gradient); } h1 { color: var(--error-color); } .info-box { background: #fee; border-left-color: var(--error-color); } .btn { background: var(--error-color); }</style>
</head><body><div class="container"><div class="icon">❌</div><h1>Ошибка</h1>
<div class="info-box"><h3>🔍 Детали ошибки</h3><p>${formattedMessage}</p></div>
<a href="javascript:window.close();" class="btn">Закрыть вкладку</a></div></body></html>`;
}

// ================== РОУТ: ПЕРЕДАЧА ПРОЕКТА ДРУГОМУ МЕНЕДЖЕРУ (v4.18.0) ==================
// NocoDB CE не умеет обновлять связи через API (PATCH Link-поля игнорируется), поэтому
// правим junction-таблицу nc_m2m_Проекты_Сотрудники напрямую через sqlite3 CLI.
// БД доступна через read-only volume /mnt/data/nocodb-data. Поле «Менеджер» — это
// Many-to-One, физически реализованный как M2M через junction-таблицу.
const NOCO_DB_PATH = '/mnt/data/nocodb-data/noco.db';
const JUNCTION_PROJECT_EMPLOYEE = 'nc_nw7q___nc_m2m_Проекты_Сотрудники';
// v4.25.0: junction-таблицы для привязки клиента к существующему проекту
// (NocoDB CE не умеет PATCH Link-полей, поэтому правим напрямую, как /transfer-project).
const JUNCTION_PROJECT_CONTACT = 'nc_nw7q___nc_m2m_Проекты_Контакты';
const JUNCTION_PROJECT_LEGAL = 'nc_nw7q___nc_m2m_Проекты_Юрлица';
// v4.43.0: junction «Контакты ↔ Юрлица» (поле «Организация» в карточке контакта).
// NocoDB CE не умеет PATCH Link-полей — правим напрямую, как /attach-client.
const JUNCTION_CONTACT_LEGAL = 'nc_nw7q___nc_m2m_Контакты_Юрлица';

app.post('/transfer-project', requireSecret, async (req, res) => {
    try {
        const projectId = parseInt(req.body.projectId);
        const newManagerId = parseInt(req.body.newManagerId);
        if (!Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(newManagerId) || newManagerId <= 0) {
            return res.status(400).json({ error: 'projectId и newManagerId обязательны' });
        }
        if (!fs.existsSync(NOCO_DB_PATH)) {
            return res.status(500).json({ error: 'Файл БД NocoDB недоступен (нет volume?)' });
        }

        // Транзакция: убираем все связи проекта с сотрудниками и ставим нового менеджера.
        // Числа подставляем напрямую — они валидированы Number.isInteger (только цифры, инъекция невозможна).
        const sql = [
            'BEGIN IMMEDIATE;',
            `DELETE FROM "${JUNCTION_PROJECT_EMPLOYEE}" WHERE "nc_nw7q___Проекты_id" = ${projectId};`,
            `INSERT INTO "${JUNCTION_PROJECT_EMPLOYEE}" ("nc_nw7q___Сотрудники_id", "nc_nw7q___Проекты_id") VALUES (${newManagerId}, ${projectId});`,
            'COMMIT;'
        ].join('\n');

        execFileSync('sqlite3', [NOCO_DB_PATH, sql], { timeout: 10000 });
        console.log(`✅ Проект #${projectId} передан менеджеру #${newManagerId}`);
        return res.json({ success: true });
    } catch (err) {
        console.error('❌ Ошибка передачи проекта:', err.message);
        return res.status(500).json({ error: `Ошибка передачи: ${err.message}` });
    }
});

// ================== РОУТ: ПРИВЯЗКА КЛИЕНТА К ПРОЕКТУ (v4.25.0) ==================
// NocoDB CE не умеет обновлять связи через API (PATCH Link-поля игнорируется), поэтому
// правим junction-таблицы nc_m2m_Проекты_Контакты и nc_m2m_Проекты_Юрлица напрямую.
// Выбор клиента взаимоисключающий (приоритет документов — Юрлицо → Контакт): при привязке
// одного — связь с другим снимается.
app.post('/attach-client', requireSecret, async (req, res) => {
    try {
        const projectId = parseInt(req.body.projectId);
        const contactId = req.body.contactId ? parseInt(req.body.contactId) : null;
        const legalId = req.body.legalId ? parseInt(req.body.legalId) : null;
        if (!Number.isInteger(projectId) || projectId <= 0) {
            return res.status(400).json({ error: 'projectId обязателен' });
        }
        if (!contactId && !legalId) {
            return res.status(400).json({ error: 'Укажите contactId или legalId' });
        }
        if (!fs.existsSync(NOCO_DB_PATH)) {
            return res.status(500).json({ error: 'Файл БД NocoDB недоступен (нет volume?)' });
        }

        // Транзакция: снимаем старые связи с клиентами, ставим новую.
        // Числа подставляем напрямую — валидированы Number.isInteger (инъекция невозможна).
        const sql = [
            'BEGIN IMMEDIATE;',
            `DELETE FROM "${JUNCTION_PROJECT_CONTACT}" WHERE "nc_nw7q___Проекты_id" = ${projectId};`,
            `DELETE FROM "${JUNCTION_PROJECT_LEGAL}" WHERE "nc_nw7q___Проекты_id" = ${projectId};`,
            ...(contactId ? [`INSERT INTO "${JUNCTION_PROJECT_CONTACT}" ("nc_nw7q___Контакты_id", "nc_nw7q___Проекты_id") VALUES (${contactId}, ${projectId});`] : []),
            ...(legalId ? [`INSERT INTO "${JUNCTION_PROJECT_LEGAL}" ("nc_nw7q___Юрлица_id", "nc_nw7q___Проекты_id") VALUES (${legalId}, ${projectId});`] : []),
            'COMMIT;'
        ].join('\n');

        execFileSync('sqlite3', [NOCO_DB_PATH, sql], { timeout: 10000 });
        console.log(`✅ Проект #${projectId} привязан к клиенту (contact=${contactId}, legal=${legalId})`);
        return res.json({ success: true });
    } catch (err) {
        console.error('❌ Ошибка привязки клиента:', err.message);
        return res.status(500).json({ error: `Ошибка привязки клиента: ${err.message}` });
    }
});


// ================== РОУТ: ПРИВЯЗКА КОНТАКТА К ЮРЛИЦУ (v4.43.0) ==================
// Кнопки «🏢 Привязать юрлицо / 🔄 Сменить юрлицо / ❌ Отвязать» в карточке контакта.
// Поле «Организация» контакта физически — junction-таблица Контакты_Юрлица,
// PATCH Link-полей NocoDB CE не умеет (Known Limitation 13.1) — правим напрямую.
// Привязка = снять ВСЕ организации контакта и поставить одну (у контакта один
// работодатель); смена = та же привязка нового; отвязка = DELETE без INSERT.
// SQL-инъекция невозможна: id валидируются Number.isInteger (числа подставляются).
app.post('/set-contact-org', requireSecret, async (req, res) => {
    try {
        const contactId = parseInt(req.body.contactId);
        const legalId = req.body.legalId ? parseInt(req.body.legalId) : 0;
        if (!Number.isInteger(contactId) || contactId <= 0 || (req.body.legalId && (!Number.isInteger(legalId) || legalId <= 0))) {
            return res.status(400).json({ error: 'contactId обязателен, legalId должен быть положительным числом' });
        }
        if (!fs.existsSync(NOCO_DB_PATH)) {
            return res.status(500).json({ error: 'Файл БД NocoDB недоступен (нет volume?)' });
        }

        const sql = [
            'BEGIN IMMEDIATE;',
            `DELETE FROM "${JUNCTION_CONTACT_LEGAL}" WHERE "nc_nw7q___Контакты_id" = ${contactId};`,
            ...(legalId > 0 ? [`INSERT INTO "${JUNCTION_CONTACT_LEGAL}" ("nc_nw7q___Юрлица_id", "nc_nw7q___Контакты_id") VALUES (${legalId}, ${contactId});`] : []),
            'COMMIT;'
        ].join('\n');

        execFileSync('sqlite3', [NOCO_DB_PATH, sql], { timeout: 10000 });
        console.log(`✅ Контакт #${contactId} ${legalId > 0 ? `привязан к юрлицу #${legalId}` : 'отвязан от юрлица'}`);
        return res.json({ success: true });
    } catch (err) {
        console.error('❌ Ошибка привязки контакта к юрлицу:', err.message);
        return res.status(500).json({ error: `Ошибка привязки контакта к юрлицу: ${err.message}` });
    }
});


// ================== РОУТ: ЗАГРУЗКА ФАЙЛА К ЗАДАЧЕ ==================
app.post('/upload-file', upload.single('file'), async (req, res) => {
    try {
        // Проверяем секрет вручную (multer парсит body после requireSecret)
        // v4.27.3 (fail-closed): секрет обязателен — нет секрета в .env = сервис не настроен.
        const secret = req.query?.secret || req.body?.secret;
        if (!WEBHOOK_SECRET) {
            console.error('❌ WEBHOOK_SECRET не установлен в .env — /upload-file закрыт. Проверь .env.');
            return res.status(503).json({ error: 'Сервис не настроен: WEBHOOK_SECRET отсутствует в .env' });
        }
        if (secret !== WEBHOOK_SECRET) {
            return res.status(403).json({ error: 'Неверный секретный ключ' });
        }

        const taskId = req.body.taskId;
        const projectId = req.body.projectId;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'file обязателен' });
        }

        let targetProjectId = projectId;

        // Если передан taskId — находим проект через задачу
        if (taskId) {
            const taskRes = await axios.get(`${NOCO_URL}/api/v1/db/data/noco/${BASE_ID}/${process.env.TABLE_TASKS}/${taskId}`, {
                headers: { 'xc-token': NOCO_TOKEN },
                timeout: NOCO_TIMEOUT
            });
            const task = taskRes.data;
            const projectField = task['Какой проект'];
            targetProjectId = Array.isArray(projectField) ? projectField[0]?.Id : projectField?.Id;

            if (!targetProjectId) {
                return res.status(400).json({ error: 'Задача не привязана к проекту. Файл некуда сохранить.' });
            }
        }

        if (!targetProjectId) {
            return res.status(400).json({ error: 'projectId или taskId обязателен' });
        }

        // Диагностика (Проблема 90): логируем приём запроса — раньше до сохранения файла
        // не было ни одного лога, зависшие запросы было невозможно диагностировать.
        console.log(`📥 /upload-file: projectId=${targetProjectId}${taskId ? `, taskId=${taskId}` : ''}, file=${file.originalname} (${file.size} байт)`);

        const { folderPath } = await getProjectFolderPath(targetProjectId);
        const workingDir = path.join(folderPath, 'Рабочие');

        // Создаём папку проекта и подпапки если нет
        // 🔒 Права: каркас 0755, Рабочие 0775 (песочница), Документы 0755 (только чтение)
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
            fs.chmodSync(folderPath, 0o755);
            console.log(`✅ Создана папка проекта: ${folderPath}`);
        } else {
            fs.chmodSync(folderPath, 0o755);
        }
        if (!fs.existsSync(workingDir)) {
            fs.mkdirSync(workingDir, { recursive: true });
            fs.chmodSync(workingDir, 0o775);
        } else {
            fs.chmodSync(workingDir, 0o775);
        }
        const docsDir = path.join(folderPath, 'Документы');
        if (!fs.existsSync(docsDir)) {
            fs.mkdirSync(docsDir, { recursive: true });
            fs.chmodSync(docsDir, 0o755);
        } else {
            fs.chmodSync(docsDir, 0o755);
        }

        // Санитайз имени файла
        const safeName = file.originalname.replace(/[^a-zA-Z0-9а-яА-ЯёЁ._ -]/g, '_');

        // ♻️ Идемпотентность (Проблема 91): при ретрае после частичного успеха
        // (файл записан, но ответ/последующий шаг упали) не создаём дубль — если файл
        // с таким именем и размером уже лежит в папке, возвращаем его.
        let destPath = null;
        if (fs.existsSync(workingDir)) {
            const existing = fs.readdirSync(workingDir).find(f => f.endsWith(`_${safeName}`));
            if (existing) {
                const existingPath = path.join(workingDir, existing);
                try {
                    if (fs.statSync(existingPath).size === file.size) destPath = existingPath;
                } catch (e) { /* файл пропал между readdir и stat — запишем заново */ }
            }
        }

        if (!destPath) {
            destPath = path.join(workingDir, `${Date.now()}_${safeName}`);
            fs.writeFileSync(destPath, file.buffer);
            fs.chmodSync(destPath, 0o664);
        } else {
            console.log(`♻️ Идемпотентность: файл уже существует, возвращаю: ${destPath}`);
        }

        // НЕ вызываем syncProjectDocuments (Проблема 91): файл ложится в «Рабочие»,
        // а синхронизация крутит папку «Документы» (запрос 200 документов в NocoDB)
        // и НЕ обновляет поле «Файлы в папке» (это делает /refresh-files). Раньше каждая
        // загрузка на финальном шаге зависела от скорости NocoDB.

        console.log(`✅ Файл сохранён: ${destPath}`);
        res.json({ success: true, path: destPath, fileName: safeName, projectId: targetProjectId });
    } catch (error) {
        console.error('❌ Ошибка загрузки файла:', error.message);
        // «Не указан клиент» — ошибка клиента (400), а не серверная (500):
        // бот не должен ретраить гарантированную ошибку.
        const status = error.message.includes('Не указан клиент') ? 400 : 500;
        res.status(status).json({ error: error.message });
    }
});

// ================== ОБРАБОТКА ОШИБОК MULTER/EXPRESS (Проблема 91) ==================
// Multer бросает MulterError (LIMIT_FILE_SIZE) ДО роута — без этого хендлера express
// отдаёт дефолтный 500 вместо понятного 413 «Файл больше 50 МБ».
app.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Файл больше 50 МБ' });
    }
    if (err && err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Ошибка загрузки: ${err.message}` });
    }
    console.error('❌ Ошибка запроса:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
    console.log(`🚀 Вебхук-сервер запущен на порту ${PORT}`);
});