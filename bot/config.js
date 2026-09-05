// Способы связи (единый источник правды для клавиатуры выбора мессенджера).
// name — значение, которое пишется в колонку «Мессенджер» таблицы «Контакты»
//        (должно совпадать с опциями селекта в NocoDB!);
// icon — эмодзи на кнопке.
// ⚠️ При изменении — синхронизировать с опциями селекта «Мессенджер» в БД
//    (modules/add-select-options.sh), см. документацию «Роли баз данных».
const MESSENGERS = [
    { name: 'Telegram',   icon: '💬' },
    { name: 'Viber',      icon: '📱' },
    { name: 'Куфар',      icon: '🛒' },
    { name: 'WhatsApp',   icon: '🟢' },
    { name: 'Instagram',  icon: '📸' },
    { name: 'ВКонтакте',  icon: '🌐' },
    { name: 'Иное',       icon: '💼' }
];

module.exports = {
    // Telegram
    TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    MY_ID: parseInt(process.env.TELEGRAM_USER_ID),
    CRON_TIME: process.env.MORNING_CRON || '0 10 * * *',
    REMINDER_CRON: process.env.REMINDER_CRON || '*/5 * * * *', // v4.27.0 (Проблема 92): частота проверки напоминаний о дедлайнах
    // v4.28.4: часовой пояс для дат и напоминаний — из .env (TZ), а не хардкод Europe/Minsk.
    // Дефолт остаётся Минск (UTC+3), чтобы не менять поведение существующих систем.
    TZ: process.env.TZ || 'Europe/Minsk',
    
    // NocoDB
    // v4.28.1 (мина): раньше дефолт содержал лишний /api/v1/db/data, а bot.js добавляет
    // его при КАЖДОМ запросе → если NOCO_URL пропадал из .env, адрес задваивался
    // (…/api/v1/db/data/api/v1/db/data/noco/…) и бот молча терял базу.
    // Теперь: дефолт чистый + нормализация (срежем кусок, если в .env вставили адрес
    // с ним — например, из чужой документации).
    NOCO_URL: (process.env.NOCO_URL || 'http://nocodb:8080').replace(/\/api\/v1\/db\/data$/, ''),
    NOCO_TOKEN: process.env.NOCO_TOKEN,
    BASE_ID: process.env.BASE_ID,
    
    // Таблицы (ID будут найдены автоматически при первом запуске!)
    TABLES: {
        TASKS: process.env.TABLE_TASKS,
        CONTACTS: process.env.TABLE_CONTACTS,
        PROJECTS: process.env.TABLE_PROJECTS,
        DOCUMENTS: process.env.TABLE_DOCUMENTS,
        ITEMS: process.env.TABLE_ITEMS,
        LEGAL_ENTITIES: process.env.TABLE_LEGAL_ENTITIES,
        MY_DETAILS: process.env.TABLE_MY_DETAILS,
        EMPLOYEES: process.env.TABLE_EMPLOYEES
    },

    MESSENGERS,
    // Производный список имён (для валидации, если понадобится)
    VALID_MESSENGERS: MESSENGERS.map(m => m.name)
};
