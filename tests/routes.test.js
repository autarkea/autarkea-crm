// ============================================================================
// tests/routes.test.js — реестр callback_data (bot/routes.js)
// ============================================================================
// Запуск (Node на хосте, без контейнеров и зависимостей):
//   node --test tests/
//
// Проверяет:
//   1. matchCallbackBlock классифицирует ВСЕ известные колбэки в свои блоки.
//   2. Блоки A и B НЕ пересекаются (ни один колбэк/префикс одного блока не
//      попадает под правило другого) — защита от «двойной обработки», правило
//      «ровно один слушатель на событие».
//   3. Неизвестные/битые колбэки → null (диспетчер молчит).
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { BLOCK_A, BLOCK_B, matchCallbackBlock, isAdminOnlyCallback, isManagerOnlyCallback, isDocsSendOnlyCallback } = require('../bot/routes');

const EXACT_LIST = { A: BLOCK_A.exacts, B: BLOCK_B.exacts };
const PREFIX_LIST = { A: BLOCK_A.prefixes, B: BLOCK_B.prefixes };
const REGEX_LIST = { A: BLOCK_A.regexes, B: BLOCK_B.regexes };

// ─────────────── Классификация известных колбэков по блокам ─────────────────
test('Каждый точный колбэк блока A классифицируется как A', () => {
    for (const data of BLOCK_A.exacts) {
        assert.equal(matchCallbackBlock(data), 'A', `exact A: ${data}`);
    }
});

test('Каждый точный колбэк блока B классифицируется как B', () => {
    for (const data of BLOCK_B.exacts) {
        assert.equal(matchCallbackBlock(data), 'B', `exact B: ${data}`);
    }
});

test('Префиксные колбэки с реальными суффиксами — в свои блоки', () => {
    const samples = {
        A: ['done_123', 'pcard_42', 'ccard_7', 'lcard_3', 'proj_contact_11',
            'dl_2h', 'messenger_skip', 'task_exec_99', 'project_12',
            'pst_set_5_2', 'pst_5_1', 'append_to_proj_8', 'pnewtask_6',
            'pattach_6', 'assign_exec_1_2', 'pick_exec_1_2', 'keep_common_5',
            'reject_task_5', 'cancel_assign_5', 'edit_123', 'proj_legal_4',
            'ptransfer_set_9_1', 'ptransfer_9_1', 'arch_card_10', 'view_11',
            'ptasks_10_0', 'ptask_new_10', 'pnote_10', 'pdeadline_10',
            'proj_items_10', 'pitem_5_10', 'pitem_new_10', 'pitem_save', 'pitem_cancel',
            'docs_list_10', 'docs_new_10', 'docs_card_3_10', 'docs_pdf_3_10', 'docs_create_10',
            // v4.42.5: предпросмотр email перед отправкой (docs_send_yes_/no_/to_ — те же префиксы)
            'docs_send_3_10', 'docs_send_yes_3_10', 'docs_send_no_3_10', 'docs_send_to_1_3_10',
            'pay_10', 'pay_add_10',
            // v4.43.0: правка карточки контакта/юрлица + привязка контакта к юрлицу
            'cc_edit_5', 'cc_field_5_name', 'ccmsg_5_Telegram', 'cc_link_5', 'cc_unlink_5',
            'org_pick_5_3', 'org_search_5', 'org_cancel_5', 'lc_edit_3', 'lc_field_3_unp', 'lc_page_3_bank'],
        B: ['folder_proj_3', 'folder_yes_3', 'files_proj_3', 'file_task_4',
            'file_proj_5', 'comment_task_6', 'fwd_append_7',
            'hidden_select_contact_1', 'hidden_select_project_2',
            'forward_select_contact_3', 'forward_select_project_4',
            // v4.45.0: навигация страниц селекторов блока B
            'pcm_1', 'pft_0', 'pfu_2', 'pfd_1', 'pfl_0']
    };
    for (const block of ['A', 'B']) {
        for (const data of samples[block]) {
            assert.equal(matchCallbackBlock(data), block, `sample ${block}: ${data}`);
        }
    }
});

test('Пагинация списков и задач проекта (regex) — блок A', () => {
    const pageNav = [];
    for (const p of ['tl', 'td', 'hl', 'cl', 'pl', 'll', 'al']) {
        pageNav.push(`${p}_0`, `${p}_12`);
    }
    for (const data of [...pageNav, 'ptl_1_0', 'ptl_10_3', 'ptj_0', 'ptj_2']) {
        assert.equal(matchCallbackBlock(data), 'A', `nav: ${data}`);
    }
});

// ─────────────── Отсутствие пересечений между блоками ───────────────────────
test('Ни один exact блока A не начинается с префикса блока B', () => {
    for (const exact of BLOCK_A.exacts) {
        for (const prefix of BLOCK_B.prefixes) {
            assert.equal(exact.startsWith(prefix), false,
                `exact A «${exact}» пересекается с prefix B «${prefix}»`);
        }
    }
});

test('Ни один exact блока B не начинается с префикса блока A', () => {
    for (const exact of BLOCK_B.exacts) {
        for (const prefix of BLOCK_A.prefixes) {
            assert.equal(exact.startsWith(prefix), false,
                `exact B «${exact}» пересекается с prefix A «${prefix}»`);
        }
    }
});

test('Ни один exact одного блока не равен exact другого', () => {
    const setB = new Set(BLOCK_B.exacts);
    for (const exact of BLOCK_A.exacts) {
        assert.equal(setB.has(exact), false, `exact A «${exact}» есть и в B`);
    }
});

test('Regex-правила A не матчат колбэки блока B', () => {
    for (const data of [...BLOCK_B.exacts, ...BLOCK_B.prefixes.map(p => p + '1')]) {
        for (const re of BLOCK_A.regexes) {
            assert.equal(re.test(data), false,
                `regex A ловит колбэк B «${data}»`);
        }
    }
});

// ─────────── Guard «только для Руководителя» (заявки и передача) ────────────
test('Заявки и передача проекта — колбэки только для Руководителя', () => {
    const adminOnly = [
        'assign_exec_123', 'pick_exec_123_2', 'keep_common_123',
        'reject_task_123', 'cancel_assign_123', 'ptransfer_5',
        'ptransfer_set_5_2'
    ];
    for (const data of adminOnly) {
        assert.equal(isAdminOnlyCallback(data), true, `adminOnly: ${data}`);
    }
});

test('Обычные колбэки (задачи/проекты/файлы/визарды) — НЕ admin-only', () => {
    const notAdminOnly = [
        'done_123', 'edit_123', 'pcard_5', 'pst_5_1', 'ptasks_5_0',
        'folder_yes_3', 'comment_task_6', 'file_proj_5', 'dl_2h',
        'show_today', 'noop', 'tl_0', 'pnewtask_5', 'task_exec_123'
    ];
    for (const data of notAdminOnly) {
        assert.equal(isAdminOnlyCallback(data), false, `notAdminOnly: ${data}`);
    }
});

// ─────── Guard «задачи/папки/файлы проекта — Менеджер+» (не Исполнитель) ────
test('Задачи/папки/файлы/контакты проекта — колбэки НЕ для Исполнителя', () => {
    const managerOnly = [
        'pnewtask_5', 'file_proj_5', 'folder_proj_5',
        'folder_yes_5', 'files_proj_5', 'append_to_proj_5',
        // v4.42.1: позиции заказа — ведение сделки, Менеджер+ (не Исполнитель)
        'proj_items_5', 'pitem_new_5', 'pitem_12_5', 'pitem_save', 'pitem_cancel',
        // v4.42.2: документы проекта — Менеджер+ (создание/PDF)
        'docs_list_5', 'docs_new_5', 'docs_card_2_5', 'docs_pdf_2_5', 'docs_create_5',
        // v4.42.5: отправка по email (включая предпросмотр/подтверждение)
        'docs_send_2_5', 'docs_send_yes_2_5', 'docs_send_no_2_5', 'docs_send_to_1_2_5',
        'pay_5', 'pay_add_5',
        // v4.43.0: правка карточки контакта/юрлица + привязка контакта к юрлицу
        'cc_edit_5', 'cc_field_5_name', 'ccmsg_5_Telegram', 'cc_link_5', 'cc_unlink_5',
        'org_pick_5_3', 'org_search_5', 'org_cancel_5', 'lc_edit_3', 'lc_field_3_unp',
        'hidden_create_new', 'hidden_add_to_contact', 'hidden_cancel',
        'hidden_select_contact_1', 'hidden_select_project_2',
        'forward_create_new', 'forward_add_to_contact', 'forward_show_all_contacts',
        'forward_select_contact_3', 'forward_add_to_project', 'forward_select_project_4'
    ];
    for (const data of managerOnly) {
        assert.equal(isManagerOnlyCallback(data), true, `managerOnly: ${data}`);
    }
});

test('Задачи-для-исполнителя и обычные колбэки — НЕ manager-only', () => {
    const notManagerOnly = [
        'file_task_4', 'done_123', 'comment_task_6', 'fwd_append_7',
        'fwd_cancel', 'forward_cancel', 'dl_2h', 'noop', 'tl_0',
        'assign_exec_123'
    ];
    for (const data of notManagerOnly) {
        assert.equal(isManagerOnlyCallback(data), false, `notManagerOnly: ${data}`);
    }
});

// ─────── Guard отправки документов «наружу» (v4.42.3, флаг «Отправка документов») ──
test('Отправка документа (email/вручную) — callback «наружу»', () => {
    const sendOnly = ['docs_send_2_5', 'docs_manual_2_5', 'docs_manual_yes_2_5',
        // v4.42.5: предпросмотр и его подтверждения — тоже «выстрел наружу»
        'docs_send_yes_2_5', 'docs_send_no_2_5', 'docs_send_to_0_2_5',
        'pay_5', 'pay_add_5'];
    for (const data of sendOnly) {
        assert.equal(isDocsSendOnlyCallback(data), true, `sendOnly: ${data}`);
    }
    const notSendOnly = ['docs_list_5', 'docs_create_5', 'docs_pdf_2_5', 'docs_new_5', 'docs_card_2_5', 'docs_type_Счет_5', 'pcard_5', 'pitem_1_5'];
    for (const data of notSendOnly) {
        assert.equal(isDocsSendOnlyCallback(data), false, `notSendOnly: ${data}`);
    }
});

// ───────────────────────── Неизвестные колбэки ──────────────────────────────
test('Неизвестные/битые колбэки → null', () => {
    assert.equal(matchCallbackBlock(''), null);
    assert.equal(matchCallbackBlock(null), null);
    assert.equal(matchCallbackBlock(undefined), null);
    assert.equal(matchCallbackBlock('unknown_1'), null);
    assert.equal(matchCallbackBlock('old_broken_button_2025'), null);
    assert.equal(matchCallbackBlock('done'), null);        // без суффикса — не колбэк
    assert.equal(matchCallbackBlock('tl'), null);          // пагинация требует _N
    assert.equal(matchCallbackBlock('tl_x'), null);        // не число
    assert.equal(matchCallbackBlock('folder_proj'), null); // без ID
});
