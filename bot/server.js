require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
// v4.37.0: единый расчёт НДС (shared/vat.js) — используется в bot.js и server.js.
const vat = require('./shared/vat');

const app = express();
app.use(express.json());

// 🖼 Пользовательские ассеты (печать организации и т.п.) имеют приоритет над эталоном:
// если файл лежит в /mnt/data/noco-static/img/ — отдаём его. Если файла нет,
// express.static сам передаёт управление дальше, к заглушкам в templates/.
// Каталог /mnt/data/noco-static вне git-репозитория — обновления его не затирают.
app.use('/img', express.static('/mnt/data/noco-static/img'));

// 🆕 РАЗДАЧА ШАБЛОНОВ БЕЗ ЗАЩИТЫ (для Puppeteer)
app.use(express.static(path.join(__dirname, "templates")));
app.use('/shared-styles.css', express.static(path.join(__dirname, 'templates/shared-styles.css')));
app.use(express.static('templates'));
app.use(express.urlencoded({ extended: true }));

// ================== ЗАЩИТА ЭНДПОИНТОВ ==================
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

function requireSecret(req, res, next) {
    const secret = req.query.secret || req.body.secret;
    // v4.27.3 (fail-closed): нет секрета в .env — НЕ открываем роуты.
    // Раньше было fail-open («пропускаем проверку») — при ручной установке (плейсхолдер
    // your_secret_here) или потере строки в .env документы и email были доступны всем.
    if (!WEBHOOK_SECRET) {
        console.error('❌ WEBHOOK_SECRET не установлен в .env — защищённые роуты закрыты. Проверь .env и перезапусти setup-formulas.sh');
        return res.status(503).send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>Сервис не настроен ⚙️</title>
<link rel="stylesheet" href="/shared-styles.css">
<style>body { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); } h1 { color: #8e44ad; } .info-box { background: #fff5f5; border-left-color: #e74c3c; } .info-box h3 { color: #c0392b; }</style>
</head><body><div class="container"><div class="icon">⚙️</div><h1>Сервис не настроен</h1>
<p class="subtitle">WEBHOOK_SECRET отсутствует в .env</p>
<div class="info-box"><h3>💡 Что делать?</h3><p>Проверьте, что WEBHOOK_SECRET задан в .env, и перезапустите setup-formulas.sh.</p></div>
<a href="javascript:window.close();" class="btn">Закрыть вкладку</a></div></body></html>`);
    }
    if (secret !== WEBHOOK_SECRET) {
        console.log(`❌ Попытка доступа без секретного ключа: ${req.path}`);
        return res.status(403).send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>Доступ запрещён 🔒</title>
<link rel="stylesheet" href="/shared-styles.css">
<style>body { background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%); } h1 { color: #c0392b; } .info-box { background: #fff5f5; border-left-color: #e74c3c; } .info-box h3 { color: #c0392b; } .btn { background: #e74c3c; }</style>
</head><body><div class="container"><div class="icon">🔒</div><h1>Доступ запрещён</h1>
<p class="subtitle">Неверный или отсутствующий секретный ключ</p>
<div class="info-box"><h3>💡 Что делать?</h3><p>Откройте документ через формулу-кнопку в NocoDB.</p></div>
<a href="javascript:window.close();" class="btn">Закрыть вкладку</a></div></body></html>`);
    }
    next();
}

// v4.43.1 (защита от stored-XSS): экранирование пользовательских данных перед
// вставкой в HTML (формы/страницы/HTML-письма). Данные приходят из NocoDB
// (контакты, юрлица, проекты, настройки) — их пишут сотрудники, но открывают
// страницы в браузере тоже люди, поэтому «сырой» HTML не должен уходить в разметку.
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const PORT = process.env.PORT || 3000;
const generatingDocs = new Set();
const NOCO_BASE_URL = `http://${process.env.WEBHOOK_HOST || 'localhost'}:3000`;
const NOCO_API_URL = `${process.env.NOCO_URL || 'http://nocodb:8080'}/api/v1/db/data/noco`;
const NOCO_API_TOKEN = process.env.NOCO_TOKEN;
const BASE_ID = process.env.BASE_ID;
// v4.28.4: таймзона для дат в документах — из .env (TZ), дефолт Минск (UTC+3).
const APP_TZ = process.env.TZ || 'Europe/Minsk';

const TABLE_DOCS = process.env.TABLE_DOCUMENTS;
const TABLE_PROJECTS = process.env.TABLE_PROJECTS;
const TABLE_ITEMS = process.env.TABLE_ITEMS;

const PDF_DIR = '/mnt/data/noco-static/pdfs';
const PROJECTS_ROOT = '/mnt/data/projects';
const DOC_TYPE_MAP = {
    'Счет': 'schet',
    'Счет (Физлицо)': 'schet-fiz',
    'Акт': 'act',
    'Акт (Физлицо)': 'act-fiz',
    'Накладная': 'nakladnaya',
    'ТН': 'nakladnaya'
};

// ================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==================
function extractId(field) {
    if (Array.isArray(field)) return field[0]?.Id || field[0];
    if (typeof field === 'object' && field !== null) return field.Id;
    return field;
}

function extractProjectId(projectField) {
    return extractId(projectField);
}

function findProjectFolder(projectId) {
    if (!fs.existsSync(PROJECTS_ROOT)) return null;
    const projects = fs.readdirSync(PROJECTS_ROOT);
    const match = projects.find(p => p.startsWith(`${projectId} -`));
    return match ? path.join(PROJECTS_ROOT, match) : null;
}

function listFilesRecursive(dir, prefix = '') {
    let result = '';
    try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
            if (item.name.startsWith('.')) continue;
            result += `${prefix}- ${item.name}${item.isDirectory() ? '/' : ''}\n`;
            if (item.isDirectory()) result += listFilesRecursive(path.join(dir, item.name), prefix + '  ');
        }
    } catch (e) { result += `${prefix}[Ошибка чтения]\n`; }
    return result;
}

async function calculateProjectTotal(projectId) {
    try {
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_ITEMS}?limit=1000`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        const items = response.data.list || [];
        let total = 0;
        for (const item of items) {
            // v4.37.0: позиции «Мат. заказчика» исключаем (в документах идут без цен) —
            // теперь код совпадает с документацией → раздел «Расчёт НДС».
            if (extractId(item['Проекты']) == projectId && !vat.isCustomerMaterial(item)) total += parseFloat(item['Сумма'] || 0);
        }
        return total;
    } catch (error) {
        console.error('Ошибка подсчёта суммы:', error.message);
        return 0;
    }
}

function getDocTypeName(type) {
    const map = { 'Счет': 'счёт-договор', 'Акт': 'акт выполненных работ', 'Накладная': 'товарную накладную', 'ТН': 'товарную накладную' };
    return map[type] || 'документ';
}

function findPDFPath(pdfFileName, projectId) {
    let pdfPath = path.join(PDF_DIR, pdfFileName);
    if (fs.existsSync(pdfPath)) return pdfPath;
    if (projectId) {
        const projectFolder = findProjectFolder(projectId);
        if (projectFolder) {
            const docsPath = path.join(projectFolder, 'Документы', pdfFileName);
            if (fs.existsSync(docsPath)) return docsPath;
        }
    }
    return null;
}

function formatDateSimple(dateStr) {
    if (!dateStr) return new Date().toLocaleDateString('ru-RU');
    const d = new Date(dateStr);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function generateDocNumber(dateStr, id) {
    const d = new Date(dateStr);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear()).slice(-2);
    return `${year}${month}${day}-${id}`;
}

// ================== SMTP НАСТРОЙКИ ==================
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// ================== ОТПРАВКА EMAIL ==================
async function sendEmailWithPDF({ toEmail, subject, text, html, pdfPath, pdfFileName, managerEmail }) {
    console.log(`📧 Отправка email на ${toEmail}...`);
    
    const replyToEmail = managerEmail || process.env.SMTP_FROM;
    const bccEmail = managerEmail || process.env.SMTP_FROM;

    const mailOptions = {
        from: `"CRM" <${process.env.SMTP_FROM}>`,
        to: toEmail,
        replyTo: replyToEmail,
        bcc: bccEmail,
        subject: subject,
        text: text,
        html: html,
        attachments: [{ filename: pdfFileName, path: pdfPath }]
    };
    
    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Email отправлен: ${info.messageId} (Reply-To: ${replyToEmail})`);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error(`❌ Ошибка отправки email:`, error.message);
        throw error;
    }
}

// ================== PDF ГЕНЕРАЦИЯ ==================
async function generatePDF(docId) {
    console.log(`\n🚀 Генерация PDF для ID=${docId}`);
    if (generatingDocs.has(docId)) {
        console.log(`⏳ ID=${docId} уже генерируется.`);
        return { error: 'Документ сейчас генерируется, попробуйте через минуту' };
    }
    generatingDocs.add(docId);
    let browser = null;

    try {
        const docRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        const doc = docRes.data;
        const docType = doc['Тип документа'];
        
        if (!docType) throw new Error('NO_DOC_TYPE');
        const htmlFile = DOC_TYPE_MAP[docType];
        if (!htmlFile) throw new Error(`❓ Неизвестный тип документа: "${docType}"`);

        const docNumber = generateDocNumber(doc['Дата документа'], docId);
        const withStamp = doc['С печатью'] === true || doc['С печатью'] === 1 || doc['С печатью'] === 'true' || doc['С печатью'] === '1';
        const suffix = withStamp ? '' : '_notsigned';
        const pdfFileName = `${htmlFile}_${docNumber}${suffix}.pdf`;
        const projectId = extractProjectId(doc['Проект']);
        
        if (!projectId) throw new Error('NO_PROJECT_LINKED');

        let pdfPath;
        let savedInProject = false;

        if (projectId) {
            const projectFolder = findProjectFolder(projectId);
            if (projectFolder) {
                const docsFolder = path.join(projectFolder, 'Документы');
                if (!fs.existsSync(docsFolder)) fs.mkdirSync(docsFolder, { recursive: true });
                pdfPath = path.join(docsFolder, pdfFileName);
                savedInProject = true;

                const symlinkPath = path.join(PDF_DIR, pdfFileName);
                try {
                    if (fs.existsSync(symlinkPath) || fs.lstatSync(symlinkPath).isSymbolicLink()) fs.rmSync(symlinkPath, { force: true });
                } catch (e) { if (e.code !== 'ENOENT') console.log(`⚠️ Проверка старого файла: ${e.message}`); }

                try {
                    fs.symlinkSync(pdfPath, symlinkPath);
                    console.log(`🔗 Создан symlink: ${symlinkPath} → ${pdfPath}`);
                } catch (e) {
                    if (e.code !== 'EEXIST') { console.error(`❌ Ошибка создания symlink: ${e.message}`); throw e; }
                }
            } else {
                pdfPath = path.join(PDF_DIR, pdfFileName);
            }
        } else {
            pdfPath = path.join(PDF_DIR, pdfFileName);
        }

        const pdfUrl = `${NOCO_BASE_URL}/pdfs/${pdfFileName}`;
        browser = await puppeteer.launch({
            executablePath: '/usr/bin/chromium',
            headless: 'new',
            timeout: 30000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=IsolateOrigins,site-per-process',
                '--no-first-run',
                '--disable-default-apps',
                '--disable-hang-monitor'
            ]
        });
                
        const page = await browser.newPage();
        page.on('console', msg => { if (msg.type() === 'error') console.error(`🌐 Browser error: ${msg.text()}`); });
        page.on('requestfailed', req => { console.error(`❌ Request failed: ${req.url()} - ${req.failure().errorText}`); });
        
        const targetUrl = `http://localhost:3000/${htmlFile}.html?doc=${docId}&secret=${process.env.WEBHOOK_SECRET}`;
        console.log(`🌐 Открываю: ${targetUrl}`);
        
        const startTime = Date.now();
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(`✅ DOM загружен за ${Date.now() - startTime}мс`);
        
        console.log(`⏳ Ожидание загрузки данных в DOM...`);
        
        // 🆕 ИСПРАВЛЕННАЯ УНИВЕРСАЛЬНАЯ ПРОВЕРКА
        await page.waitForFunction(() => {
            const docNumEl = document.getElementById('docNumber');
            const hasDocNumber = docNumEl && docNumEl.innerText.trim().length > 0;

            const schetNumEl = document.getElementById('schetNumber');
            const hasSchetNumber = schetNumEl && schetNumEl.innerText.trim().length > 0;

            const actNumEl = document.getElementById('actNumber');
            const hasActNumber = actNumEl && actNumEl.innerText.trim().length > 0;

            const tnDayEl = document.getElementById('tnDay');
            const hasTnDate = tnDayEl && tnDayEl.innerText !== '__';

            const worksTable = document.getElementById('works');
            const hasWorksTable = worksTable && worksTable.children.length > 0;

            const itemsTable = document.getElementById('items');
            const hasItemsTable = itemsTable && itemsTable.children.length > 0;

            return hasDocNumber || hasSchetNumber || hasActNumber || hasTnDate || hasWorksTable || hasItemsTable;
        }, { timeout: 30000 }); // 30 сек для надежности при медленном API
        
        console.log(`✅ Данные успешно загружены в DOM.`);
                        
        const dataLoadTime = Date.now() - startTime;
        console.log(`✅ Данные загружены за ${dataLoadTime}мс`);
        
        await new Promise(r => setTimeout(r, 200));

        console.log(`📝 Генерация PDF...`);
        const pdfStartTime = Date.now();
        await page.pdf({ path: pdfPath, format: 'A4', margin: { top: '5mm', right: '5mm', bottom: '5mm', left: '5mm' }, printBackground: true });
        console.log(`✅ PDF создан за ${Date.now() - pdfStartTime}мс (общее время: ${Date.now() - startTime}мс)`);      
          
        const stats = fs.statSync(pdfPath);
        const now = new Date().toLocaleString('ru-RU', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

        await axios.patch(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, {
            'PDF ссылка': pdfUrl, 'PDF сгенерирован': true, 'Дата последнего PDF': now
        }, { headers: { 'xc-token': NOCO_API_TOKEN, 'Content-Type': 'application/json' } });

        if (projectId && savedInProject) {
            try {
                const projectFolder = findProjectFolder(projectId);
                if (projectFolder) {
                    const fileList = listFilesRecursive(projectFolder);
                    await axios.patch(`${NOCO_API_URL}/${BASE_ID}/${TABLE_PROJECTS}/${projectId}`, {
                        'Файлы в папке': `📁 Путь: ${projectFolder}\n\n📄 Содержимое:\n${fileList}`
                    }, { headers: { 'xc-token': NOCO_API_TOKEN, 'Content-Type': 'application/json' } });
                }
            } catch (e) { console.log(`⚠️ Не удалось обновить поле "Файлы в папке": ${e.message}`); }
        }

        return { fileName: pdfFileName, url: pdfUrl, size: stats.size, skipped: false, pdfPath };
    } catch (error) {
        console.error(`❌ Ошибка генерации PDF: ${error.message}`);
        throw error;
    } finally {
        if (browser) {
            try {
                await Promise.race([ browser.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('Browser close timeout')), 5000)) ]);
            } catch (closeError) {
                try {
                    const browserProcess = browser.process();
                    if (browserProcess) browserProcess.kill('SIGKILL');
                } catch (killError) { console.error(`❌ Не удалось убить процесс: ${killError.message}`); }
            }
        }
        generatingDocs.delete(docId);
    }
}

// ================== ПРОКСИ-РОУТЫ ==================
app.get('/api/doc/:id', requireSecret, async (req, res) => {
    try {
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${req.params.id}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        res.json(response.data);
    } catch (err) { res.status(err.response?.status || 500).json({ error: err.message }); }
});

app.get('/api/project/:id', requireSecret, async (req, res) => {
    try {
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_PROJECTS}/${req.params.id}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        res.json(response.data);
    } catch (err) { res.status(err.response?.status || 500).json({ error: err.message }); }
});

app.get('/api/items', requireSecret, async (req, res) => {
    try {
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_ITEMS}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        res.json(response.data);
    } catch (err) { res.status(err.response?.status || 500).json({ error: err.message }); }
});

app.get('/api/my-details', requireSecret, async (req, res) => {
    try {
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_MY_DETAILS}?limit=1`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        res.json(response.data.list?.[0] || {});
    } catch (err) { res.status(err.response?.status || 500).json({ error: err.message }); }
});

app.get('/api/client/:id', requireSecret, async (req, res) => {
    try {
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_LEGAL_ENTITIES}/${req.params.id}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        res.json(response.data);
    } catch (err) { res.status(err.response?.status || 500).json({ error: err.message }); }
});

app.get('/api/contact/:id', requireSecret, async (req, res) => {
    try {
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_CONTACTS}/${req.params.id}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        res.json(response.data);
    } catch (err) { res.status(err.response?.status || 500).json({ error: err.message }); }
});

app.get('/api/docs', requireSecret, async (req, res) => {
    try {
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        res.json(response.data);
    } catch (err) { res.status(err.response?.status || 500).json({ error: err.message }); }
});

app.get('/api/doc-settings', requireSecret, async (req, res) => {
    try {
        const TABLE_DOC_SETTINGS = process.env.TABLE_DOC_SETTINGS;
        if (!TABLE_DOC_SETTINGS) return res.status(500).json({ error: 'TABLE_DOC_SETTINGS не настроен' });
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOC_SETTINGS}?limit=1`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        res.json(response.data.list?.[0] || {});
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/employee/:id', requireSecret, async (req, res) => {
    try {
        const tableEmployees = process.env.TABLE_EMPLOYEES;
        if (!tableEmployees) return res.status(500).json({ error: 'TABLE_EMPLOYEES не найден' });
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${tableEmployees}/${req.params.id}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        res.json(response.data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/pdfs/:filename', requireSecret, (req, res) => {
    const pdfPath = path.join('/mnt/data/noco-static/pdfs', req.params.filename);
    if (!fs.existsSync(pdfPath)) return res.status(404).send(getPDFNotFoundHTML(req.params.filename, null));
    res.sendFile(pdfPath);
});

// ================== WEB РОУТЫ ==================

app.get('/', requireSecret, async (req, res) => {
    const secret = req.query.secret || '';
    const baseUrl = `http://${process.env.WEBHOOK_HOST || 'localhost'}:3000`;
    const docId = parseInt(req.query.docId);
    if (!docId) return res.status(400).send('Ошибка: параметр ?docId обязателен');
    
    try {
        const result = await generatePDF(docId);
        if (result.error) {
            return res.status(409).send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Подождите ⏳</title>
    <link rel="stylesheet" href="/shared-styles.css">
    <style>
        body { background: var(--warning-gradient); }
        h1 { color: var(--warning-color); }
        .info-box { background: #fff3cd; border-left-color: var(--warning-color); }
        .info-box h3 { color: #856404; }
        .countdown { margin-top: 20px; color: var(--text-secondary); font-size: 14px; }
        .progress-bar { width: 100%; height: 4px; background: var(--border-color); border-radius: 2px; overflow: hidden; margin-top: 15px; }
        .progress-fill { height: 100%; background: var(--warning-color); animation: progress 5s linear forwards; }
        @keyframes progress { from { width: 100%; } to { width: 0%; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">⏳</div>
        <h1>Подождите</h1>
        <p class="subtitle">Документ сейчас генерируется</p>
        <div class="info-box">
            <h3>💡 Что происходит?</h3>
            <p>${result.error}</p>
        </div>
        <div class="countdown">
            Автообновление через <span id="timer">5</span> сек
            <div class="progress-bar"><div class="progress-fill"></div></div>
        </div>
    </div>
    <script>
        let seconds = 5;
        const timer = document.getElementById('timer');
        const interval = setInterval(() => {
            seconds--;
            if (timer) timer.textContent = seconds;
            if (seconds <= 0) { clearInterval(interval); window.location.reload(); }
        }, 1000);
    </script>
</body>
</html>`);
        }
        
        res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>PDF сгенерирован ✅</title>
    <link rel="stylesheet" href="/shared-styles.css">
    <style>
        body { background: var(--success-gradient); }
        h1 { color: var(--success-color); }
        .info-box { border-left-color: var(--success-color); }
        .info-value.success { color: var(--success-color); }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">✅</div>
        <h1>PDF успешно сгенерирован!</h1>
        <p class="subtitle">Документ готов к отправке</p>
        
        <div class="info-box">
            <h3>📄 Информация о документе</h3>
            <div class="info-row">
                <span class="info-label">Имя файла:</span>
                <span class="info-value">${result.fileName}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Размер:</span>
                <span class="info-value">${(result.size / 1024).toFixed(1)} КБ</span>
            </div>
            <div class="info-row">
                <span class="info-label">Статус:</span>
                <span class="info-value success">✓ Готов к отправке</span>
            </div>
        </div>
        
        <a href="/send-email?docId=${docId}&secret=${secret}" class="btn btn-success">📧 Отправить по email</a>
        <a href="${baseUrl}/pdfs/${result.fileName}?secret=${secret}&_t=${Date.now()}" target="_blank" class="btn btn-secondary">👁 Открыть PDF</a>
    </div>
</body>
</html>`);
    } catch (error) {
        if (error.message === 'NO_DOC_TYPE') return res.status(400).send(getNoTypeHTML());
        if (error.message === 'NO_PROJECT_LINKED') return res.status(400).send(getNoProjectHTML());
        res.status(500).send(getErrorHTML(error.message));
    }
});

// ================== УМНЫЙ ТЕКСТ ПИСЬМА (единая функция, v4.42.3) ==================
// Используется и формой GET /send-email, и ботом (POST /api/send-doc) — один
// источник темы/текста. Раньше логика была зашита только в GET /send-email,
// при добавлении бота её пришлось бы дублировать → разъехались бы формулировки.
function composeEmailText({ companyName, docName, docNumber, formattedDate, docType, periodText, projectDocName, greeting, manager, smtpFrom }) {
    let callToAction = 'Пожалуйста, подтвердите получение этого письма ответом.';
    if (docType === 'Акт' || docType === 'Акт (Физлицо)') callToAction = 'Просим подписать акт и вернуть скан-копию ответным письмом.';
    else if (docType === 'Накладная' || docType === 'ТН') callToAction = 'Просим подтвердить получение товара ответным письмом.';

    const periodReference = periodText ? ` за период "${periodText}"` : '';
    const projectReference = projectDocName ? ` (${projectDocName})` : '';

    const defaultSubject = `${companyName} - ${docName} №${docNumber} от ${formattedDate}`;

    let defaultText = `${greeting}\n\nНаправляю вам ${docName}${periodReference}${projectReference}.\n\n📎 Во вложении: ${docName} №${docNumber} от ${formattedDate}`;
    defaultText += `\n\n${callToAction}\nЕсли возникнут вопросы — отвечайте на это письмо, я на связи.\n\nС уважением,`;
    if (manager.position) {
        defaultText += `\n${manager.name}\n${manager.position}`;
        if (manager.company) defaultText += ` | ${manager.company}`;
    } else {
        defaultText += `\n${manager.name}`;
    }
    if (manager.phone) defaultText += `\n📱 ${manager.phone}`;
    if (manager.email && manager.email !== smtpFrom) defaultText += `\n📧 ${manager.email}`;
    if (manager.website) defaultText += `\n🌐 ${manager.website}`;

    return { defaultSubject, defaultText };
}

// ================== ПОДГОТОВКА ПИСЬМА ДЛЯ БОТА (v4.42.5) ==================
// Единый источник и для предпросмотра (POST /api/preview-doc), и для отправки
// (POST /api/send-doc). Раньше вся эта логика жила только внутри /api/send-doc,
// и бот слал письмо «вслепую» — без показа получателя/темы/текста.
//
// Получателей может быть несколько (при работе с юрлицом): контакт проекта,
// «Контакт/ответственный» юрлица и само юрлицо. Для КАЖДОГО кандидата считаем
// свою тему/текст (приветствие зависит от адресата: «Здравствуйте, Иван!» vs
// «Здравствуйте!»), чтобы бот мог переключать адресата без повторных запросов.
//
// Возвращает { ok:true, doc, docId, projectId, docType, docName, docNumber,
//   formattedDate, projectDocName, companyName, manager, managerEmail,
//   signed, pdfFileName, candidates:[{kind,name,email,greeting,subject,text}],
//   selected, toEmail, subject, text }
// либо { ok:false, status, error }.
async function prepareDocEmail(docId, overrideToEmail = '') {
    const doc = (await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, { headers: { 'xc-token': NOCO_API_TOKEN } })).data;
    const docType = doc['Тип документа'];
    if (!docType) return { ok: false, status: 400, error: 'У документа нет типа документа' };
    const htmlFile = DOC_TYPE_MAP[docType];
    if (!htmlFile) return { ok: false, status: 400, error: `Неизвестный тип документа: ${docType}` };
    const projectId = extractProjectId(doc['Проект']);
    if (!projectId) return { ok: false, status: 400, error: 'Документ не привязан к проекту' };

    const docNumber = generateDocNumber(doc['Дата документа'], docId);
    const formattedDate = formatDateSimple(doc['Дата документа'] || new Date().toISOString());
    const project = (await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_PROJECTS}/${projectId}`, { headers: { 'xc-token': NOCO_API_TOKEN } })).data;

    // «Мои реквизиты» — имя компании в теме письма
    let companyName = 'Компания';
    try {
        const myRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_MY_DETAILS}?limit=1`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        if (myRes.data.list && myRes.data.list[0]) {
            companyName = myRes.data.list[0]['Краткое Имя'] || myRes.data.list[0]['Название'] || 'Компания';
        }
    } catch (e) { console.log(`⚠️ prepareDocEmail: «Мои реквизиты»: ${e.message}`); }

    // Название документа из настроек (как в форме)
    let docName = docType;
    try {
        const settingsRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_DOC_SETTINGS}?limit=1`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        if (settingsRes.data.list && settingsRes.data.list[0]) {
            const s = settingsRes.data.list[0];
            if (docType === 'Счет' || docType === 'Счет (Физлицо)') docName = s['Имя счета'] || 'Счет';
            else if (docType === 'Акт' || docType === 'Акт (Физлицо)') docName = s['Имя акта'] || 'Акт';
            else if (docType === 'Накладная' || docType === 'ТН') docName = 'Товарная накладная';
        }
    } catch (e) { console.log(`⚠️ prepareDocEmail: настройки документов: ${e.message}`); }

    // Менеджер (Reply-To/BCC/подпись) — из «Менеджера» проекта, fallback на SMTP_FROM
    let manager = { name: '', email: process.env.SMTP_FROM, phone: '', position: '', company: '', website: '' };
    const managerId = extractId(project?.['Менеджер']);
    if (managerId) {
        try {
            const empRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_EMPLOYEES}/${managerId}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
            manager = {
                name: empRes.data['ФИО'] || empRes.data['Обращение'] || companyName,
                email: empRes.data['E-mail'] || process.env.SMTP_FROM,
                phone: empRes.data['Телефон'] || '',
                position: empRes.data['Должность'] || '',
                company: companyName, website: ''
            };
        } catch (e) { console.log(`⚠️ prepareDocEmail: менеджер: ${e.message}`); }
    } else {
        manager.name = companyName;
    }

    // ───────────── Кандидаты-получатели (контакт / контакт юрлица / юрлицо) ─────────────
    const contactId = extractId(project?.['Контакт']);
    const legalId = extractId(project?.['Юрлицо']);

    let projectContact = null;
    if (contactId) {
        try {
            projectContact = (await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_CONTACTS}/${contactId}`, { headers: { 'xc-token': NOCO_API_TOKEN } })).data;
        } catch (e) { console.log(`⚠️ prepareDocEmail: контакт проекта: ${e.message}`); }
    }

    let legal = null;
    if (legalId) {
        try {
            legal = (await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_LEGAL_ENTITIES}/${legalId}`, { headers: { 'xc-token': NOCO_API_TOKEN } })).data;
        } catch (e) { console.log(`⚠️ prepareDocEmail: юрлицо: ${e.message}`); }
    }

    // «Контакт/ответственный» юрлица — если это НЕ тот же человек, что контакт проекта
    let legalContact = null;
    const legalContactId = legal ? extractId(legal['Контакт/ответственный']) : null;
    if (legalContactId && (!contactId || String(contactId) !== String(legalContactId))) {
        try {
            legalContact = (await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_CONTACTS}/${legalContactId}`, { headers: { 'xc-token': NOCO_API_TOKEN } })).data;
        } catch (e) { console.log(`⚠️ prepareDocEmail: контакт/ответственный юрлица: ${e.message}`); }
    }

    const greetingFor = (row) => (row && row['Обращение']) ? `Здравствуйте, ${row['Обращение']}!` : 'Здравствуйте!';

    const candidates = [];
    const seen = new Set();
    const pushCandidate = (kind, name, email, greeting) => {
        const e = String(email || '').trim();
        const key = e.toLowerCase();
        if (!e || seen.has(key)) return;
        seen.add(key);
        candidates.push({
            kind,
            name: String(name || '').trim() || (kind === 'legal' ? 'Организация' : 'Контакт'),
            email: e,
            greeting
        });
    };

    // Порядок = приоритет по умолчанию: живой человек → общий ящик компании.
    pushCandidate('contact', projectContact?.['Имя'], projectContact?.['E-mail'], greetingFor(projectContact));
    pushCandidate('legal_contact', legalContact?.['Имя'], legalContact?.['E-mail'], greetingFor(legalContact));
    if (legal) pushCandidate('legal', legal['Краткое Имя'] || legal['Имя'], legal['E-mail'], 'Здравствуйте!');

    if (candidates.length === 0) return { ok: false, status: 400, error: 'У клиента нет E-mail — отправьте документ вручную (мессенджер/на руки)' };

    const projectDocName = project?.['Имя для документов']?.trim();
    const periodText = doc['Период']?.trim();

    // Тема/текст — для каждого кандидата (у разных адресатов разное приветствие)
    const buildMail = (greeting) => {
        const t = composeEmailText({
            companyName, docName, docNumber, formattedDate, docType,
            periodText, projectDocName, greeting, manager,
            smtpFrom: process.env.SMTP_FROM
        });
        return { subject: t.defaultSubject, text: t.defaultText };
    };
    for (const c of candidates) Object.assign(c, buildMail(c.greeting));

    let selected = 0;
    const override = String(overrideToEmail || '').trim();
    if (override) {
        const idx = candidates.findIndex(c => c.email.toLowerCase() === override.toLowerCase());
        if (idx >= 0) selected = idx;
    }
    const sel = candidates[selected];

    const signed = doc['С печатью'] === true || doc['С печатью'] === 1 || doc['С печатью'] === 'true' || doc['С печатью'] === '1';
    const pdfFileName = signed ? `${htmlFile}_${docNumber}.pdf` : `${htmlFile}_${docNumber}_notsigned.pdf`;

    return {
        ok: true, doc, docId, projectId, docType, docName, docNumber,
        formattedDate, projectDocName, companyName, manager, managerEmail: manager.email,
        signed, pdfFileName,
        candidates, selected,
        toEmail: sel.email, subject: sel.subject, text: sel.text, greeting: sel.greeting
    };
}


app.get('/send-email', requireSecret, async (req, res) => {
    const docId = parseInt(req.query.docId);
    // v4.40.0 (Проблема 113): секрет прокидывается в форму (hidden input) —
    // БЕЗ объявления здесь GET /send-email падал с «secret is not defined» (ReferenceError).
    const secret = req.query.secret || '';
    if (!docId) return res.status(400).send(getErrorHTML('Параметр ?docId обязателен', null, 'Откройте документ через NocoDB и нажмите «Отправить по email» снова.'));

    try {
        const docRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        const doc = docRes.data;
        const docType = doc['Тип документа'];
        if (!docType) return res.status(400).send(getNoTypeHTML());
        const htmlFile = DOC_TYPE_MAP[docType];
        if (!htmlFile) return res.status(400).send(getNoTypeHTML(`Неизвестный тип документа: ${docType}`));
        
        const docNumber = generateDocNumber(doc['Дата документа'], docId);
        let pdfFileName = `${htmlFile}_${docNumber}.pdf`;
        const projectId = extractProjectId(doc['Проект']);

        if (!projectId) return res.status(400).send(getNoProjectHTML());

        let project = null;
        if (projectId) {
            const projRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_PROJECTS}/${projectId}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
            project = projRes.data;
        }
        
        // 🆕 0. РАСЧЁТ СУММЫ И НДС
        const baseTotal = await calculateProjectTotal(projectId);
        let vatAmount = 0;
        let totalWithVat = baseTotal;
        
        // 🆕 1. ЗАГРУЗКА МЕНЕДЖЕРА ПРОЕКТА
        let manager = { name: '', email: process.env.SMTP_FROM, phone: '', position: '', company: '', website: '' };
        let managerNotFound = false;
        const managerId = extractId(project?.['Менеджер']);
        
        if (managerId) {
            try {
                const empRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_EMPLOYEES}/${managerId}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
                manager = {
                    name: empRes.data['ФИО'] || empRes.data['Обращение'] || '',
                    email: empRes.data['E-mail'] || process.env.SMTP_FROM,
                    phone: empRes.data['Телефон'] || '',
                    position: empRes.data['Должность'] || '',
                    company: '', website: ''
                };
            } catch (e) { 
                console.log(`⚠️ Не удалось получить данные менеджера: ${e.message}`);
                managerNotFound = true;
            }
        } else {
            managerNotFound = true;
        }

        // 🆕 2. ЗАГРУЗКА "МОИ РЕКВИЗИТЫ" (включая НДС)
        let companyDetails = { 
            name: 'Компания', phone: '', email: process.env.SMTP_FROM, website: '',
            vatRate: 0, vatType: 'Без НДС'
        };
        try {
            const myDetailsRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_MY_DETAILS}?limit=1`, { headers: { 'xc-token': NOCO_API_TOKEN } });
            if (myDetailsRes.data.list && myDetailsRes.data.list[0]) {
                const myDetails = myDetailsRes.data.list[0];
                companyDetails = {
                    name: myDetails['Краткое Имя'] || myDetails['Название'] || 'Компания',
                    phone: myDetails['Телефон'] || '',
                    email: myDetails['E-mail'] || process.env.SMTP_FROM,
                    website: myDetails['Сайт'] || '',
                    vatRate: parseFloat(myDetails['Ставка НДС']) || 0,
                    vatType: myDetails['Тип НДС'] || 'Без НДС'
                };
            }
        } catch (e) { console.log(`⚠️ Не удалось получить "Мои реквизиты": ${e.message}`); }

        // 🆕 РАСЧЁТ НДС (v4.37.0: единый модуль shared/vat.js, тесты tests/vat.test.js)
        const vatCalc = vat.computeVat(baseTotal, companyDetails.vatRate, companyDetails.vatType);
        const vatRate = vatCalc.vatRate;
        const vatType = vatCalc.vatType;
        vatAmount = vatCalc.vatAmount;
        totalWithVat = vatCalc.totalWithVat;
        console.log(`💰 Расчёт НДС: база=${baseTotal}, тип="${vatType}", ставка=${vatRate}%, НДС=${vatAmount}, итого=${totalWithVat}`);

        // 🆕 3. FALLBACK: Если менеджер не указан, используем данные компании
        if (managerNotFound || !manager.name) {
            manager = { name: companyDetails.name, email: companyDetails.email, phone: companyDetails.phone, position: '', company: '', website: companyDetails.website };
        } else {
            manager.company = companyDetails.name;
            manager.website = companyDetails.website;
        }

        // 🆕 4. ЗАГРУЗКА КОНТАКТА И ЮРЛИЦА
        let contactEmail = '', contactName = '', legalEmail = '', legalName = '', contactData = {};
        if (project) {
            let contactId = extractId(project['Контакт']);
            if (contactId) {
                try {
                    const contactRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_CONTACTS}/${contactId}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
                    contactData = contactRes.data;
                    contactEmail = contactData['E-mail'] || '';
                    contactName = contactData['Имя'] || '';
                } catch (e) { console.log(`⚠️ Не удалось получить контакт: ${e.message}`); }
            }
            let legalId = extractId(project['Юрлицо']);
            if (legalId) {
                try {
                    const legalRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_LEGAL_ENTITIES}/${legalId}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
                    legalEmail = legalRes.data['E-mail'] || '';
                    legalName = legalRes.data['Имя'] || '';
                } catch (e) { console.log(`⚠️ Не удалось получить юрлицо: ${e.message}`); }
            }
        }

        // 🆕 5. ФОРМИРОВАНИЕ ОБРАЩЕНИЯ
        let greeting = 'Здравствуйте!';
        if (contactName && contactData['Обращение']) {
            greeting = `Здравствуйте, ${contactData['Обращение']}!`;
        }

        // 🆕 6. ФОРМИРОВАНИЕ ИМЕНИ ДОКУМЕНТА И ТЕМЫ
        let docName = docType;
        try {
            const settingsRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_DOC_SETTINGS}?limit=1`, { headers: { 'xc-token': NOCO_API_TOKEN } });
            if (settingsRes.data.list && settingsRes.data.list[0]) {
                const settings = settingsRes.data.list[0];
                if (docType === 'Счет' || docType === 'Счет (Физлицо)') docName = settings['Имя счета'] || 'Счет';
                else if (docType === 'Акт' || docType === 'Акт (Физлицо)') docName = settings['Имя акта'] || 'Акт';
                else if (docType === 'Накладная' || docType === 'ТН') docName = 'Товарная накладная';
            }
        } catch (e) { console.log(`⚠️ Не удалось получить настройки документов: ${e.message}`); }

        const formattedDate = formatDateSimple(doc['Дата документа'] || new Date().toISOString());
        // v4.42.3: тема/текст письма — единая функция composeEmailText (та же, что у /api/send-doc)
        const emailText = composeEmailText({
            companyName: companyDetails.name,
            docName, docNumber, formattedDate,
            docType,
            periodText: doc['Период']?.trim(),
            projectDocName: project?.['Имя для документов']?.trim(),
            greeting,
            manager,
            smtpFrom: process.env.SMTP_FROM
        });
        const defaultSubject = emailText.defaultSubject;
        const defaultText = emailText.defaultText;

        const withStamp = doc['С печатью'] === true || doc['С печатью'] === 1 || doc['С печатью'] === 'true' || doc['С печатью'] === '1';
        const isNotSigned = !withStamp;
        pdfFileName = withStamp ? `${htmlFile}_${docNumber}.pdf` : `${htmlFile}_${docNumber}_notsigned.pdf`;
        
        const pdfPath = findPDFPath(pdfFileName, projectId);
        if (!pdfPath) return res.status(404).send(getPDFNotFoundHTML(pdfFileName, docId, false));

        const pdfUrl = `${NOCO_BASE_URL}/pdfs/${pdfFileName}?secret=${req.query.secret || ''}&_t=${Date.now()}`;

        res.send(getEmailFormHTML({
            docId, secret, docType, projectName: project?.['Что делаем?'] || 'Проект', pdfFileName, pdfUrl, 
            baseTotal, vatRate, vatType, vatAmount, totalWithVat, // 🆕 Передаем данные о НДС
            responsible: manager,
            contactEmail, contactName, legalEmail, legalName, defaultSubject, defaultText, isNotSigned, managerNotFound
        }));
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        if (error.message === 'NO_PROJECT_LINKED') return res.status(400).send(getNoProjectHTML());
        if (error.message === 'NO_DOC_TYPE') return res.status(400).send(getNoTypeHTML());
        res.status(500).send(getErrorHTML(error.message, docId));
    }
});

app.post('/send-email', requireSecret, async (req, res) => {
    const { docId, toEmail, subject, text, pdfFileName } = req.body;
    if (!docId || !toEmail || !subject || !text || !pdfFileName) return res.status(400).send(getErrorHTML('Заполните все поля', docId));
    
    try {
        const docRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        const doc = docRes.data;
        const projectId = extractProjectId(doc['Проект']);
        
        if (!projectId) throw new Error('NO_PROJECT_LINKED');
        const pdfPath = findPDFPath(pdfFileName, projectId);
        if (!pdfPath) return res.status(404).send(getPDFNotFoundHTML(pdfFileName, docId, false));
        
        let managerEmail = process.env.SMTP_FROM;
        try {
            const projRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_PROJECTS}/${projectId}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
            const mId = extractId(projRes.data['Менеджер']);
            if (mId) {
                const empRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_EMPLOYEES}/${mId}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
                managerEmail = empRes.data['E-mail'] || process.env.SMTP_FROM;
            }
        } catch (e) { console.log(`⚠️ Не удалось получить email менеджера: ${e.message}`); }

        // 🆕 ФОРМИРОВАНИЕ СТРУКТУРИРОВАННОГО HTML (вместо white-space: pre-wrap)
        // v4.43.1: текст письма (данные из БД) экранируем ДО сборки HTML — иначе
        // `<script>` в имени контакта/проекта уехал бы в письмо как живой HTML.
        const htmlParagraphs = escapeHtml(text).split('\n\n').map(paragraph => {
            if (paragraph.startsWith('С уважением')) {
                const lines = paragraph.split('\n');
                return `<p style="margin-top: 20px; color: #555; font-size: 13px;">${lines.join('<br>')}</p>`;
            }
            if (paragraph.match(/^[📎💰⏳📬📋]/)) {
                return `<p style="margin: 10px 0; line-height: 1.6;">${paragraph.replace(/\n/g, '<br>')}</p>`;
            }
            return `<p style="margin: 10px 0; line-height: 1.6;">${paragraph.replace(/\n/g, '<br>')}</p>`;
        }).join('');

        const html = `<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">${htmlParagraphs}</div>`;

        const result = await sendEmailWithPDF({
            toEmail, subject, text,
            html: html,
            pdfPath, pdfFileName,
            managerEmail
        });
        
        try {
            await axios.patch(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, {
                'Статус': 'Отправлен',
                // v4.42.0 (Шаг 0, Волна A): колонка «Дата отправки» (Date) добавлена дельтой U007.
                // Раньше PATCH уходил в НЕсуществующую колонку локализованной строкой
                // («аудит писал в воздух») — теперь честная Date в ISO, как у остальных дат.
                'Дата отправки': new Date().toISOString()
            }, { headers: { 'xc-token': NOCO_API_TOKEN, 'Content-Type': 'application/json' } });
        } catch (e) { console.log(`⚠️ Не удалось обновить статус: ${e.message}`); }
        
        res.send(getEmailSuccessHTML({ docId, docType: doc['Тип документа'], toEmail, pdfFileName, messageId: result.messageId }));
    } catch (error) {
        console.error('❌ Ошибка отправки:', error.message);
        res.status(500).send(getErrorHTML(error.message, docId));
    }
});



// ================== ОТПРАВКА ПО EMAIL ИЗ БОТА (v4.42.3 + v4.42.5) ==================
// v4.42.5: перед отправкой бот показывает предпросмотр письма (получатель/тема/текст).
// Оба роута используют единый источник prepareDocEmail() — предпросмотр в боте на 100%
// совпадает с тем, что реально уйдёт. Получателей может быть несколько (контакт проекта,
// «Контакт/ответственный» юрлица, само юрлицо) — бот даёт выбрать, шлёт с toEmail.
app.post('/api/preview-doc', requireSecret, async (req, res) => {
    const docId = parseInt(req.body?.docId);
    if (!docId) return res.status(400).json({ error: 'Нет docId' });
    try {
        const prep = await prepareDocEmail(docId, '');
        if (!prep.ok) return res.status(prep.status || 400).json({ error: prep.error });
        res.json({
            success: true,
            docId: prep.docId,
            projectId: prep.projectId,
            docType: prep.docType,
            docName: prep.docName,
            docNumber: prep.docNumber,
            formattedDate: prep.formattedDate,
            signed: prep.signed,
            pdfFileName: prep.pdfFileName,
            candidates: prep.candidates, // [{kind,name,email,greeting,subject,text}]
            selected: prep.selected,
            toEmail: prep.toEmail,
            subject: prep.subject,
            text: prep.text
        });
    } catch (error) {
        console.error('❌ Ошибка /api/preview-doc:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Отправляемые в данный момент документы (Set docId). Защита от параллельных
// запросов /api/send-doc на один документ (двойной тап / два окна). Вторая линия —
// проверка статуса «Отправлен» в NocoDB ниже.
const emailSendingDocs = new Set();

app.post('/api/send-doc', requireSecret, async (req, res) => {
    const docId = parseInt(req.body?.docId);
    const toEmail = (req.body?.toEmail || '').trim();
    if (!docId) return res.status(400).json({ error: 'Нет docId' });

    // v4.43.1 (защита от повторной рассылки): документ со статусом «Отправлен» больше
    // не уходит клиенту. Раньше защита жила только в UI бота (кнопка пряталась после
    // отправки) — «старая» кнопка/двойной тап слали второе письмо.
    if (emailSendingDocs.has(docId)) {
        return res.status(409).json({ error: 'Письмо по этому документу уже отправляется — подождите пару секунд' });
    }
    try {
        const checkRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        if (checkRes.data['Статус'] === 'Отправлен') {
            return res.status(409).json({ error: 'Документ уже отправлен — повторная отправка заблокирована' });
        }
    } catch (e) { console.log(`⚠️ /api/send-doc: не удалось проверить статус документа: ${e.message}`); }

    emailSendingDocs.add(docId);
    try {
        const prep = await prepareDocEmail(docId, toEmail);
        if (!prep.ok) return res.status(prep.status || 400).json({ error: prep.error });

        const pdfPath = findPDFPath(prep.pdfFileName, prep.projectId);
        if (!pdfPath) return res.status(409).json({ error: 'PDF не найден — сначала сформируйте документ (кнопка PDF в боте)' });

        // v4.43.1: текст письма экранируем до сборки HTML (см. POST /send-email).
        const htmlParagraphs = escapeHtml(prep.text).split('\n\n').map(paragraph => {
            if (paragraph.startsWith('С уважением')) {
                const lines = paragraph.split('\n');
                return `<p style="margin-top: 20px; color: #555; font-size: 13px;">${lines.join('<br>')}</p>`;
            }
            return `<p style="margin: 10px 0; line-height: 1.6;">${paragraph.replace(/\n/g, '<br>')}</p>`;
        }).join('');
        const html = `<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 14px; color: #333; line-height: 1.6;">${htmlParagraphs}</div>`;

        const result = await sendEmailWithPDF({
            toEmail: prep.toEmail,
            subject: prep.subject,
            text: prep.text,
            html,
            pdfPath,
            pdfFileName: prep.pdfFileName,
            managerEmail: prep.managerEmail
        });

        try {
            await axios.patch(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, {
                'Статус': 'Отправлен',
                'Дата отправки': new Date().toISOString()
            }, { headers: { 'xc-token': NOCO_API_TOKEN, 'Content-Type': 'application/json' } });
        } catch (e) { console.log(`⚠️ /api/send-doc: не удалось обновить статус: ${e.message}`); }

        res.json({ success: true, docId, toEmail: prep.toEmail, messageId: result.messageId });
    } catch (error) {
        console.error('❌ Ошибка /api/send-doc:', error.message);
        res.status(500).json({ error: error.message });
    } finally {
        emailSendingDocs.delete(docId);
    }
});



app.post('/generate-pdf', requireSecret, async (req, res) => {
    const id = parseInt(req.query.docId || req.body?.docId);
    if (!id) return res.status(400).json({ error: 'Нет ID' });
    try {
        const result = await generatePDF(id);
        res.json(result.skipped ? { status: 'skipped' } : { success: true, url: result.url });
    } catch (e) { 
        if (e.message === 'NO_PROJECT_LINKED') return res.status(400).send(getNoProjectHTML());
        if (e.message === 'NO_DOC_TYPE') return res.status(400).send(getNoTypeHTML());
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/generate-pdf', requireSecret, async (req, res) => {
    const id = parseInt(req.query.docId);
    if (isNaN(id)) return res.status(400).send('Ошибка ID');
    try {
        const result = await generatePDF(id);
        if (result.error) {
            return res.send(`<h1>⏳ Подождите</h1><p>${result.error}</p><meta http-equiv="refresh" content="5">`);
        }
        res.redirect(`/?docId=${id}&secret=${req.query.secret}`);
    } catch (e) {
        if (e.message === 'NO_PROJECT_LINKED') {
            console.log(`⚠️ Документ ID=${id} не привязан к проекту`);
            return res.status(400).send(getNoProjectHTML());
        }
        if (e.message === 'NO_DOC_TYPE') {
            console.log(`⚠️ Документ ID=${id} не имеет типа`);
            return res.status(400).send(getNoTypeHTML());
        }
        console.error(`❌ Ошибка в GET /generate-pdf для ID=${id}:`, e.message);
        res.status(500).send(getErrorHTML(e.message, id));
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ================== HTML ГЕНЕРАТОРЫ ==================
function getEmailFormHTML({ docId, secret, docType, projectName, pdfFileName, pdfUrl, baseTotal, vatRate, vatType, vatAmount, totalWithVat, responsible, contactEmail, contactName, legalEmail, legalName, defaultSubject, defaultText, isNotSigned, managerNotFound }) {
    // v4.43.1 (защита от stored-XSS): данные из NocoDB экранируем перед вставкой
    // в HTML. Внутри формы это «просто текст» (label/input/textarea) — живой HTML
    // там не нужен, а вот кавычки/скобки могут сломать атрибуты value.
    docType = escapeHtml(docType);
    projectName = escapeHtml(projectName);
    pdfFileName = escapeHtml(pdfFileName);
    pdfUrl = escapeHtml(pdfUrl);
    if (responsible) {
        responsible = {
            ...responsible,
            name: escapeHtml(responsible.name),
            email: escapeHtml(responsible.email)
        };
    }
    contactEmail = escapeHtml(contactEmail);
    contactName = escapeHtml(contactName);
    legalEmail = escapeHtml(legalEmail);
    legalName = escapeHtml(legalName);
    defaultSubject = escapeHtml(defaultSubject);
    defaultText = escapeHtml(defaultText);
    
    // 🆕 ФОРМИРОВАНИЕ БЛОКА СУММЫ (зависит от типа НДС)
    let sumBlock = '';
    if (vatType === 'Без НДС' || vatRate === 0) {
        sumBlock = `<strong>Сумма:</strong> ${baseTotal.toFixed(2)} BYN<br><span style="color: #7f8c8d; font-size: 13px;">Без НДС</span>`;
    } else if (vatType === 'Начисляется сверху') {
        sumBlock = `<strong>Сумма без НДС:</strong> ${baseTotal.toFixed(2)} BYN<br>
        <strong>НДС (${vatRate}%):</strong> ${vatAmount.toFixed(2)} BYN<br>
        <strong style="color: var(--success-color); font-size: 16px;">Итого к оплате: ${totalWithVat.toFixed(2)} BYN</strong>`;
    } else if (vatType === 'Включен в цену') {
        sumBlock = `<strong>Сумма:</strong> ${totalWithVat.toFixed(2)} BYN<br>
        <span style="color: #7f8c8d; font-size: 13px;">В т.ч. НДС (${vatRate}%): ${vatAmount.toFixed(2)} BYN</span>`;
    }

    return `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Отправить email 📧</title>
    <link rel="stylesheet" href="/shared-styles.css">
</head>
<body>
<div class="container">
    <h1>📧 Отправить документ по email</h1>
    <p class="subtitle">Документ: ${docType} | Проект: ${projectName}</p>
    
    ${managerNotFound ? `
    <div style="background: #fff3cd; border: 1px solid #ffc107; color: #856404; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <strong>⚠️ Внимание:</strong> Менеджер не указан в проекте.<br>
        Письмо уйдёт от общего ящика (${process.env.SMTP_FROM}), и копия тоже уйдёт туда.<br>
        <a href="${NOCO_BASE_URL}/dashboard" target="_blank" style="color: #856404; text-decoration: underline; font-weight: bold;">Открыть NocoDB → заполните поле "Менеджер" в проекте</a>
    </div>
    ` : ''}
    
    <div class="info-box">
        <h3>📄 Информация об отправке</h3>
        <p><strong>Файл:</strong> ${pdfFileName}<br>
        ${sumBlock}<br>
        <strong>От имени:</strong> ${responsible.name}<br>
        <strong>📬 Ответы (Reply-To):</strong> ${responsible.email}<br>
        <strong>📋 Копия (BCC):</strong> ${responsible.email}</p>
        ${isNotSigned ? '<p style="color: var(--error-color); margin-top: 10px; font-weight: bold;">⚠️ ВНИМАНИЕ: Документ БЕЗ печати и подписи!</p>' : ''}
        <p style="margin-top: 15px;">
            <a href="${pdfUrl}" target="_blank" style="display: inline-block; background: #3498db; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 14px;">👁 Предпросмотр PDF</a>
        </p>
    </div>

    <div class="pdf-preview">
        <div class="pdf-preview-header">📄 Предпросмотр документа</div>
        <iframe src="${pdfUrl}"></iframe>
    </div>

    <div id="emailDisplay" class="email-display">
        📧 Получатель: <span id="selectedEmail">Не выбран</span>
    </div>
    
    <form method="POST" action="/send-email" onsubmit="return validateAndConfirm(event)">
        <input type="hidden" name="secret" value="${secret || ''}">
        <input type="hidden" name="docId" value="${docId}">
        <input type="hidden" name="pdfFileName" value="${pdfFileName}">
        
        <div class="form-group">
            <label>Кому:</label>
            <div class="radio-group">
                ${contactEmail ? `<div class="radio-item"><input type="radio" id="contact" name="toEmail" value="${contactEmail}" ${!legalEmail ? 'checked' : ''}><label for="contact">Контакт: ${contactName} (${contactEmail})</label></div>` : ''}
                ${legalEmail ? `<div class="radio-item"><input type="radio" id="legal" name="toEmail" value="${legalEmail}" ${!contactEmail ? 'checked' : ''}><label for="legal">Юрлицо: ${legalName} (${legalEmail})</label></div>` : ''}
            </div>
            ${!contactEmail && !legalEmail ? '<p style="color: var(--error-color);">⚠️ Email не указан ни у Контакта, ни у Юрлица</p>' : ''}
        </div>
        
        <div class="form-group">
            <label for="subject">Тема письма:</label>
            <input type="text" id="subject" name="subject" value="${defaultSubject}" required>
        </div>
        
        <div class="form-group">
            <label for="text">Текст письма:</label>
            <textarea id="text" name="text" rows="10" required>${defaultText}</textarea>
        </div>
        
        <div style="display: flex; gap: 15px; margin-top: 30px;">
            <button type="button" class="btn btn-secondary" onclick="window.close()" style="flex: 1;">Отмена</button>
            <button type="submit" class="btn btn-success" style="flex: 1;">📧 Отправить</button>
        </div>
    </form>
</div>

<div id="confirmModal" class="modal">
    <div class="modal-content">
        <div class="modal-icon">⚠️</div>
        <h2>Подтвердите отправку</h2>
        <div class="modal-details">
            <p><strong>📧 Кому:</strong> <span id="modalEmail"></span></p>
            <p><strong>📄 Документ:</strong> <span id="modalDoc"></span></p>
            <p><strong>💰 Итого к оплате:</strong> <span id="modalTotal"></span> BYN</p>
            ${vatType !== 'Без НДС' && vatRate > 0 ? `<p style="color: #7f8c8d; font-size: 13px;">${vatType === 'Начисляется сверху' ? `в т.ч. НДС (${vatRate}%): ${vatAmount.toFixed(2)} BYN` : `НДС (${vatRate}%) включён: ${vatAmount.toFixed(2)} BYN`}</p>` : ''}
            ${isNotSigned ? '<p style="color: var(--error-color); margin-top: 10px; font-weight: bold;">⚠️ ВНИМАНИЕ: Отправляется документ БЕЗ печати и подписи!</p>' : ''}
        </div>
        <p style="text-align: center; color: var(--text-secondary); font-size: 14px;">
            ${isNotSigned ? 'Вы уверены, что хотите отправить НЕПОДПИСАННЫЙ документ?' : 'Вы уверены, что хотите отправить письмо на этот адрес?'}
        </p>
        <div class="modal-buttons">
            <button type="button" class="btn btn-secondary" onclick="closeModal()" style="flex: 1;">❌ Отменить</button>
            <button type="button" class="btn btn-success" onclick="confirmSend()" style="flex: 1;">✅ Да, отправить</button>
        </div>
    </div>
</div>

<script>
function updateEmailDisplay() {
    const radios = document.querySelectorAll('input[name="toEmail"]');
    const emailDisplay = document.getElementById('selectedEmail');
    const emailBox = document.getElementById('emailDisplay');
    radios.forEach(radio => {
        radio.addEventListener('change', function() {
            if (this.checked) {
                const email = this.value;
                emailDisplay.textContent = email;
                const emailRegex = /^[^ @]+@[^ @]+\\.[^ @]+$/;
                if (!emailRegex.test(email)) { emailBox.classList.add('invalid'); emailDisplay.textContent = email + ' ⚠️ Неверный формат'; } 
                else { emailBox.classList.remove('invalid'); }
            }
        });
    });
    const checkedRadio = document.querySelector('input[name="toEmail"]:checked');
    if (checkedRadio) emailDisplay.textContent = checkedRadio.value;
}

function validateAndConfirm(event) {
    event.preventDefault();
    const selectedRadio = document.querySelector('input[name="toEmail"]:checked');
    if (!selectedRadio) { alert('⚠️ Пожалуйста, выберите получателя'); return false; }
    const email = selectedRadio.value;
    const emailRegex = /^[^ @]+@[^ @]+\\.[^ @]+$/;
    if (!emailRegex.test(email)) { alert('⚠️ Неверный формат email: ' + email); return false; }
    document.getElementById('modalEmail').textContent = email;
    document.getElementById('modalDoc').textContent = '${pdfFileName}';
    document.getElementById('modalTotal').textContent = '${totalWithVat.toFixed(2)}';
    document.getElementById('confirmModal').style.display = 'block';
    return false;
}

function closeModal() { document.getElementById('confirmModal').style.display = 'none'; }
function confirmSend() { closeModal(); document.querySelector('form').submit(); }
window.onclick = function(event) { if (event.target === document.getElementById('confirmModal')) closeModal(); }
document.addEventListener('DOMContentLoaded', updateEmailDisplay);
</script>
</body>
</html>`;
}

function getEmailSuccessHTML({ docId, docType, toEmail, pdfFileName, messageId }) {
    // v4.43.1: экранируем данные перед вставкой в HTML (тип документа/email приходят из БД).
    docType = escapeHtml(docType);
    toEmail = escapeHtml(toEmail);
    pdfFileName = escapeHtml(pdfFileName);
    messageId = escapeHtml(messageId);
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Email отправлен ✅</title>
<link rel="stylesheet" href="/shared-styles.css"><style>body { background: var(--success-gradient); } h1 { color: var(--success-color); } .info-box { border-left-color: var(--success-color); } .btn { background: var(--success-gradient); }</style></head>
<body><div class="container"><div class="icon">📧</div><h1>Email успешно отправлен!</h1><p class="subtitle">Документ доставлен клиенту</p>
<div class="info-box"><h3>📄 Документ</h3><p><strong>${docType}</strong> (ID: ${docId})<br>Файл: ${pdfFileName}</p></div>
<div class="info-box"><h3>👤 Получатель</h3><p><a href="mailto:${toEmail}" style="color: var(--success-color);">${toEmail}</a></p></div>
<div class="info-box" style="background: #d4edda; border-left-color: #28a745;"><h3 style="color: #155724;">✅ Статус</h3><p style="color: #155724;"><strong>Message ID:</strong> ${messageId}<br><strong>Статус в NocoDB:</strong> Отправлен<br><strong>PDF во вложении:</strong> ${pdfFileName}</p></div>
<p class="auto-close" style="color: var(--text-secondary); font-size: 13px; margin-top: 15px;">Эта вкладка закроется автоматически через 5 секунд...</p></div>
<script>setTimeout(() => window.close(), 5000);</script></body></html>`;
}

function getErrorHTML(errorMessage, docId, solutionText) {
    // 🆕 Классификация ошибок SMTP для понятных подсказок
    const errorType = classifySMTPError(errorMessage);

    let actionBlock = '';
    if (docId) {
        actionBlock = `<a href="/send-email?docId=${docId}" class="btn" style="margin-right: 10px;">🔄 Попробовать снова</a>
        <a href="javascript:window.close();" class="btn" style="background: #95a5a6;">Закрыть вкладку</a>`;
    } else {
        actionBlock = `<a href="javascript:window.close();" class="btn">Закрыть вкладку</a>`;
    }

    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ошибка ❌</title>
<link rel="stylesheet" href="/shared-styles.css">
<style>
body { background: var(--error-gradient); }
h1 { color: var(--error-color); }
.info-box { background: #fff5f5; border-left: 4px solid #e74c3c; border-radius: 8px; padding: 16px; text-align: left; margin-bottom: 16px; }
.info-box h3 { color: #c0392b; font-size: 16px; margin-bottom: 8px; }
.info-box p { color: #2c3e50; font-size: 14px; line-height: 1.6; }
.info-box strong { color: #2c3e50; }
.info-box code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
.btn { display: inline-block; background: #e74c3c; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 15px; margin-top: 16px; transition: background .2s; }
.btn:hover { background: #c0392b; }
</style></head>
<body><div class="container"><div class="icon">❌</div><h1>Ошибка отправки email</h1>
<p class="subtitle">${errorType.title}</p>
<div class="info-box"><h3>🔍 Что произошло?</h3><p>${errorType.description}</p>${errorType.technical ? `<p style="margin-top: 8px; font-size: 12px; color: #7f8c8d;">Техническая деталь: <code>${errorType.technical}</code></p>` : ''}</div>
<div class="info-box" style="background: #f8f9fa; border-left-color: #667eea;"><h3 style="color: #2c3e50;">💡 Что делать?</h3><p>${errorType.solution}</p></div>
<div style="margin-top: 20px;">${actionBlock}</div></div></body></html>`;
}

function classifySMTPError(message) {
    if (!message) return {
        title: 'Неизвестная ошибка',
        description: 'Произошла непредвиденная ошибка при отправке email.',
        solution: 'Проверьте подключение к интернету и попробуйте снова. Если ошибка повторяется — обратитесь к администратору.',
        technical: message
    };

    const msg = message.toLowerCase();

    // 🔐 Ошибки аутентификации
    if (msg.includes('invalid login') || msg.includes('authentication failed') || msg.includes('auth')) {
        return {
            title: 'Ошибка аутентификации SMTP',
            description: 'Неверный логин или пароль для подключения к почтовому серверу. Проверьте переменные <code>SMTP_USER</code> и <code>SMTP_PASS</code> в файле <code>.env</code>.',
            solution: 'Для Gmail/Яндекс/Mail.ru нужен <strong>App Password</strong> (пароль приложения), а не обычный пароль от аккаунта. Для cPanel убедитесь, что почтовый ящик существует и пароль верный. Перезапустите настройку email: <code>bash modules/email-install.sh</code>.',
            technical: message
        };
    }

    // 🌐 Ошибки подключения
    if (msg.includes('econnrefused') || msg.includes('connect')) {
        return {
            title: 'Не удалось подключиться к SMTP-серверу',
            description: 'Сервер отклонил подключение. Проверьте <code>SMTP_HOST</code> и <code>SMTP_PORT</code> в <code>.env</code>.',
            solution: 'Убедитесь, что сервер доступен: <code>telnet $SMTP_HOST $SMTP_PORT</code>. Для SSL/TLS используйте порт 465, для STARTTLS — порт 587. Проверьте файрвол и настройки сервера.',
            technical: message
        };
    }

    // ⏱️ Таймаут
    if (msg.includes('timeout') || msg.includes('timed out')) {
        return {
            title: 'Таймаут подключения к SMTP',
            description: 'Сервер не ответил за отведённое время.',
            solution: 'Проверьте интернет-соединение и доступность SMTP-сервера. Попробуйте снова через минуту. Если проблема повторяется — возможно, сервер временно недоступен.',
            technical: message
        };
    }

    // 📧 Невалидный email
    if (msg.includes('eenvelope') || msg.includes('recipient') || msg.includes('address')) {
        return {
            title: 'Некорректный email получателя',
            description: 'Указанный email не проходит валидацию почтового сервера.',
            solution: 'Проверьте, что email клиента заполнен в формате <code>name@example.com</code> (без пробелов, без кириллицы). Откройте карточку контакта в NocoDB и исправьте поле «E-mail».',
            technical: message
        };
    }

    // 📎 Ошибка вложения (PDF)
    if (msg.includes('file') || msg.includes('no such file') || msg.includes('ENOENT')) {
        return {
            title: 'PDF-файл не найден',
            description: 'Файл, который нужно прикрепить к письму, отсутствует на сервере.',
            solution: 'Сгенерируйте PDF заново через кнопку «Сгенерировать PDF» в боте или NocoDB. Убедитесь, что файл существует в папке <code>/mnt/data/noco-static/pdfs/</code>.',
            technical: message
        };
    }

    // 📡 Ошибка DNS
    if (msg.includes('dns') || msg.includes('getaddrinfo') || msg.includes('resolve')) {
        return {
            title: 'Ошибка DNS',
            description: 'Не удалось определить адрес SMTP-сервера.',
            solution: 'Проверьте правильность <code>SMTP_HOST</code> в <code>.env</code>. Убедитесь, что DNS работает: <code>nslookup $SMTP_HOST</code>.',
            technical: message
        };
    }

    // 🚫 Заблокировано / rate limit
    if (msg.includes('rate') || msg.includes('limit') || msg.includes('blocked') || msg.includes('throttl')) {
        return {
            title: 'Превышен лимит отправок',
            description: 'Почтовый сервер ограничил количество отправленных писем.',
            solution: 'Подождите несколько минут и попробуйте снова. Для Gmail лимит — 500 писем/день, для cPanel — обычно 100-500/час. Проверьте настройки лимитов на хостинге.',
            technical: message
        };
    }

    // ❓ Неизвестная ошибка — fallback
    return {
        title: 'Ошибка',
        description: `Произошла ошибка: <code>${message}</code>`,
        solution: 'Проверьте настройки и попробуйте снова. При повторной ошибке — обратитесь к администратору.',
        technical: message
    };
}

function getPDFNotFoundHTML(fileName, docId, showGenerateBtn) {
    const retryLink = docId ? `/generate-pdf?docId=${docId}` : 'javascript:history.back()';
    let buttons = '';
    if (showGenerateBtn !== false) {
        buttons = `<a href="${retryLink}" class="btn">🔄 Сгенерировать PDF</a>`;
    }
    buttons += `<a href="javascript:window.close();" class="btn" style="background: #95a5a6; margin-left: 10px;">Закрыть вкладку</a>`;
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PDF не найден 📄</title>
<link rel="stylesheet" href="/shared-styles.css">
<style>
body { background: var(--warning-gradient); }
h1 { color: var(--warning-color); }
.info-box { background: #fff3cd; border-left: 4px solid #ffc107; border-radius: 8px; padding: 16px; text-align: left; margin-bottom: 16px; }
.info-box h3 { color: #856404; font-size: 16px; margin-bottom: 8px; }
.info-box p { color: #2c3e50; font-size: 14px; line-height: 1.6; }
.info-box code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
.btn { display: inline-block; background: #ffc107; color: #2c3e50; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 15px; margin-top: 16px; font-weight: 600; transition: background .2s; }
.btn:hover { background: #e0a800; }
</style></head>
<body><div class="container"><div class="icon">📄</div><h1>PDF-файл не найден</h1>
<p class="subtitle">Невозможно открыть или отправить документ</p>
<div class="info-box"><h3>🔍 Что произошло?</h3><p>Файл <code>${fileName}</code> отсутствует на сервере. PDF ещё не был сгенерирован или был удалён.</p></div>
<div class="info-box" style="background: #f8f9fa; border-left-color: #667eea;"><h3 style="color: #2c3e50;">💡 Что делать?</h3><p>Нажмите кнопку <strong>«Сгенерировать PDF»</strong> в боте или через формулу-кнопку в NocoDB. После успешной генерации файл появится и будет доступен для отправки.</p></div>
<div style="margin-top: 20px;">${buttons}
</div></div></body></html>`;
}

function getNoProjectHTML() {
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Документ не привязан к проекту 🔗</title><link rel="stylesheet" href="/shared-styles.css">
<style>body { background: var(--error-gradient); } h1 { color: var(--error-color); } .info-box { background: #fff5f5; border-left-color: var(--error-color); } .info-box h3 { color: #c0392b; } .btn { background: var(--error-color); }</style></head>
<body><div class="container"><div class="icon">🔗</div><h1>Документ не привязан к проекту</h1><p class="subtitle">Невозможно сгенерировать PDF без привязки к проекту</p>
<div class="info-box"><h3>🔍 Что произошло?</h3><p>Система не может определить, чьи реквизиты использовать и куда сохранить файл.</p></div>
<div class="info-box" style="background: #f8f9fa; border-left-color: #667eea;"><h3 style="color: #2c3e50;">💡 Что делать?</h3><p>Откройте карточку документа в NocoDB и выберите проект в поле <strong>"Проект"</strong>.</p></div>
<a href="javascript:window.close();" class="btn">Закрыть вкладку</a></div></body></html>`;
}

function getNoTypeHTML() {
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Тип документа не указан 🏷️</title><link rel="stylesheet" href="/shared-styles.css">
<style>body { background: var(--warning-gradient); } h1 { color: var(--warning-color); } .info-box { background: #fff3cd; border-left-color: var(--warning-color); } .info-box h3 { color: #856404; } .info-box p, .info-box li { color: #856404; } .btn { background: var(--warning-color); color: #fff; }</style></head>
<body><div class="container"><div class="icon">🏷️</div><h1>Тип документа не указан</h1><p class="subtitle">Невозможно сгенерировать или открыть документ</p>
<div class="info-box"><h3>💡 Что делать?</h3><p>Заполните поле <strong>"Тип документа"</strong> в карточке документа в NocoDB.</p>
<p style="margin-top: 10px;">Допустимые значения:</p><ul style="margin-left: 20px; margin-top: 5px; line-height: 1.8;">
<li>📄 <strong>Счет</strong> — счёт-договор</li><li>✅ <strong>Акт</strong> — акт выполненных работ</li><li>📦 <strong>Накладная</strong> или <strong>ТН</strong> — товарная накладная</li></ul></div>
<a href="javascript:window.close();" class="btn">Закрыть вкладку</a></div></body></html>`;
}

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Сервер запущен на порту ${PORT}`));