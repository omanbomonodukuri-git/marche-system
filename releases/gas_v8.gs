// ============================================================
//  おまんぼさん 受注管理システム — GAS v8
//  郵送対応（7ステップ・入金チェック・日数計算）
//  在庫管理（追加/使用/製作ミス）
//  CacheService による getAll 高速化
// ============================================================

const SPREADSHEET_ID = '1-27E8JVuZ3aD-cGsNCiq6WdCB6OemqghRKvx7NhjTQE';

const SH = {
  ORDERS:    'orders',
  ITEMS:     'items',
  STEPS:     'steps',
  PRODUCTS:  'products',
  HISTORY:   'history',
  SALES:     'sales',
  CONFIG:    'config',
  INVENTORY: 'inventory',
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
//  チャンクストレージ
// ============================================================
function storeChunk(sid, ci, d) {
  PropertiesService.getScriptProperties().setProperty('chunk_' + sid + '_' + ci, d);
  return ok({ stored: true });
}
function assembleChunks(sid, total, lastChunk) {
  const props = PropertiesService.getScriptProperties();
  var full = '';
  for (var i = 0; i < total - 1; i++) {
    full += props.getProperty('chunk_' + sid + '_' + i) || '';
    props.deleteProperty('chunk_' + sid + '_' + i);
  }
  return full + lastChunk;
}

// ============================================================
//  キャッシュ管理
// ============================================================
function invalidateCache() {
  try { CacheService.getScriptCache().removeAll(['getAll', 'inventory']); } catch(e) {}
}

// ============================================================
//  エントリポイント
// ============================================================
function doGet(e) {
  try {
    const action = e.parameter.action || '';
    const token  = e.parameter.token  || '';
    const sid    = e.parameter.sid    || '';
    const total  = parseInt(e.parameter.total || '1');
    const ci     = parseInt(e.parameter.ci    || '0');
    const dRaw   = e.parameter.d || '{}';

    if (action === 'storeChunk') return storeChunk(sid, ci, dRaw);
    if (action !== 'auth' && !verifyToken(token)) return err('Unauthorized');

    var data = {};
    try {
      var fullJson = (sid && total > 1) ? assembleChunks(sid, total, dRaw) : dRaw;
      data = JSON.parse(fullJson);
    } catch(ex) { data = {}; }

    switch (action) {
      case 'auth':              return handleAuth(e.parameter.password || '');
      case 'getAll':            return handleGetAll();
      case 'getHistory':        return handleGetHistory(data.year||'', data.month||'');
      case 'saveOrder':         return handleSaveOrder(data.order);
      case 'saveOrderFast':     return handleSaveOrderFast(data);
      case 'saveOrderHeader':   return handleSaveOrderHeader(data);
      case 'saveOrderItem':     return handleSaveOrderItem(data);
      case 'saveOrderStep':     return handleSaveOrderStep(data);
      case 'updateStep':        return handleUpdateStep(data);
      case 'updateItem':        return handleUpdateItem(data);
      case 'completeOrder':     return handleCompleteOrder(data);
      case 'deleteOrder':       return handleDeleteOrder(data.orderId||'');
      case 'deleteHistory':     return handleDeleteHistory(data);
      case 'saveProduct':       return handleSaveProduct(data.product);
      case 'deleteProduct':     return handleDeleteProduct(data.productId||'');
      case 'updateOrder':       return handleUpdateOrder(data);
      case 'exportCSV':         return handleExportCSV();
      case 'updateHistory':     return handleUpdateHistory(data);
      case 'getInventory':      return handleGetInventory();
      case 'saveInventoryTx':   return handleSaveInventoryTx(data);
      case 'deleteInventoryTx': return handleDeleteInventoryTx(data);
      case 'ping':              return ok({ pong: true });
      default:                  return err('Unknown action: ' + action);
    }
  } catch(ex) {
    return err(ex.toString());
  }
}

function doPost(e) { return err('GETを使用してください'); }

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
  var tokens = [];
  try { tokens = JSON.parse(cfg.sessionTokens || '[]'); } catch(e) { tokens = []; }
  tokens = tokens.filter(function(t){ return t.exp > Date.now(); });
  tokens.push({ token: newToken, exp: today.getTime() });
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
//  全データ取得（15秒キャッシュ）
// ============================================================
function handleGetAll() {
  const cache = CacheService.getScriptCache();
  const hit   = cache.get('getAll');
  if (hit) { try { return ok(JSON.parse(hit)); } catch(e) {} }

  const ss       = SpreadsheetApp.openById(SPREADSHEET_ID);
  const orders   = sheetToObjects(ss.getSheetByName(SH.ORDERS));
  const items    = sheetToObjects(ss.getSheetByName(SH.ITEMS));
  const steps    = sheetToObjects(ss.getSheetByName(SH.STEPS));
  const products = sheetToObjects(ss.getSheetByName(SH.PRODUCTS));

  const active = orders.filter(function(o){ return o.status !== 'done'; });
  active.forEach(function(o){
    o.paymentReceived = (o.paymentReceived == 1 || o.paymentReceived === true) ? 1 : 0;
    o.items = items.filter(function(it){ return it.orderId === o.id; }).map(function(it){
      it.steps        = steps.filter(function(s){ return s.itemId === it.id; });
      it.skipBinarize = (it.skipBinarize == 1 || it.skipBinarize === true);
      it.skipDesign   = (it.skipDesign   == 1 || it.skipDesign   === true);
      it.steps.forEach(function(s){ s.done = (s.done == 1 || s.done === true); });
      return it;
    });
  });

  const result = { orders: active, products: products };
  try { cache.put('getAll', JSON.stringify(result), 15); } catch(e) {}
  return ok(result);
}

function handleGetHistory(year, month) {
  const ss   = SpreadsheetApp.openById(SPREADSHEET_ID);
  var hist   = sheetToObjects(ss.getSheetByName(SH.HISTORY));
  if(year && month){
    hist = hist.filter(function(h){
      const d = new Date(h.completedAt);
      return d.getFullYear() == year && (d.getMonth()+1) == month;
    });
  }
  const sales  = sheetToObjects(ss.getSheetByName(SH.SALES));
  var orders   = sheetToObjects(ss.getSheetByName(SH.ORDERS));
  hist.forEach(function(h){
    h.salesItems = sales.filter(function(s){ return s.historyId === h.id; });
    var ord = orders.filter(function(o){ return o.id === h.orderId; })[0];
    if (ord) h.channel = ord.channel || 'marche';
  });
  return ok({ history: hist });
}

// ============================================================
//  在庫管理
//  inventory シート: id, productId, productName, qty, type, note, createdAt
//  type: 'add'=追加, 'use'=使用/販売, 'mistake'=製作ミス
// ============================================================
function handleGetInventory() {
  const cache = CacheService.getScriptCache();
  const hit   = cache.get('inventory');
  if (hit) { try { return ok(JSON.parse(hit)); } catch(e) {} }

  const txs = sheetToObjects(
    SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.INVENTORY)
  );

  // 商品ごとの現在在庫を集計
  const stockMap = {};
  txs.forEach(function(tx) {
    if (!stockMap[tx.productId]) stockMap[tx.productId] = { productName: tx.productName, qty: 0 };
    const q = Number(tx.qty) || 0;
    if (tx.type === 'add')     stockMap[tx.productId].qty += q;
    if (tx.type === 'use')     stockMap[tx.productId].qty -= q;
    if (tx.type === 'mistake') stockMap[tx.productId].qty -= q;
  });

  const result = { txs: txs, stock: stockMap };
  try { cache.put('inventory', JSON.stringify(result), 30); } catch(e) {}
  return ok(result);
}

function handleSaveInventoryTx(data) {
  if (!data.productId || !data.qty || !data.type) return err('data missing');
  try { CacheService.getScriptCache().remove('inventory'); } catch(e) {}

  const id = Utilities.getUuid();
  const now = new Date().toISOString();
  SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.INVENTORY).appendRow([
    id, data.productId, data.productName || '', Number(data.qty), data.type, data.note || '', now
  ]);
  return ok({ id: id, createdAt: now });
}

function handleDeleteInventoryTx(data) {
  try { CacheService.getScriptCache().remove('inventory'); } catch(e) {}
  deleteRowsWhere(
    SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.INVENTORY), 0, data.txId
  );
  return ok({ deleted: true });
}

// ============================================================
//  注文保存（高速・郵送は7ステップ）
// ============================================================
function handleSaveOrder(order) {
  if(!order) return err('order data missing');
  invalidateCache();
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  ss.getSheetByName(SH.ORDERS).appendRow([
    order.id, order.num, order.note||'', order.deliveryType,
    order.createdAt, '', 'active', '', '', 0
  ]);
  const iSh = ss.getSheetByName(SH.ITEMS);
  const sSh = ss.getSheetByName(SH.STEPS);
  (order.items||[]).forEach(function(it){
    iSh.appendRow([it.id, order.id, it.pid, it.idx||0, it.totalOf||1, it.skipBinarize?1:0, it.skipDesign?1:0, it.price||0, it.paymentMethod||'']);
    (it.stepDefs||it.steps||[]).forEach(function(sd){
      sSh.appendRow([sd.id, it.id, sd.stepIndex, 0, '', '', '']);
    });
  });
  return ok({ saved: true });
}

function handleSaveOrderFast(data) {
  if(!data || !data.id) return err('data missing');
  invalidateCache();
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const oSh = ss.getSheetByName(SH.ORDERS);
  const iSh = ss.getSheetByName(SH.ITEMS);
  const sSh = ss.getSheetByName(SH.STEPS);

  var numSteps = (data.deliveryType === 'shipping') ? 7 : 6;

  oSh.appendRow([data.id, data.num, data.note||'', data.deliveryType,
    data.createdAt, '', 'active', '', data.channel||'marche', 0]);

  var itemRows = [];
  var stepRows = [];
  (data.items||[]).forEach(function(it) {
    itemRows.push([it.id, data.id, it.pid, it.idx||0, it.totalOf||1, 0, 0, it.price||0, it.paymentMethod||'']);
    var stepIds = it.stepIds || [];
    var step0At = it.step0At || '';
    for(var si = 0; si < numSteps; si++) {
      var isDone = (si === 0 && it.step0Done) ? 1 : 0;
      var stepAt = isDone ? step0At : '';
      stepRows.push([stepIds[si]||Utilities.getUuid(), it.id, si, isDone, stepAt, stepAt, isDone ? 0 : '']);
    }
  });

  if(itemRows.length > 0) iSh.getRange(iSh.getLastRow()+1, 1, itemRows.length, 9).setValues(itemRows);
  if(stepRows.length > 0) sSh.getRange(sSh.getLastRow()+1, 1, stepRows.length, 7).setValues(stepRows);
  return ok({ saved: true });
}

function handleSaveOrderHeader(data) {
  invalidateCache();
  SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.ORDERS).appendRow([
    data.id, data.num, data.note||'', data.deliveryType,
    data.createdAt, '', 'active', '', data.channel||'marche', 0
  ]);
  return ok({ saved: true });
}
function handleSaveOrderItem(data) {
  invalidateCache();
  SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.ITEMS).appendRow([
    data.id, data.orderId, data.pid, data.idx||0, data.totalOf||1,
    data.skipBinarize?1:0, data.skipDesign?1:0, data.price||0, data.paymentMethod||''
  ]);
  return ok({ saved: true });
}
function handleSaveOrderStep(data) {
  invalidateCache();
  SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.STEPS).appendRow([
    data.id, data.itemId, data.stepIndex, 0, '', '', ''
  ]);
  return ok({ saved: true });
}

// ============================================================
//  ステップ更新
// ============================================================
function handleUpdateStep(data) {
  invalidateCache();
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
  invalidateCache();
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
//  注文完了（当日渡し→分、郵送→日数）
// ============================================================
function handleCompleteOrder(data) {
  invalidateCache();
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const oSh   = ss.getSheetByName(SH.ORDERS);
  const oRows = oSh.getDataRange().getValues();
  var waitMinutes  = 0;
  var waitDays     = 0;
  var deliveryType = data.deliveryType || '';

  for(var i = 1; i < oRows.length; i++){
    if(oRows[i][0] === data.orderId){
      deliveryType = oRows[i][3] || deliveryType;
      const created   = new Date(oRows[i][4]);
      const completed = new Date(data.completedAt);
      if(deliveryType === 'shipping'){
        waitDays = Math.round((completed - created) / (1000*60*60*24) * 10) / 10;
      } else {
        waitMinutes = Math.round((completed - created) / 60000);
      }
      oSh.getRange(i+1,6).setValue(data.completedAt);
      oSh.getRange(i+1,7).setValue('done');
      break;
    }
  }

  const hId = Utilities.getUuid();
  ss.getSheetByName(SH.HISTORY).appendRow([
    hId, data.orderId, data.num, data.completedAt, waitMinutes, deliveryType, waitDays
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
  invalidateCache();
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
  invalidateCache();
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
//  注文編集（paymentReceived 対応）
// ============================================================
function handleUpdateOrder(data) {
  invalidateCache();
  const sh   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.ORDERS);
  const rows = sh.getDataRange().getValues();
  const hdrs = rows[0];
  for(var i = 1; i < rows.length; i++){
    if(rows[i][0] === data.orderId){
      if(data.num          !== undefined) sh.getRange(i+1,2).setValue(data.num);
      if(data.note         !== undefined) sh.getRange(i+1,3).setValue(data.note);
      if(data.deliveryType !== undefined) sh.getRange(i+1,4).setValue(data.deliveryType);
      if(data.paymentReceived !== undefined){
        var prCol = hdrs.indexOf('paymentReceived');
        if(prCol >= 0) sh.getRange(i+1, prCol+1).setValue(data.paymentReceived ? 1 : 0);
      }
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
  deleteRowsWhere(SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.PRODUCTS), 0, productId);
  return ok({ deleted: true });
}

function handleUpdateHistory(data) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  if (data.deliveryType !== undefined) {
    const hSh   = ss.getSheetByName(SH.HISTORY);
    const hRows = hSh.getDataRange().getValues();
    for (var i = 1; i < hRows.length; i++) {
      if (hRows[i][0] === data.historyId) { hSh.getRange(i+1, 6).setValue(data.deliveryType); break; }
    }
  }
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
  createSheetWithHeaders(ss, SH.CONFIG,    ['key','value']);
  createSheetWithHeaders(ss, SH.PRODUCTS,  ['id','name','price','totalMinutes','stepTimesJson']);
  createSheetWithHeaders(ss, SH.ORDERS,    ['id','num','note','deliveryType','createdAt','completedAt','status','sharedImageRef','channel','paymentReceived']);
  createSheetWithHeaders(ss, SH.ITEMS,     ['id','orderId','pid','idx','totalOf','skipBinarize','skipDesign','price','paymentMethod']);
  createSheetWithHeaders(ss, SH.STEPS,     ['id','itemId','stepIndex','done','startedAt','completedAt','durationMins']);
  createSheetWithHeaders(ss, SH.HISTORY,   ['id','orderId','num','completedAt','waitMinutes','deliveryType','waitDays']);
  createSheetWithHeaders(ss, SH.SALES,     ['id','historyId','orderId','pid','productName','price','paymentMethod','completedAt']);
  createSheetWithHeaders(ss, SH.INVENTORY, ['id','productId','productName','qty','type','note','createdAt']);

  const pw   = 'luke1227mb';
  const hash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, pw, Utilities.Charset.UTF_8
  ).map(function(b){ return ('0'+(b&0xFF).toString(16)).slice(-2); }).join('');
  setConfig('passwordHash', hash);
  setConfig('sessionTokens', '[]');
  Logger.log('✅ セットアップ完了！ パスワード: ' + pw);
}

// ============================================================
//  v7→v8 マイグレーション（手動実行・一度だけ）
// ============================================================
function migrate() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  function addColIfMissing(shName, colName) {
    const sh  = ss.getSheetByName(shName);
    if (!sh) { Logger.log(shName + ': シートが見つかりません'); return; }
    const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    if (!hdr.includes(colName)) {
      sh.getRange(1, sh.getLastColumn()+1).setValue(colName);
      Logger.log(shName + ': ' + colName + ' 列を追加しました');
    } else {
      Logger.log(shName + ': ' + colName + ' は既に存在します');
    }
  }

  addColIfMissing('orders',  'paymentReceived');
  addColIfMissing('history', 'waitDays');

  // inventoryシート新規作成
  createSheetWithHeaders(ss, SH.INVENTORY, ['id','productId','productName','qty','type','note','createdAt']);

  Logger.log('✅ マイグレーション完了');
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
