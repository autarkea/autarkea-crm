// ============================================================================
// shared/columns.js
// ============================================================================
// Автоматически сгенерировано modules/generate-columns-map.sh v2.0.0
// НЕ РЕДАКТИРУЙТЕ ВРУЧНУЮ — файл будет перезаписан при следующей генерации!
// 
// Использование в коде:
//   const COL = require('../shared/columns');
//   const title = task[COL.TASK_TITLE];  // вместо task['Что делаем?']
//
// Обновлено: 22 июля 2026 (полная выгрузка из template.db)
// Всего бизнес-колонок: 104 (исключены системные NocoDB и M2M связи)
// ============================================================================

module.exports = {

    // =========================================================================
    // Таблица "Дела"
    // =========================================================================
    TASK_TITLE: 'cxs4ircqgys9qde',  // "Что делаем?"
    TASK_DEADLINE: 'czwbwzib8o07193',  // "Когда делаем"
    TASK_DONE_DATE: 'cffnxg7yutqfe92',  // "Когда сделали"
    TASK_LAST_MODIFIED: 'cwqw3r4o83drk9d',  // "Последнее изменение"
    TASK_DONE: 'c6qf5nfyv8clmcf',  // "Готово"
    TASK_STATUS: 'c9yga0c884uv8v1',  // "Статус"
    TASK_PROJECT: 'ce4qyca9xgdttia',  // "Какой проект"
    TASK_EXECUTOR: 'chsnlrm09zs2es7',  // "Исполнитель"

    // =========================================================================
    // Таблица "Документы"
    // =========================================================================
    DOC_NAME: 'c1hosp5m3y1lm0o',  // "Название"
    DOC_PROJECT: 'co0d0j7gioampq0',  // "Проект"
    DOC_TYPE: 'cbhct5koq553f4z',  // "Тип документа"
    DOC_DATE: 'crt6mtt1szqmktu',  // "Дата документа"
    DOC_OFFER_DATE: 'cgcirkai2qfrhkq',  // "Дата оферты"
    DOC_LAST_PDF_DATE: 'cgbs77sq01fjfdp',  // "Дата последнего PDF"
    DOC_LAST_EDIT_DATE: 'ccgimx08visz147',  // "Дата последней редакции"
    DOC_TN_NUMBER: 'c6bbz4463ua1wh7',  // "Номер ТН"
    DOC_SIGNED: 'ctu92ci9ty4qoaj',  // "С печатью"
    DOC_STATUS: 'c43tpbpua2hu9uj',  // "Статус"
    DOC_PROJECT_STATUS: 'cpek2pv8ewa2v74',  // "Статус проекта"
    DOC_PAYMENT: 'cbsswha1xidykzf',  // "Оплата"
    DOC_INVOICE_TERM: 'c94cppl3lc47ype',  // "Срок счета"
    DOC_EXECUTION_TERM: 'cpfxdbrcz4mnede',  // "Срок выполнения"
    DOC_TERM_STARTS: 'cbje4v6vfnmj3xa',  // "Срок начинается с"
    DOC_DELIVERY: 'c8dq4sbbza1hmdw',  // "Доставка"
    DOC_RESPONSIBLE: 'c6l1ck4pdl1fl65',  // "Ответственный"
    DOC_DATA: 'c73w5d4femefdru',  // "Данные"
    DOC_PDF_GENERATED: 'c6e8wkja1pv6z74',  // "PDF сгенерирован"
    DOC_INTELLECTUAL: 'cv9ni43m6u4lyir',  // "Интеллектуалка"
    DOC_PORTFOLIO: 'c0zgeyysonrcwfu',  // "Портфолио"
    DOC_GENERATE_BUTTON: 'cd2jyopqldjipu2',  // "Генерировать PDF"
    DOC_OPEN_BUTTON: 'cifoye90w1upm3u',  // "Открыть документ"
    DOC_SEND_BUTTON: 'c4f0g11kxjwqoak',  // "Отправить"

    // =========================================================================
    // Таблица "Контакты"
    // =========================================================================
    CONTACT_NAME: 'ciq30q38j7l0w91',  // "Имя"
    CONTACT_PHONE: 'cf6gqr1ysok8698',  // "Телефон"
    CONTACT_EMAIL: 'cgo1yca3qzp2c58',  // "E-mail"
    CONTACT_MESSENGER: 'ctmk93b0m1qqk3h',  // "Мессенджер"
    CONTACT_TG_ID: 'c3atksvbywgvsid',  // "TG ID"
    CONTACT_LINK: 'c4j7urikbs911jm',  // "Ссылка"
    CONTACT_INFO: 'c9ge50wk936q4rv',  // "Доп. информация"
    CONTACT_CLIENT_ID: 'c8c2mdbayhxtbij',  // "Client ID"
    CONTACT_ORGANIZATION: 'cccymiivj9ekdzq',  // "Организация"
    CONTACT_PROJECTS: 'cwphr7vuj65fn7h',  // "Проекты"

    // =========================================================================
    // Таблица "Мои реквизиты"
    // =========================================================================
    MY_NAME: 'cydiuk9op1w2xt3',  // "Имя"
    MY_UNP: 'czk5uoyefy7l563',  // "УНП"
    MY_ADDRESS: 'camt24ie95m4ict',  // "Адрес"
    MY_PHONE: 'cjo9bl8boermyio',  // "Телефон"
    MY_EMAIL: 'cj10480uoiwp171',  // "E-mail"
    MY_IBAN: 'cex83ksdpaiokle',  // "р/с"
    MY_BIK: 'c603ssd5snyt1ad',  // "БИК"
    MY_BANK: 'cnwix6ae1q8f5u4',  // "Банк"
    MY_WEBSITE: 'c3f2gffaoeby62n',  // "Сайт"
    MY_SIGNATORY: 'cconui1i8lfit1g',  // "Подписант"
    MY_SIGNATORY_NAME: 'cmi0lzw5gvxky3z',  // "Подписант ФИО"
    MY_VAT_RATE: 'cglz43e1egu9o8i',  // "Ставка НДС"
    MY_VAT_TYPE: 'ctu87pnsna7x175',  // "Тип НДС"

    // =========================================================================
    // Таблица "Позиции заказа"
    // =========================================================================
    ITEM_NAME: 'cld2hl2cgen63t4',  // "Название"
    ITEM_PRICE: 'c9ygl8dnh66tsg7',  // "Цена"
    ITEM_QTY: 'cidnl96iu7aingp',  // "Кол-во"
    ITEM_TOTAL: 'cfbuh2zvkuy0z20',  // "Сумма"
    ITEM_NAME_TN: 'cebs5jj5cnu7nf5',  // "Название (ТН)"
    ITEM_TYPE: 'c2bw233pwr12vnh',  // "Тип"
    ITEM_PROJECTS: 'c75qnz9rikruq4s',  // "Проекты"
    ITEM_PROJECT_STATUS: 'c5qto5hdmx38u7n',  // "Статус Проекта"

    // =========================================================================
    // Таблица "Проекты"
    // =========================================================================
    PROJECT_TITLE: 'c9xj609v8iql6cu',  // "Что делаем?"
    PROJECT_STATUS: 'cvhy5zvs7nds74g',  // "Статус"
    PROJECT_ACTIVE: 'c8djg41r03hlwrm',  // "Активно"
    PROJECT_CONTACT: 'c27nrth16z5v4gc',  // "Контакт"
    PROJECT_LEGAL: 'cgpeog4whdx5e1a',  // "Юрлицо"
    PROJECT_MANAGER: 'cugfap1g9qb9h9o',  // "Менеджер"
    PROJECT_DETAILS: 'cculsmh4qv6qhfn',  // "Подробности"
    PROJECT_FILES: 'c7uid856cfmcbtn',  // "Файлы в папке"
    PROJECT_CREATED_AT: 'c1o9u9s8jpjxfew',  // "Дата и время создания"
    PROJECT_LAST_MODIFIED: 'c80w0kmn6fpsdq0',  // "Последнее изменение"
    PROJECT_MONEY_STATUS: 'cll1hljbk0sr4b8',  // "По деньгам?"
    PROJECT_PREPAYMENT: 'c0fkou9kxkv80vg',  // "Предоплата"
    PROJECT_CONTACT_PHONE: 'c5g8vkumyzl63jk',  // "Конт. тел."
    PROJECT_TASKS: 'cch43tqibo0dc4i',  // "Дела"
    PROJECT_DOCUMENTS: 'cutfpoxp7pkhq5v',  // "Документы"
    PROJECT_ITEMS: 'ccn07koq0b0l8mf',  // "Позиции заказа"
    PROJECT_CREATE_FOLDER_BUTTON: 'cvqipxhjearutgy',  // "Создать папку проекта"
    PROJECT_UPDATE_FILES_BUTTON: 'ccz2l3guocbtzwc',  // "Обновить список файлов"

    // =========================================================================
    // Таблица "Сотрудники"
    // =========================================================================
    EMPLOYEE_FULLNAME: 'cauw4q2lpuejke4',  // "ФИО"
    EMPLOYEE_GREETING: 'c8ix68g3z8dqos9',  // "Обращение"
    EMPLOYEE_TG_ID: 'c8tsqq0rvuf9s5g',  // "Telegram_ID"
    EMPLOYEE_TG_USERNAME: 'cjmzsxg46si07fg',  // "Telegram_UserName"
    EMPLOYEE_ROLE: 'ccgzd1udfoafea0',  // "Роль"
    EMPLOYEE_POSITION: 'c74qymv13en5lu5',  // "Должность"
    EMPLOYEE_PHONE: 'c601j8s9n6i26s9',  // "Телефон"
    EMPLOYEE_EMAIL: 'c9drxg1yzf8y1qu',  // "E-mail"
    EMPLOYEE_ACTIVE: 'c8x4qxwz1z2xz9s',  // "Активен"
    EMPLOYEE_CREATED_AT: 'cky8ekr031qarjx',  // "Дата создания"
    EMPLOYEE_TASKS: 'cp0t6s12q2jjtii',  // "Дела"
    EMPLOYEE_PROJECTS: 'cwrbhkwqs9z56ps',  // "Проекты"

    // =========================================================================
    // Таблица "Юрлица"
    // =========================================================================
    LEGAL_NAME: 'chw96mnkrlcn9cd',  // "Имя"
    LEGAL_UNP: 'ci8f621bwpy725y',  // "УНП"
    LEGAL_ADDRESS: 'ctta2sx7bnzyebc',  // "Адрес"
    LEGAL_DELIVERY_ADDRESS: 'cvx4emydwxo4960',  // "Адрес доставки"
    LEGAL_PHONE: 'czjwadvpjmnvx4w',  // "Телефон"
    LEGAL_EMAIL: 'cigvetb3xkemv23',  // "E-mail"
    LEGAL_CLIENT_ID: 'cn6bfhq3f2pt69v',  // "Client ID"
    LEGAL_BIK: 'cspyq86ad5td26f',  // "БИК"
    LEGAL_BANK: 'c470sxughpj0ikx',  // "Банк"
    LEGAL_IBAN: 'cbk2evqsldwfw7a',  // "р/с"
    LEGAL_EXTRA_INFO: 'cmxu0siikv4bfy1',  // "Дополнительно"
    LEGAL_CONTACT_PERSON: 'cyzqbprdn7u9agx',  // "Контакт/ответственный"
    LEGAL_PROJECTS: 'cjs4z2811wniv8g',  // "Проекты"
};
