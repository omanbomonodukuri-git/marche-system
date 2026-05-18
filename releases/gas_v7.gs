// ============================================================
//  おまんぼさん マルシェ管理システム — GAS v6
//  長いデータの分割送信（storeChunk）対応
// ============================================================

const SPREADSHEET_ID = '1-27E8JVuZ3aD-cGsNCiq6WdCB6OemqghRKvx7NhjTQE';

const SH = {
  ORDERS:   'orders',
  ITEMS:    'items',
  STEPS:    'steps',
  PRODUCTS: 'products',
  HISTORY:  'history',
  SALES:    'sales',
  CONFIG:   'config',
};

function ok(data) {
  const o = ContentService.createTextOutput(JSON.stringify({ ok: true, data: data }));
  o.setMimeType(ContentService.MimeType.JSON);
  return o;
}
function err(msg) {
  const o = ContentService.createTextOutput(JSON.stringify({ ok: false, error: msg }));
  o.setMimeType(ContentService.MimeType.JSON);
  return o;
}

// ============================================================
//  チャンクストレージ（PropertiesServiceで一時保存）
// ============================================================
function storeChunk(sid, ci, d) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('chunk_' + sid + '_' + ci, d);
  return ok({ stored: true });
}

function assembleChunks(sid, total, lastChunk) {
  const props = PropertiesService.getScriptProperties();
  var full = '';
  for (var i = 0; i < total - 1; i++) {
    var chunk = props.getProperty('chunk_' + sid + '_' + i) || '';
    full += chunk;
    props.deleteProperty('chunk_' + sid + '_' + i);
  }
  full += lastChunk;
  return full;
}

// ============================================================
//  エントリポイント
// ============================================================
function doGet(e) {
  try {
    const action = e.parameter.action || '';
    const token  = e.parameter.token  || '';
    const sid    = e.parameter.sid    || '';
    const ci     = parseInt(e.parameter.ci || '0');
    const total  = parseInt(e.parameter.total || '1');
    const dRaw   = e.parameter.d || '{}';

    // チャンク保存（認証不要）
    if (action === 'storeChunk') {
      return storeChunk(sid, ci, dRaw);
    }

    // 認証
    if (action !== 'auth' && !verifyToken(token)) return err('Unauthorized');

    // データ復元（分割送信の場合はアセンブル）
    var data = {};
    try {
      var fullJson = (sid && total > 1) ? assembleChunks(sid, total, dRaw) : dRaw;
      data = JSON.parse(fullJson);
    } catch(ex) { data = {}; }

    switch (action) {
      case 'auth':          return handleAuth(e.parameter.password || '');
      case 'getAll':        return handleGetAll();
      case 'getHistory':    return handleGetHistory(data.year||'', data.month||'');
      case 'saveOrder':       return handleSaveOrder(data.order);
      case 'saveOrderFast':   return handleSaveOrderFast(data);
      case 'saveOrderHeader': return handleSaveOrderHeader(data);
      case 'saveOrderItem':   return handleSaveOrderItem(data);
      case 'saveOrderStep':   return handleSaveOrderStep(data);
      case 'updateStep':    return handleUpdateStep(data);
      case 'updateItem':    return handleUpdateItem(data);
      case 'completeOrder': return handleCompleteOrder(data);
      case 'deleteOrder':   return handleDeleteOrder(data.orderId||'');
      case 'deleteHistory': return handleDeleteHistory(data);
      case 'saveProduct':   return handleSaveProduct(data.product);
      case 'deleteProduct': return handleDeleteProduct(data.productId||'');
      case 'updateOrder':   return handleUpdateOrder(data);
      case 'exportCSV':     return handleExportCSV();
      case 'updateHistory': return handleUpdateHistory(data);
      case 'ping':          return ok({ pong: true });
      default:              return err('Unknown action: ' + action);
    }
  } catch(ex) {
    return err(ex.toString());
  }
}

function doPost(e) {
  return err('GETを使用してください');
}

// ============================================================
//  認証
// ============================================================
function verifyToken(token) {
  if (!token) return false;
  var tokens = [];
  try { tokens = JSON.parse(getConfig().sessionTokens || '[]'); } catch(e) { return false; }
  const now = Date.now();
  return tokens.some(function(t) { return t.token === token && t.exp > now; });
}

function handleAuth(pw) {
  const cfg  = getConfig();
  const hash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, pw, Utilities.Charset.UTF_8
  ).map(function(b){ return ('0'+(b&0xFF).toString(16)).slice(-2); }).join('');

  if (hash !== cfg.passwordHash) return err('パスワードが違います');

  const newToken = Utilities.getUuid();
  const today = new Date(); today.setHours(23,59,59,999);
  const exp = today.getTime();

  var tokens = [];
  try { tokens = JSON.parse(cfg.sessionTokens || '[]'); } catch(e) { tokens = []; }
  tokens = tokens.filter(function(t){ return t.exp > Date.now(); });
  tokens.push({ token: newToken, exp: exp });
  setConfig('sessionTokens', JSON.stringify(tokens));

  return ok({ token: newToken });
}

// ============================================================
//  設定
// ============================================================
function getConfig() {
  const sh   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.CONFIG);
  const rows = sh.getDataRange().getValues();
  const cfg  = {};
  rows.forEach(function(r){ if(r[0]) cfg[r[0]] = r[1]; });
  return cfg;
}
function setConfig(key, value) {
  const sh   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.CONFIG);
  const rows = sh.getDataRange().getValues();
  for(var i = 0; i < rows.length; i++){
    if(rows[i][0] === key){ sh.getRange(i+1,2).setValue(value); return; }
  }
  sh.appendRow([key, value]);
}

// ============================================================
//  全データ取得
// ============================================================
function handleGetAll() {
  const ss       = SpreadsheetApp.openById(SPREADSHEET_ID);
  const orders   = sheetToObjects(ss.getSheetByName(SH.ORDERS));
  const items    = sheetToObjects(ss.getSheetByName(SH.ITEMS));
  const steps    = sheetToObjects(ss.getSheetByName(SH.STEPS));
  const products = sheetToObjects(ss.getSheetByName(SH.PRODUCTS));

  const active = orders.filter(function(o){ return o.status !== 'done'; });
  active.forEach(function(o){
    o.items = items.filter(function(it){ return it.orderId === o.id; }).map(function(it){
      it.steps        = steps.filter(function(s){ return s.itemId === it.id; });
      it.skipBinarize = (it.skipBinarize == 1 || it.skipBinarize === true);
      it.skipDesign   = (it.skipDesign   == 1 || it.skipDesign   === true);
      it.steps.forEach(function(s){ s.done = (s.done == 1 || s.done === true); });
      return it;
    });
  });
  return ok({ orders: active, products: products });
}

function handleGetHistory(year, month) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var hist    = sheetToObjects(ss.getSheetByName(SH.HISTORY));
  if(year && month){
    hist = hist.filter(function(h){
      const d = new Date(h.completedAt);
      return d.getFullYear() == year && (d.getMonth()+1) == month;
    });
  }
  const sales = sheetToObjects(ss.getSheetByName(SH.SALES));
  // ordersシートからchannel情報を引き継ぐ
  var orders = sheetToObjects(ss.getSheetByName(SH.ORDERS));
  hist.forEach(function(h){
    h.salesItems = sales.filter(function(s){ return s.historyId === h.id; });
    var ord = orders.filter(function(o){ return o.id === h.orderId; })[0];
    if (ord) h.channel = ord.channel || 'marche';
  });
  return ok({ history: hist });
}

// ============================================================
//  注文保存
// ============================================================
function handleSaveOrder(order) {
  if(!order) return err('order data missing');
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  ss.getSheetByName(SH.ORDERS).appendRow([
    order.id, order.num, order.note||'', order.deliveryType,
    order.createdAt, '', 'active', ''
  ]);
  const iSh = ss.getSheetByName(SH.ITEMS);
  const sSh = ss.getSheetByName(SH.STEPS);
  (order.items||[]).forEach(function(it){
    iSh.appendRow([
      it.id, order.id, it.pid, it.idx||0, it.totalOf||1,
      it.skipBinarize?1:0, it.skipDesign?1:0,
      it.price||0, it.paymentMethod||''
    ]);
    (it.stepDefs||it.steps||[]).forEach(function(sd){
      sSh.appendRow([sd.id, it.id, sd.stepIndex, 0, '', '', '']);
    });
  });
  return ok({ saved: true });
}

// ============================================================
//  注文高速保存（1リクエストで全データ書き込み）
//  itemsのstepDefsはstepIdsから生成
// ============================================================
function handleSaveOrderFast(data) {
  if(!data || !data.id) return err('data missing');
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const oSh = ss.getSheetByName(SH.ORDERS);
  const iSh = ss.getSheetByName(SH.ITEMS);
  const sSh = ss.getSheetByName(SH.STEPS);

  // 1. 注文ヘッダー
  oSh.appendRow([
    data.id, data.num, data.note||'', data.deliveryType,
    data.createdAt, '', 'active', '', data.channel||'marche'
  ]);

  // 2. アイテムとステップを一括でappend
  var itemRows = [];
  var stepRows = [];

  (data.items||[]).forEach(function(it) {
    itemRows.push([
      it.id, data.id, it.pid, it.idx||0, it.totalOf||1,
      0, 0, it.price||0, it.paymentMethod||''
    ]);
    // stepIds配列からstepsを生成（6ステップ分）
    // step0(受付)は登録時にdone=1
    var stepIds = it.stepIds || [];
    var step0At = it.step0At || '';
    for(var si = 0; si < 6; si++) {
      var isDone = (si === 0 && it.step0Done) ? 1 : 0;
      var stepAt = (si === 0 && it.step0Done) ? step0At : '';
      stepRows.push([stepIds[si]||Utilities.getUuid(), it.id, si, isDone, stepAt, stepAt, isDone ? 0 : '']);
    }
  });

  // 一括書き込み（appendRowより高速）
  if(itemRows.length > 0) {
    iSh.getRange(iSh.getLastRow()+1, 1, itemRows.length, 9).setValues(itemRows);
  }
  if(stepRows.length > 0) {
    sSh.getRange(sSh.getLastRow()+1, 1, stepRows.length, 7).setValues(stepRows);
  }

  return ok({ saved: true });
}

// ============================================================
//  注文分割保存（ヘッダー・アイテム・ステップ個別）
// ============================================================
function handleSaveOrderHeader(data) {
  SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.ORDERS).appendRow([
    data.id, data.num, data.note||'', data.deliveryType,
    data.createdAt, '', 'active', '', data.channel||'marche'
  ]);
  return ok({ saved: true });
}

function handleSaveOrderItem(data) {
  SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.ITEMS).appendRow([
    data.id, data.orderId, data.pid, data.idx||0, data.totalOf||1,
    data.skipBinarize?1:0, data.skipDesign?1:0,
    data.price||0, data.paymentMethod||''
  ]);
  return ok({ saved: true });
}

function handleSaveOrderStep(data) {
  SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.STEPS).appendRow([
    data.id, data.itemId, data.stepIndex, 0, '', '', ''
  ]);
  return ok({ saved: true });
}

// ============================================================
//  ステップ更新
// ============================================================
function handleUpdateStep(data) {
  const sh   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.STEPS);
  const rows = sh.getDataRange().getValues();
  for(var i = 1; i < rows.length; i++){
    if(rows[i][0] === data.stepId){
      sh.getRange(i+1,4).setValue(data.done ? 1 : 0);
      if(data.startedAt)   sh.getRange(i+1,5).setValue(data.startedAt);
      if(data.completedAt){
        sh.getRange(i+1,6).setValue(data.completedAt);
        const dur = Math.round((new Date(data.completedAt)-new Date(rows[i][4]||data.startedAt))/60000);
        sh.getRange(i+1,7).setValue(dur>0?dur:0);
      }
      break;
    }
  }
  return ok({ updated: true });
}

// ============================================================
//  アイテム更新
// ============================================================
function handleUpdateItem(data) {
  const sh   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.ITEMS);
  const rows = sh.getDataRange().getValues();
  for(var i = 1; i < rows.length; i++){
    if(rows[i][0] === data.itemId){
      if(data.price         !== undefined) sh.getRange(i+1,8).setValue(data.price);
      if(data.skipBinarize  !== undefined) sh.getRange(i+1,6).setValue(data.skipBinarize?1:0);
      if(data.skipDesign    !== undefined) sh.getRange(i+1,7).setValue(data.skipDesign?1:0);
      if(data.paymentMethod !== undefined) sh.getRange(i+1,9).setValue(data.paymentMethod);
      break;
    }
  }
  return ok({ updated: true });
}

// ============================================================
//  注文完了
// ============================================================
function handleCompleteOrder(data) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const oSh   = ss.getSheetByName(SH.ORDERS);
  const oRows = oSh.getDataRange().getValues();
  var waitMinutes = 0;
  for(var i = 1; i < oRows.length; i++){
    if(oRows[i][0] === data.orderId){
      waitMinutes = Math.round((new Date(data.completedAt)-new Date(oRows[i][4]))/60000);
      oSh.getRange(i+1,6).setValue(data.completedAt);
      oSh.getRange(i+1,7).setValue('done');
      break;
    }
  }
  const hId = Utilities.getUuid();
  ss.getSheetByName(SH.HISTORY).appendRow([
    hId, data.orderId, data.num, data.completedAt, waitMinutes, data.deliveryType
  ]);
  (data.items||[]).forEach(function(it){
    ss.getSheetByName(SH.SALES).appendRow([
      Utilities.getUuid(), hId, data.orderId,
      it.pid, it.productName, it.price, it.paymentMethod, data.completedAt
    ]);
  });
  return ok({ hId: hId });
}

// ============================================================
//  削除
// ============================================================
function handleDeleteOrder(orderId) {
  if(!orderId) return err('orderId missing');
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const iSh   = ss.getSheetByName(SH.ITEMS);
  const iRows = iSh.getDataRange().getValues();
  const ids   = iRows.filter(function(r){ return r[1]===orderId; }).map(function(r){ return r[0]; });
  deleteRowsWhere(ss.getSheetByName(SH.ORDERS), 0, orderId);
  deleteRowsWhere(iSh, 1, orderId);
  ids.forEach(function(id){ deleteRowsWhere(ss.getSheetByName(SH.STEPS), 1, id); });
  return ok({ deleted: true });
}

function handleDeleteHistory(data) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  deleteRowsWhere(ss.getSheetByName(SH.HISTORY), 0, data.historyId);
  deleteRowsWhere(ss.getSheetByName(SH.SALES),   1, data.historyId);
  if(data.orderId) handleDeleteOrder(data.orderId);
  return ok({ deleted: true });
}

function deleteRowsWhere(sheet, col, val) {
  const rows = sheet.getDataRange().getValues();
  for(var i = rows.length-1; i >= 1; i--){
    if(rows[i][col] === val) sheet.deleteRow(i+1);
  }
}

// ============================================================
//  注文編集
// ============================================================
function handleUpdateOrder(data) {
  const sh   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.ORDERS);
  const rows = sh.getDataRange().getValues();
  for(var i = 1; i < rows.length; i++){
    if(rows[i][0] === data.orderId){
      if(data.num          !== undefined) sh.getRange(i+1,2).setValue(data.num);
      if(data.note         !== undefined) sh.getRange(i+1,3).setValue(data.note);
      if(data.deliveryType !== undefined) sh.getRange(i+1,4).setValue(data.deliveryType);
      break;
    }
  }
  return ok({ updated: true });
}

// ============================================================
//  商品マスター
// ============================================================
function handleSaveProduct(p) {
  if(!p) return err('product missing');
  const ss   = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh   = ss.getSheetByName(SH.PRODUCTS);
  const rows = sh.getDataRange().getValues();
  const json = JSON.stringify(p.stepTimes||{});
  for(var i = 1; i < rows.length; i++){
    if(rows[i][0] === p.id){
      sh.getRange(i+1,1,1,5).setValues([[p.id,p.name,p.price,p.totalMinutes,json]]);
      return ok({ saved: true });
    }
  }
  sh.appendRow([p.id, p.name, p.price, p.totalMinutes, json]);
  return ok({ saved: true });
}

function handleDeleteProduct(productId) {
  deleteRowsWhere(
    SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.PRODUCTS), 0, productId
  );
  return ok({ deleted: true });
}

function handleUpdateHistory(data) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // historyシートのdeliveryType更新
  if (data.deliveryType !== undefined) {
    const hSh   = ss.getSheetByName(SH.HISTORY);
    const hRows = hSh.getDataRange().getValues();
    for (var i = 1; i < hRows.length; i++) {
      if (hRows[i][0] === data.historyId) {
        hSh.getRange(i+1, 6).setValue(data.deliveryType);
        break;
      }
    }
  }

  // salesシートの価格・支払い更新
  if (data.salesItems && data.salesItems.length) {
    const sSh   = ss.getSheetByName(SH.SALES);
    const sRows = sSh.getDataRange().getValues();
    data.salesItems.forEach(function(si) {
      for (var i = 1; i < sRows.length; i++) {
        if (sRows[i][0] === si.id) {
          if (si.price         !== undefined) sSh.getRange(i+1, 6).setValue(si.price);
          if (si.paymentMethod !== undefined) sSh.getRange(i+1, 7).setValue(si.paymentMethod);
          break;
        }
      }
    });
  }

  return ok({ updated: true });
}

function handleExportCSV() {
  return ok({ url: SpreadsheetApp.openById(SPREADSHEET_ID).getUrl() });
}

// ============================================================
//  ユーティリティ
// ============================================================
function sheetToObjects(sheet) {
  if(!sheet) return [];
  const all = sheet.getDataRange().getValues();
  if(all.length < 2) return [];
  const headers = all[0];
  return all.slice(1).map(function(r){
    const obj = {};
    headers.forEach(function(h,i){ obj[h] = (r[i]===''?null:r[i]); });
    return obj;
  });
}

// ============================================================
//  初回セットアップ（手動実行）
// ============================================================
function setup() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  createSheetWithHeaders(ss, SH.CONFIG,   ['key','value']);
  createSheetWithHeaders(ss, SH.PRODUCTS, ['id','name','price','totalMinutes','stepTimesJson']);
  createSheetWithHeaders(ss, SH.ORDERS,   ['id','num','note','deliveryType','createdAt','completedAt','status','sharedImageRef','channel']);
  createSheetWithHeaders(ss, SH.ITEMS,    ['id','orderId','pid','idx','totalOf','skipBinarize','skipDesign','price','paymentMethod']);
  createSheetWithHeaders(ss, SH.STEPS,    ['id','itemId','stepIndex','done','startedAt','completedAt','durationMins']);
  createSheetWithHeaders(ss, SH.HISTORY,  ['id','orderId','num','completedAt','waitMinutes','deliveryType']);
  createSheetWithHeaders(ss, SH.SALES,    ['id','historyId','orderId','pid','productName','price','paymentMethod','completedAt']);

  const pw   = 'luke1227mb';
  const hash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, pw, Utilities.Charset.UTF_8
  ).map(function(b){ return ('0'+(b&0xFF).toString(16)).slice(-2); }).join('');
  setConfig('passwordHash', hash);
  setConfig('sessionTokens', '[]');
  Logger.log('✅ セットアップ完了！ パスワード: ' + pw);
}

function createSheetWithHeaders(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,headers.length)
      .setBackground('#2d2b28').setFontColor('#c8a84a').setFontWeight('bold');
  }
  return sh;
}