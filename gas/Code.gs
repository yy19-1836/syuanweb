/**
 * 金脆坊 線上訂單 ─ Google Apps Script 後端
 *
 * 功能：
 *  - doPost：接收網站結帳資料 → 驗證 → 以「菜單」工作表重新計價 → 產生訂單編號 → 寫入試算表 → 寄確認信
 *  - doGet ：健康檢查（?action=ping）與訂單查詢（?action=status&id=訂單編號&phone=手機）
 *  - 試算表選單「金脆坊」：初始化工作表、今日營收統計
 *  - 訂單狀態改為「可取餐」或「已出貨」時，自動寄信通知顧客（需執行一次 setup 建立觸發器）
 *
 * 部署步驟請見 gas/README.md
 */

/* ===================== 設定 ===================== */
const CONFIG = {
  SHOP_NAME: '金脆坊 鍋貼專賣',
  SHOP_EMAIL: '',            // 店家收單通知信箱；留空 = 寄給試算表擁有者
  SEND_CUSTOMER_EMAIL: true, // 是否寄確認信給顧客
  SHIPPING_FEE: 150,         // 宅配運費
  FREE_SHIP: 1000,           // 滿額免運
  MAX_QTY: 99,
  TIMEZONE: 'Asia/Taipei'
};
const SHEET = { ORDERS: '訂單', ITEMS: '訂單明細', MENU: '菜單' };
const STATUSES = ['新訂單', '製作中', '可取餐', '已出貨', '已完成', '已取消'];
const METHOD_NAME = { dinein: '內用', takeout: '外帶', delivery: '宅配' };
const ORDER_HEADERS = ['訂單編號', '建立時間', '狀態', '取餐方式', '姓名', '手機', 'Email', '地址', '備註', '商品明細', '商品小計', '運費', '應付總額', '來源', '通知紀錄'];
const ITEM_HEADERS = ['訂單編號', '建立時間', '品項ID', '品名', '單價', '數量', '小計'];
const MENU_HEADERS = ['品項ID', '品名', '單價', '上架'];
// 與網站 index.html 的 MENU / GIFTS 相同；setup() 會用它建立「菜單」工作表，之後價格以試算表為準
const DEFAULT_MENU = [
  ['p1', '招牌豬肉鍋貼（10 顆）', 85], ['p2', '韭菜鍋貼（10 顆）', 85], ['p3', '蝦仁鮮肉鍋貼（10 顆）', 110], ['p4', '川味麻辣鍋貼（10 顆）', 95],
  ['d1', '招牌水餃（12 顆）', 90], ['d2', '高麗菜水餃（12 顆）', 85], ['d3', '紅油抄手（8 顆）', 95], ['d4', '玉米鮮肉水餃（12 顆）', 90],
  ['s1', '酸辣湯', 50], ['s2', '玉米濃湯', 45], ['s3', '冰紅茶（大杯）', 30], ['s4', '手作冬瓜檸檬', 45],
  ['k1', '涼拌小黃瓜', 40], ['k2', '滷蛋（2 顆）', 30], ['k3', '泡菜小盤', 35], ['k4', '蔥油拌麵', 55],
  ['g1', '招牌招財鍋貼禮盒（50 入）', 480], ['g2', '雙拼節慶伴手禮盒（40 入）', 560]
];

/* ===================== Web API ===================== */
function doPost(e) {
  try {
    const data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (data.website) return json_({ ok: true, orderId: 'IGNORED' }); // 機器人陷阱欄位
    const order = validate_(data);
    const saved = saveOrder_(order);
    notify_(saved);
    return json_({ ok: true, orderId: saved.id, subtotal: saved.subtotal, shipping: saved.shipping, total: saved.total, method: saved.method, emailSent: saved.emailSent });
  } catch (err) {
    const msg = err && err.userMessage ? err.userMessage : '系統忙碌中，請稍後再試或來電門市。';
    if (!(err && err.userMessage)) console.error(err && err.stack || err);
    return json_({ ok: false, error: msg });
  }
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'status') {
    const row = findOrder_(String(p.id || '').trim());
    if (!row || String(row[5]) !== String(p.phone || '').trim()) return json_({ ok: false, error: '查無此訂單' });
    return json_({ ok: true, orderId: row[0], status: row[2], method: row[3], total: row[12] });
  }
  return json_({ ok: true, service: CONFIG.SHOP_NAME + ' 訂單 API', time: new Date().toISOString() });
}

/* ===================== 驗證與計價 ===================== */
function fail_(msg) { const e = new Error(msg); e.userMessage = msg; throw e; }
function clean_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
// 避免顧客輸入的文字在試算表中被當成公式
function safeCell_(v) { return /^[=+\-@]/.test(v) ? "'" + v : v; }

function validate_(d) {
  const c = d.customer || {};
  const o = {
    method: clean_(d.method, 20),
    name: clean_(c.name, 40), phone: clean_(c.phone, 20), email: clean_(c.email, 120),
    address: clean_(c.address, 200), note: clean_(c.note, 300), source: clean_(d.source, 40) || 'web'
  };
  if (!METHOD_NAME[o.method]) fail_('取餐方式不正確');
  if (!o.name) fail_('請填寫姓名');
  if (!/^09\d{8}$/.test(o.phone)) fail_('手機號碼格式不正確');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email)) fail_('Email 格式不正確');
  if (o.method === 'delivery' && !o.address) fail_('宅配請填寫收件地址');
  if (o.method !== 'delivery') o.address = '';

  const menu = getMenu_();
  const qty = {};
  (Array.isArray(d.items) ? d.items : []).forEach(it => {
    const id = clean_(it && it.id, 20), q = Math.floor(Number(it && it.qty));
    if (!menu[id]) fail_('部分商品已下架或不存在，請重新整理頁面後再試');
    if (!(q >= 1 && q <= CONFIG.MAX_QTY)) fail_('商品數量不正確');
    qty[id] = (qty[id] || 0) + q;
  });
  o.lines = Object.keys(qty).map(id => ({ id, name: menu[id].name, price: menu[id].price, qty: qty[id], amount: menu[id].price * qty[id] }));
  if (!o.lines.length) fail_('購物車是空的');
  o.subtotal = o.lines.reduce((s, l) => s + l.amount, 0);
  o.shipping = (o.method === 'delivery' && o.subtotal < CONFIG.FREE_SHIP) ? CONFIG.SHIPPING_FEE : 0;
  o.total = o.subtotal + o.shipping;
  return o;
}

function getMenu_() {
  const sh = ensureSheets_().menu, rows = sh.getDataRange().getValues().slice(1), menu = {};
  rows.forEach(r => {
    const id = String(r[0]).trim(), price = Number(r[2]), on = r[3] === true || String(r[3]).toUpperCase() === 'TRUE';
    if (id && price > 0 && on) menu[id] = { name: String(r[1]), price };
  });
  return menu;
}

/* ===================== 寫入試算表 ===================== */
function saveOrder_(o) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) fail_('目前訂單量較大，請稍後再試');
  try {
    const s = ensureSheets_(), now = new Date();
    const day = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyMMdd');
    const props = PropertiesService.getScriptProperties();
    const seq = props.getProperty('SEQ_DAY') === day ? Number(props.getProperty('SEQ_NO')) + 1 : 1;
    props.setProperties({ SEQ_DAY: day, SEQ_NO: String(seq) });
    o.id = 'JCF' + day + '-' + ('000' + seq).slice(-3);
    o.created = now;
    const summary = o.lines.map(l => l.name + ' ×' + l.qty).join('、');
    s.orders.appendRow([o.id, now, STATUSES[0], METHOD_NAME[o.method], safeCell_(o.name), "'" + o.phone, safeCell_(o.email),
      safeCell_(o.address), safeCell_(o.note), summary, o.subtotal, o.shipping, o.total, o.source, '']);
    const rows = o.lines.map(l => [o.id, now, l.id, l.name, l.price, l.qty, l.amount]);
    s.items.getRange(s.items.getLastRow() + 1, 1, rows.length, ITEM_HEADERS.length).setValues(rows);
    SpreadsheetApp.flush();
    return o;
  } finally {
    lock.releaseLock();
  }
}

function findOrder_(id) {
  if (!id) return null;
  const sh = ensureSheets_().orders, last = sh.getLastRow();
  if (last < 2) return null;
  const hit = sh.getRange(2, 1, last - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
  if (!hit) return null;
  const row = sh.getRange(hit.getRow(), 1, 1, ORDER_HEADERS.length).getValues()[0];
  row[5] = String(row[5]).replace(/^'/, '');
  return row;
}

/* ===================== Email ===================== */
const money_ = n => 'NT$' + Number(n).toLocaleString('en-US');
const esc_ = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function orderTable_(o) {
  const rows = o.lines.map(l => `<tr><td style="padding:6px 0">${esc_(l.name)} × ${l.qty}</td><td style="text-align:right">${money_(l.amount)}</td></tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}
    <tr><td style="padding:6px 0;border-top:1px solid #e9dccd">商品小計</td><td style="text-align:right;border-top:1px solid #e9dccd">${money_(o.subtotal)}</td></tr>
    <tr><td>運費</td><td style="text-align:right">${o.shipping ? money_(o.shipping) : '—'}</td></tr>
    <tr><td style="font-weight:bold">應付總額</td><td style="text-align:right;font-weight:bold;color:#c4631d">${money_(o.total)}</td></tr></table>`;
}
function mailWrap_(title, body) {
  return `<div style="font-family:'Noto Sans TC',sans-serif;max-width:520px;margin:auto;color:#2b1a0f">
    <div style="background:#2b1a0f;color:#f09a52;padding:16px 20px;border-radius:12px 12px 0 0;font-size:18px;font-weight:bold">${CONFIG.SHOP_NAME}</div>
    <div style="background:#faf4e8;padding:20px;border-radius:0 0 12px 12px"><h2 style="margin-top:0;font-size:20px">${title}</h2>${body}</div></div>`;
}

function notify_(o) {
  const info = `<p>訂單編號：<b>${o.id}</b><br>取餐方式：${METHOD_NAME[o.method]}${o.address ? '<br>收件地址：' + esc_(o.address) : ''}${o.note ? '<br>備註：' + esc_(o.note) : ''}</p>`;
  o.emailSent = false;
  if (CONFIG.SEND_CUSTOMER_EMAIL) {
    try {
      const eta = o.method === 'delivery' ? '我們將於 1–2 個工作天內出貨。' : '餐點約 15–20 分鐘完成，完成時會再通知您。';
      MailApp.sendEmail({ to: o.email, name: CONFIG.SHOP_NAME, subject: `【${CONFIG.SHOP_NAME}】訂單確認 ${o.id}`,
        htmlBody: mailWrap_(`${esc_(o.name)} 您好，感謝您的訂購！`, info + orderTable_(o) + `<p>${eta}</p>`) });
      o.emailSent = true;
    } catch (err) { console.error('顧客信寄送失敗', err); }
  }
  try {
    const to = CONFIG.SHOP_EMAIL || Session.getEffectiveUser().getEmail();
    if (to) MailApp.sendEmail({ to, subject: `🔔 新訂單 ${o.id}｜${METHOD_NAME[o.method]}｜${money_(o.total)}`,
      htmlBody: mailWrap_('新訂單通知', `<p>顧客：${esc_(o.name)}（${o.phone}）<br>Email：${esc_(o.email)}</p>` + info + orderTable_(o)) });
  } catch (err) { console.error('店家通知寄送失敗', err); }
}

/** 安裝式觸發器：狀態欄改為「可取餐」/「已出貨」時通知顧客 */
function onStatusEdit(e) {
  const r = e && e.range;
  if (!r || r.getSheet().getName() !== SHEET.ORDERS || r.getColumn() !== 3 || r.getRow() < 2 || r.getNumRows() !== 1) return;
  const status = String(e.value || '');
  if (status !== '可取餐' && status !== '已出貨') return;
  const sh = r.getSheet(), row = sh.getRange(r.getRow(), 1, 1, ORDER_HEADERS.length).getValues()[0];
  const [id, , , method, name, , email, address, , summary, , , total, , log] = row;
  if (!email || String(log).indexOf(status) >= 0) return; // 已通知過就不重寄
  const msg = status === '可取餐'
    ? `您的餐點已經煎好囉！請至門市取餐（${method}）。`
    : `您的訂單已出貨，將送至：${esc_(address)}，通常 1–2 個工作天送達。`;
  MailApp.sendEmail({ to: email, name: CONFIG.SHOP_NAME, subject: `【${CONFIG.SHOP_NAME}】訂單 ${id} ${status}`,
    htmlBody: mailWrap_(`${esc_(name)} 您好`, `<p>${msg}</p><p>訂單編號：<b>${id}</b><br>內容：${esc_(summary)}<br>應付總額：${money_(total)}</p>`) });
  sh.getRange(r.getRow(), 15).setValue((log ? log + '\n' : '') + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'MM/dd HH:mm') + ' 已通知' + status);
}

/* ===================== 試算表管理 ===================== */
function ensureSheets_() {
  const ss = SpreadsheetApp.getActive();
  const get = (name, headers) => {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#4a2c1a').setFontColor('#faf4e8');
      sh.setFrozenRows(1);
    }
    return sh;
  };
  const orders = get(SHEET.ORDERS, ORDER_HEADERS), items = get(SHEET.ITEMS, ITEM_HEADERS), menu = get(SHEET.MENU, MENU_HEADERS);
  return { ss, orders, items, menu };
}

/** 第一次部署前請在編輯器執行一次：建立工作表、菜單、格式與觸發器 */
function setup() {
  const s = ensureSheets_();
  if (s.menu.getLastRow() < 2) {
    s.menu.getRange(2, 1, DEFAULT_MENU.length, 4).setValues(DEFAULT_MENU.map(r => [...r, true]));
    s.menu.getRange(2, 4, DEFAULT_MENU.length, 1).insertCheckboxes();
  }
  const o = s.orders;
  o.getRange('B:B').setNumberFormat('yyyy/mm/dd hh:mm');
  o.getRange('K:M').setNumberFormat('"NT$"#,##0');
  s.items.getRange('B:B').setNumberFormat('yyyy/mm/dd hh:mm');
  s.items.getRange('E:E').setNumberFormat('"NT$"#,##0'); s.items.getRange('G:G').setNumberFormat('"NT$"#,##0');
  o.getRange('C2:C').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build());
  const colors = { '新訂單': '#fde2c8', '製作中': '#fff3c4', '可取餐': '#d4efd0', '已出貨': '#d0e4f5', '已完成': '#e5e5e5', '已取消': '#f5d0d0' };
  o.setConditionalFormatRules(Object.keys(colors).map(k => SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=$C2="${k}"`).setBackground(colors[k]).setRanges([o.getRange('A2:O')]).build()));
  o.setColumnWidth(10, 320);
  const ss = s.ss;
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'onStatusEdit').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onStatusEdit').forSpreadsheet(ss).onEdit().create();
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
  ss.toast('初始化完成！接著請「部署 → 新增部署作業 → 網頁應用程式」', CONFIG.SHOP_NAME, 8);
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('金脆坊')
    .addItem('今日營收統計', 'todayReport')
    .addItem('初始化／修復工作表', 'setup')
    .addToUi();
}

function todayReport() {
  const s = ensureSheets_(), today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy/MM/dd');
  const rows = s.orders.getDataRange().getValues().slice(1)
    .filter(r => r[1] instanceof Date && Utilities.formatDate(r[1], CONFIG.TIMEZONE, 'yyyy/MM/dd') === today && r[2] !== '已取消');
  const by = {}; rows.forEach(r => { by[r[3]] = (by[r[3]] || 0) + 1; });
  const total = rows.reduce((a, r) => a + Number(r[12] || 0), 0);
  SpreadsheetApp.getUi().alert(`${today} 營收統計`,
    `有效訂單：${rows.length} 筆\n營業額：${money_(total)}\n` + Object.keys(by).map(k => `${k}：${by[k]} 筆`).join('\n'),
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
