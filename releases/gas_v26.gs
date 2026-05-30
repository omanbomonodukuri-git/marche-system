// ============================================================
//  受注管理システム — GAS v7
//  郵送工程追加・在庫管理・保留・入金確認対応
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
  STOCK_LOG:'stock_log',
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
//  チャンク一時保存
// ============================================================
function storeChunk(sid, ci, d) {
  PropertiesService.getScriptProperties().setProperty('chunk_'+sid+'_'+ci, d);
  return ok({ stored: true });
}

function assembleChunks(sid, total, lastChunk) {
  const props = PropertiesService.getScriptProperties();
  var full = '';
  for (var i = 0; i < total - 1; i++) {
    full += props.getProperty('chunk_'+sid+'_'+i) || '';
    props.deleteProperty('chunk_'+sid+'_'+i);
  }
  return full + lastChunk;
}

// ============================================================
//  エントリポイント
// ============================================================
function doGet(e) {
  try {
    const action = e.parameter.action || '';
    const token  = e.parameter.token  || '';
    const sid    = e.parameter.sid    || '';
    const ci     = parseInt(e.parameter.ci    || '0');
    const total  = parseInt(e.parameter.total || '1');
    const dRaw   = e.parameter.d || '{}';

    if (action === 'storeChunk') return storeChunk(sid, ci, dRaw);
    if (action !== 'auth' && !verifyToken(token)) return err('Unauthorized');

    var data = {};
    try {
      var fullJson = (sid && total > 1) ? assembleChunks(sid, total, dRaw) : dRaw;
      data = JSON.parse(fullJson);
    } catch(ex) { data = {}; }

    switch (action) {
      case 'auth':           return handleAuth(e.parameter.password || '');
      case 'ping':           return ok({ pong: true });
      case 'getAll':         return handleGetAll();
      case 'getHistory':     return handleGetHistory(data.year||'', data.month||'');
      case 'saveOrderFast':  return handleSaveOrderFast(data);
      case 'saveOrder':      return handleSaveOrderFast(data.order||data);
      case 'saveOrderHeader':return handleSaveOrderHeader(data);
      case 'saveOrderItem':  return handleSaveOrderItem(data);
      case 'saveOrderStep':  return handleSaveOrderStep(data);
      case 'updateStep':     return handleUpdateStep(data);
      case 'updateItem':     return handleUpdateItem(data);
      case 'updateOrder':    return handleUpdateOrder(data);
      case 'completeOrder':  return handleCompleteOrder(data);
      case 'deleteOrder':    return handleDeleteOrder(data.orderId||'');
      case 'deleteHistory':  return handleDeleteHistory(data);
      case 'saveProduct':    return handleSaveProduct(data.product||data);
      case 'deleteProduct':  return handleDeleteProduct(data.productId||'');
      case 'adjustStock':    return handleAdjustStock(data);
      case 'updateHistory':  return handleUpdateHistory(data);
      case 'exportCSV':      return handleExportCSV();
      default:               return err('Unknown action: ' + action);
    }
  } catch(ex) {
    return err(ex.toString());
  }
}

function doPost(e) { return err('GETを使用してください'); }

// ============================================================
//  認証（複数端末対応）
// ============================================================
function verifyToken(token) {
  if (!token) return false;
  var tokens = [];
  try { tokens = JSON.parse(getConfig().sessionTokens || '[]'); } catch(e) { return false; }
  return tokens.some(function(t) { return t.token === token && t.exp > Date.now(); });
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
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][0] === key) { sh.getRange(i+1,2).setValue(value); return; }
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
      it.skipBinarize   = (it.skipBinarize   == 1 || it.skipBinarize   === true);
      it.skipDesign     = (it.skipDesign     == 1 || it.skipDesign     === true);
      it.onHold         = (it.onHold         == 1 || it.onHold         === true);
      it.paid           = (it.paid           == 1 || it.paid           === true);
      it.doubleBinarize = (it.doubleBinarize == 1 || it.doubleBinarize === true);
      it.optionFee      = Number(it.optionFee  || 0);
      it.optionNote     = it.optionNote || '';
      it.steps.forEach(function(s){ s.done = (s.done == 1 || s.done === true); });
      return it;
    });
  });

  // 商品のstepTimesJson・typesJsonをパース
  products.forEach(function(p){
    if (typeof p.stepTimesJson === 'string') {
      try { p.stepTimes = JSON.parse(p.stepTimesJson); } catch(e){ p.stepTimes={}; }
    }
    if (typeof p.typesJson === 'string') {
      try { p.types = JSON.parse(p.typesJson); } catch(e){ p.types=[]; }
    } else { p.types = []; }
    p.stock     = Number(p.stock     || 0);
    p.stockLoc  = Number(p.stockLoc  || 0);
    p.stockShip = Number(p.stockShip || 0);
    p.stockWarn = Number(p.stockWarn || 3);
    // typesのstockLoc/stockShipもパース
    if (p.types) {
      p.types.forEach(function(t){
        t.stockLoc  = Number(t.stockLoc  || 0);
        t.stockShip = Number(t.stockShip || 0);
      });
    }
  });
  // itemsのtypeId・typeNameを含める
  items.forEach(function(it){
    it.typeId   = it.typeId   || '';
    it.typeName = it.typeName || '';
  });

  return ok({ orders: active, products: products });
}

function handleGetHistory(year, month) {
  const ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
  var hist     = sheetToObjects(ss.getSheetByName(SH.HISTORY));
  if (year) {
    hist = hist.filter(function(h){
      const d = new Date(h.completedAt);
      return d.getFullYear() == year && (month ? (d.getMonth()+1) == month : true);
    });
  }
  const sales    = sheetToObjects(ss.getSheetByName(SH.SALES));
  const orders   = sheetToObjects(ss.getSheetByName(SH.ORDERS));
  const allItems = sheetToObjects(ss.getSheetByName(SH.ITEMS));
  const steps    = sheetToObjects(ss.getSheetByName(SH.STEPS));

  // orderをマップ化
  var orderMap = {};
  orders.forEach(function(o){ orderMap[o.id] = o; });

  // itemをマップ化
  var itemMap = {};
  allItems.forEach(function(it){ itemMap[it.id] = it; });

  // 現地・郵送のorderIdセット
  var localOrderIds = {}, shipOrderIds = {};
  orders.forEach(function(o){
    if (o.deliveryType === 'shipping') shipOrderIds[o.id] = true;
    else localOrderIds[o.id] = true;
  });

  // stepsをitemIdでグループ化
  var stepsByItem = {};
  steps.forEach(function(s){
    if (!stepsByItem[s.itemId]) stepsByItem[s.itemId] = [];
    stepsByItem[s.itemId].push(s);
  });

  // ① 行程別平均実績時間（現地のみ）
  var stepStats = {};
  steps.forEach(function(s){
    if (!s.done || !s.durationMins || Number(s.durationMins) <= 0) return;
    var it = itemMap[s.itemId];
    if (!it || !localOrderIds[it.orderId]) return;
    var si = String(s.stepIndex);
    if (!stepStats[si]) stepStats[si] = [];
    stepStats[si].push(Number(s.durationMins));
  });
  var stepAvg = {};
  Object.keys(stepStats).forEach(function(si){
    var vals = stepStats[si];
    stepAvg[si] = Math.round(vals.reduce(function(a,b){return a+b;},0) / vals.length);
  });

  // productsシートから商品名マップを作成
  var products = sheetToObjects(ss.getSheetByName(SH.PRODUCTS));
  var productNameMap = {};
  products.forEach(function(p){ productNameMap[p.id] = p.name; });

  // ① 行程別平均実績時間（現地のみ・受付除外）
  var stepStats = {};
  steps.forEach(function(s){
    if (!s.done) return;
    if (Number(s.stepIndex) === 0) return; // 受付は自動完了のため除外
    var dur = Number(s.durationMins);
    if (dur <= 0) return;
    if (s.startedAt && s.completedAt && s.startedAt === s.completedAt) return;
    var it = itemMap[s.itemId];
    if (!it || !localOrderIds[it.orderId]) return;
    var si = String(s.stepIndex);
    if (!stepStats[si]) stepStats[si] = [];
    stepStats[si].push(dur);
  });
  var stepAvg = {};
  Object.keys(stepStats).forEach(function(si){
    var vals = stepStats[si];
    stepAvg[si] = Math.round(vals.reduce(function(a,b){return a+b;},0) / vals.length);
  });

  // ② 商品別平均制作時間（現地のみ・商品名で集計）
  var prodStats = {}; // {productName: [totalMins]}
  allItems.forEach(function(it){
    if (!localOrderIds[it.orderId]) return;
    var itemSteps = stepsByItem[it.id] || [];
    var total = itemSteps.reduce(function(s,sd){
      return s + (Number(sd.durationMins) || 0);
    }, 0);
    if (total <= 0) return;
    // productsシートから商品名を取得
    var pname = productNameMap[it.pid] || it.pid;
    if (!pname) return;
    if (!prodStats[pname]) prodStats[pname] = [];
    prodStats[pname].push(total);
  });
  var prodAvg = {};
  Object.keys(prodStats).forEach(function(pname){
    var vals = prodStats[pname];
    prodAvg[pname] = Math.round(vals.reduce(function(a,b){return a+b;},0) / vals.length);
  });

  // ③ 郵送の平均所要日数（受付〜発送）
  var shipDays = [];
  hist.filter(function(h){ return h.deliveryType === 'shipping'; })
      .forEach(function(h){
        if (h.waitMinutes && Number(h.waitMinutes) > 0) {
          shipDays.push(Number(h.waitMinutes));
        }
      });
  var shipAvgDays = shipDays.length
    ? Math.round(shipDays.reduce(function(a,b){return a+b;},0) / shipDays.length * 10) / 10
    : null;

  // histに詳細情報を付加
  hist.forEach(function(h){
    h.salesItems = sales.filter(function(s){ return s.historyId === h.id; });
    var ord = orderMap[h.orderId];
    if (ord) {
      h.channel    = ord.channel    || 'marche';
      h.createdAt  = ord.createdAt  || '';
    }
    // 工程別実績（現地・郵送とも）
    var ordItems = allItems.filter(function(it){ return it.orderId === h.orderId; });
    var stepDetailArr = [];
    ordItems.forEach(function(it){
      (stepsByItem[it.id] || []).forEach(function(s){
        if (s.done && Number(s.durationMins) > 0) {
          stepDetailArr.push({ stepIndex: Number(s.stepIndex), durationMins: Number(s.durationMins) });
        }
      });
    });
    var sdMap = {};
    stepDetailArr.forEach(function(sd){
      var si = String(sd.stepIndex);
      if (!sdMap[si]) sdMap[si] = 0;
      sdMap[si] += sd.durationMins;
    });
    h.stepDetails = Object.keys(sdMap).map(function(si){
      return { stepIndex: Number(si), durationMins: sdMap[si] };
    });
  });

  return ok({ history: hist, stepAvg: stepAvg, prodAvg: prodAvg, shipAvgDays: shipAvgDays });
}


function handleSaveOrderFast(data) {
  if (!data || !data.id) return err('data missing');
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  const oSh = ss.getSheetByName(SH.ORDERS);
  const iSh = ss.getSheetByName(SH.ITEMS);
  const sSh = ss.getSheetByName(SH.STEPS);

  // 注文ヘッダー
  oSh.appendRow([
    data.id, data.num, data.note||'', data.deliveryType,
    data.createdAt, '', 'active', '', data.channel||'marche'
  ]);

  var itemRows = [], stepRows = [];
  (data.items||[]).forEach(function(it){
    itemRows.push([
      it.id, data.id, it.pid, it.idx||0, it.totalOf||1,
      0, 0, it.price||0, it.paymentMethod||'', 0, 0,
      it.typeId||'', it.typeName||'',
      it.optionFee||0, it.optionNote||'', it.doubleBinarize?1:0
    ]);
    var stepIds = it.stepIds || [];
    // 郵送は7ステップ、現地は6ステップ
    var nSteps = data.deliveryType === 'shipping' ? 7 : 6;
    for (var si = 0; si < nSteps; si++) {
      var isDone      = (si === 0 && it.step0Done) ? 1 : 0;
      var stepAt      = (si === 0 && it.step0Done) ? (it.step0At||'') : '';
      // 受付完了時は2値化の startedAt も同時に設定（時間計算を正確にするため）
      var startedAt   = (si === 0) ? stepAt : (si === 1 && it.step0Done ? (it.step0At||'') : '');
      var completedAt = (si === 0) ? stepAt : '';
      var durMins     = isDone ? 0 : '';
      stepRows.push([stepIds[si]||Utilities.getUuid(), it.id, si, isDone, startedAt, completedAt, durMins]);
    }
  });

  if (itemRows.length > 0) iSh.getRange(iSh.getLastRow()+1,1,itemRows.length,16).setValues(itemRows);
  if (stepRows.length > 0) sSh.getRange(sSh.getLastRow()+1,1,stepRows.length,7).setValues(stepRows);

  return ok({ saved: true });
}

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
    data.price||0, data.paymentMethod||'', 0, 0,
    data.typeId||'', data.typeName||''
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
  var targetRow = -1;
  var itemId = '';
  var stepIndex = 0;

  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === data.stepId) {
      targetRow = i;
      itemId    = rows[i][1];
      stepIndex = Number(rows[i][2]);
      break;
    }
  }
  if (targetRow < 0) return ok({ updated: false });

  sh.getRange(targetRow+1, 4).setValue(data.done ? 1 : 0);

  if (data.completedAt) {
    // startedAtの決定：
    // 1. 渡された値
    // 2. 既存のstartedAt
    // 3. 前のステップのcompletedAt（最も正確）
    // 4. completedAtと同じ（最終手段）
    var startedAt = data.startedAt || rows[targetRow][4] || '';

    // 前のステップのcompletedAtを探す（startedAtが空か完了と同時刻の場合）
    if (!startedAt || startedAt === data.completedAt) {
      for (var j = 1; j < rows.length; j++) {
        if (rows[j][1] === itemId && Number(rows[j][2]) === stepIndex - 1) {
          var prevCompleted = rows[j][5];
          if (prevCompleted) {
            // Sheetsは日付をDateオブジェクトで返す場合があるのでISOに統一
            startedAt = (prevCompleted instanceof Date)
              ? prevCompleted.toISOString()
              : String(prevCompleted);
          }
          break;
        }
      }
    }

    // それでもなければDBのstartedAtを使い、なければcompletedAtを使う
    if (!startedAt) startedAt = rows[targetRow][4] ? String(rows[targetRow][4]) : data.completedAt;

    sh.getRange(targetRow+1, 5).setValue(startedAt);
    sh.getRange(targetRow+1, 6).setValue(data.completedAt);

    // 終了時刻もISOに統一して計算
    var start = new Date(startedAt);
    var end   = new Date(data.completedAt);
    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
      var dur = Math.round((end - start) / 60000);
      sh.getRange(targetRow+1, 7).setValue(dur > 0 ? dur : 0);
    }
  } else if (data.startedAt) {
    // completedAtなし（次のステップ開始記録）
    var existing = rows[targetRow][4];
    if (!existing) sh.getRange(targetRow+1, 5).setValue(data.startedAt);
  }

  return ok({ updated: true });
}

// ============================================================
//  アイテム更新（onHold・paid対応）
// ============================================================
function handleUpdateItem(data) {
  const sh   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.ITEMS);
  const rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === data.itemId) {
      if (data.price         !== undefined) sh.getRange(i+1,8).setValue(data.price);
      if (data.skipBinarize  !== undefined) sh.getRange(i+1,6).setValue(data.skipBinarize?1:0);
      if (data.skipDesign    !== undefined) sh.getRange(i+1,7).setValue(data.skipDesign?1:0);
      if (data.paymentMethod !== undefined) sh.getRange(i+1,9).setValue(data.paymentMethod);
      if (data.onHold        !== undefined) sh.getRange(i+1,10).setValue(data.onHold?1:0);
      if (data.paid          !== undefined) sh.getRange(i+1,11).setValue(data.paid?1:0);
      if (data.optionFee     !== undefined) sh.getRange(i+1,14).setValue(data.optionFee||0);
      if (data.optionNote    !== undefined) sh.getRange(i+1,15).setValue(data.optionNote||'');
      if (data.doubleBinarize!== undefined) sh.getRange(i+1,16).setValue(data.doubleBinarize?1:0);
      break;
    }
  }
  return ok({ updated: true });
}

// ============================================================
//  注文更新
// ============================================================
function handleUpdateOrder(data) {
  const sh   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.ORDERS);
  const rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === data.orderId) {
      if (data.num          !== undefined) sh.getRange(i+1,2).setValue(data.num);
      if (data.note         !== undefined) sh.getRange(i+1,3).setValue(data.note);
      if (data.deliveryType !== undefined) sh.getRange(i+1,4).setValue(data.deliveryType);
      if (data.channel      !== undefined) sh.getRange(i+1,9).setValue(data.channel);
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
  var waitMins = 0;
  for (var i = 1; i < oRows.length; i++) {
    if (oRows[i][0] === data.orderId) {
      const created = new Date(oRows[i][4]);
      const comp    = new Date(data.completedAt);
      // 郵送は日数、現地は分
      if (data.deliveryType === 'shipping') {
        waitMins = Math.round((comp - created) / 86400000); // 日数
      } else {
        waitMins = Math.round((comp - created) / 60000);    // 分
      }
      oSh.getRange(i+1,6).setValue(data.completedAt);
      oSh.getRange(i+1,7).setValue('done');
      break;
    }
  }
  const hId = Utilities.getUuid();
  ss.getSheetByName(SH.HISTORY).appendRow([
    hId, data.orderId, data.num, data.completedAt, waitMins, data.deliveryType
  ]);
  (data.items||[]).forEach(function(it){
    // タイプがある場合は "商品名 [タイプ名]" で保存
    var displayName = it.productName || '';
    if (it.typeName) displayName += ' [' + it.typeName + ']';
    ss.getSheetByName(SH.SALES).appendRow([
      Utilities.getUuid(), hId, data.orderId,
      it.pid, displayName, it.price, it.paymentMethod, data.completedAt
    ]);
  });
  return ok({ hId: hId });
}

// ============================================================
//  削除
// ============================================================
function handleDeleteOrder(orderId) {
  if (!orderId) return err('orderId missing');
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
  if (data.orderId) handleDeleteOrder(data.orderId);
  return ok({ deleted: true });
}

function deleteRowsWhere(sheet, col, val) {
  const rows = sheet.getDataRange().getValues();
  for (var i = rows.length-1; i >= 1; i--) {
    if (rows[i][col] === val) sheet.deleteRow(i+1);
  }
}

// ============================================================
//  商品マスター
// ============================================================
function handleSaveProduct(p) {
  if (!p) return err('product missing');
  const ss   = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh   = ss.getSheetByName(SH.PRODUCTS);
  const rows = sh.getDataRange().getValues();
  const json      = JSON.stringify(p.stepTimes || {});
  const typesJson = JSON.stringify(p.types     || []);
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === p.id) {
      sh.getRange(i+1,1,1,10).setValues([[
        p.id, p.name, p.price, p.totalMinutes, json,
        p.stock||0, p.stockWarn||3, typesJson,
        p.stockLoc||0, p.stockShip||0
      ]]);
      return ok({ saved: true });
    }
  }
  sh.appendRow([p.id, p.name, p.price, p.totalMinutes, json,
    p.stock||0, p.stockWarn||3, typesJson,
    p.stockLoc||0, p.stockShip||0]);
  return ok({ saved: true });
}

function handleDeleteProduct(productId) {
  deleteRowsWhere(
    SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.PRODUCTS), 0, productId
  );
  return ok({ deleted: true });
}

// ============================================================
//  在庫調整
// ============================================================
function handleAdjustStock(data) {
  const ss   = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh   = ss.getSheetByName(SH.PRODUCTS);
  const rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === data.productId) {
      if (data.typeId) {
        // タイプ別在庫更新（stockLoc/stockShip）
        var typesJson = rows[i][7] || '[]';
        var types = [];
        try { types = JSON.parse(typesJson); } catch(e){ types=[]; }
        types = types.map(function(t){
          if (t.id === data.typeId) {
            if (data.stockLoc  !== undefined) t.stockLoc  = data.stockLoc;
            if (data.stockShip !== undefined) t.stockShip = data.stockShip;
          }
          return t;
        });
        sh.getRange(i+1,8).setValue(JSON.stringify(types));
      } else {
        // タイプなし：stockLoc/stockShipを個別列に保存
        if (data.stockLoc  !== undefined) sh.getRange(i+1,9).setValue(data.stockLoc);
        if (data.stockShip !== undefined) sh.getRange(i+1,10).setValue(data.stockShip);
      }
      break;
    }
  }
  // ログ記録（stockLoc/stockShip を記録）
  const logSh = ss.getSheetByName(SH.STOCK_LOG);
  if (logSh) {
    var logNote = (data.typeId ? 'type:'+data.typeId+' ' : '')
      + 'loc:' + (data.stockLoc||0) + ' ship:' + (data.stockShip||0)
      + (data.isShip ? ' [郵送]' : ' [現地]');
    logSh.appendRow([
      Utilities.getUuid(), data.productId,
      data.isShip ? (data.stockShip||0) : (data.stockLoc||0),
      (data.reason||'') + ' ' + logNote,
      new Date().toISOString()
    ]);
  }
  return ok({ adjusted: true });
}

// ============================================================
//  履歴更新
// ============================================================
function handleUpdateHistory(data) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  if (data.deliveryType !== undefined) {
    const hSh   = ss.getSheetByName(SH.HISTORY);
    const hRows = hSh.getDataRange().getValues();
    for (var i = 1; i < hRows.length; i++) {
      if (hRows[i][0] === data.historyId) {
        hSh.getRange(i+1,6).setValue(data.deliveryType); break;
      }
    }
  }
  if (data.salesItems && data.salesItems.length) {
    const sSh   = ss.getSheetByName(SH.SALES);
    const sRows = sSh.getDataRange().getValues();
    data.salesItems.forEach(function(si){
      for (var i = 1; i < sRows.length; i++) {
        if (sRows[i][0] === si.id) {
          if (si.price         !== undefined) sSh.getRange(i+1,6).setValue(si.price);
          if (si.paymentMethod !== undefined) sSh.getRange(i+1,7).setValue(si.paymentMethod);
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
  if (!sheet) return [];
  const all = sheet.getDataRange().getValues();
  if (all.length < 2) return [];
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
  createSheetWithHeaders(ss, SH.PRODUCTS,  ['id','name','price','totalMinutes','stepTimesJson','stock','stockWarn','typesJson','stockLoc','stockShip']);
  createSheetWithHeaders(ss, SH.ORDERS,    ['id','num','note','deliveryType','createdAt','completedAt','status','sharedImageRef','channel']);
  createSheetWithHeaders(ss, SH.ITEMS,     ['id','orderId','pid','idx','totalOf','skipBinarize','skipDesign','price','paymentMethod','onHold','paid','typeId','typeName','optionFee','optionNote','doubleBinarize']);
  createSheetWithHeaders(ss, SH.STEPS,     ['id','itemId','stepIndex','done','startedAt','completedAt','durationMins']);
  createSheetWithHeaders(ss, SH.HISTORY,   ['id','orderId','num','completedAt','waitMinutes','deliveryType']);
  createSheetWithHeaders(ss, SH.SALES,     ['id','historyId','orderId','pid','productName','price','paymentMethod','completedAt']);
  createSheetWithHeaders(ss, SH.STOCK_LOG, ['id','productId','stock','reason','createdAt']);

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
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,headers.length)
      .setBackground('#1a1a2e').setFontColor('#c8a84a').setFontWeight('bold');
  }
  return sh;
}

// ============================================================
//  診断・シート修正ツール（問題発生時に実行）
// ============================================================
function diagnose() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheets = ['orders','items','steps','products','config','history','sales','stock_log'];
  sheets.forEach(function(name) {
    const sh = ss.getSheetByName(name);
    if (!sh) { Logger.log(name + ': シートなし'); return; }
    const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
    Logger.log(name + 'ヘッダー(' + sh.getLastColumn() + '列): ' + JSON.stringify(headers));
    Logger.log(name + 'データ行数: ' + (sh.getLastRow()-1));
  });
}

function fixAllSheets() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  fixHeader(ss,'orders',   ['id','num','note','deliveryType','createdAt','completedAt','status','sharedImageRef','channel']);
  fixHeader(ss,'items',    ['id','orderId','pid','idx','totalOf','skipBinarize','skipDesign','price','paymentMethod','onHold','paid','typeId','typeName','optionFee','optionNote','doubleBinarize']);
  fixHeader(ss,'steps',    ['id','itemId','stepIndex','done','startedAt','completedAt','durationMins']);
  fixHeader(ss,'products', ['id','name','price','totalMinutes','stepTimesJson','stock','stockWarn','typesJson','stockLoc','stockShip']);
  fixHeader(ss,'history',  ['id','orderId','num','completedAt','waitMinutes','deliveryType']);
  fixHeader(ss,'sales',    ['id','historyId','orderId','pid','productName','price','paymentMethod','completedAt']);
  fixHeader(ss,'config',   ['key','value']);
  fixHeader(ss,'stock_log',['id','productId','stock','reason','createdAt']);
  Logger.log('✅ 全シート修正完了');
  diagnose();
}

function fixHeader(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    Logger.log(name + ': シート新規作成');
  }
  var cur = sh.getLastColumn();
  if (cur < headers.length) {
    sh.insertColumnsAfter(Math.max(cur,1), headers.length - Math.max(cur,1));
  }
  sh.getRange(1,1,1,headers.length).setValues([headers]);
  sh.getRange(1,1,1,headers.length)
    .setBackground('#1a1a2e').setFontColor('#c8a84a').setFontWeight('bold');
  sh.setFrozenRows(1);
  Logger.log(name + ': ヘッダー修正完了');
}

// ============================================================
//  既存ステップの実績時間を再計算（手動実行用）
//  durationMins が 0 または空のステップを対象に、
//  前のステップの completedAt から startedAt を再計算して上書きする
// ============================================================
function recalcStepDurations() {
  var sh   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SH.STEPS);
  var rows = sh.getDataRange().getValues();
  // col: 0=id, 1=itemId, 2=stepIndex, 3=done, 4=startedAt, 5=completedAt, 6=durationMins

  // itemId → steps のマップを作成
  var byItem = {};
  for (var i = 1; i < rows.length; i++) {
    var iid = rows[i][1];
    if (!byItem[iid]) byItem[iid] = [];
    byItem[iid].push({ row: i, si: Number(rows[i][2]), done: rows[i][3], completedAt: rows[i][5], durationMins: rows[i][6] });
  }

  var fixed = 0;
  for (var i = 1; i < rows.length; i++) {
    var done     = rows[i][3];
    var stepIdx  = Number(rows[i][2]);
    var completedAt = rows[i][5];
    var durMins  = rows[i][6];

    // 完了済み、かつ durationMins が 0 か空、かつ completedAt がある行を対象
    if (!done || !completedAt) continue;
    var durNum = (durMins === '' || durMins === null) ? -1 : Number(durMins);
    if (durNum > 0) continue; // 正常値はスキップ
    if (stepIdx === 0) continue; // 受付は除外

    // 前のステップ（同じ itemId で stepIndex = stepIdx-1）の completedAt を探す
    var iid    = rows[i][1];
    var steps  = byItem[iid] || [];
    var prevStep = null;
    for (var k = 0; k < steps.length; k++) {
      if (steps[k].si === stepIdx - 1) { prevStep = steps[k]; break; }
    }

    var startedAt = '';
    if (prevStep && prevStep.completedAt) {
      startedAt = (prevStep.completedAt instanceof Date)
        ? prevStep.completedAt.toISOString()
        : String(prevStep.completedAt);
    }
    if (!startedAt) continue; // 前ステップがなければスキップ

    var endVal = (completedAt instanceof Date) ? completedAt.toISOString() : String(completedAt);
    var start  = new Date(startedAt);
    var end    = new Date(endVal);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;

    var dur = Math.round((end - start) / 60000);
    if (dur <= 0) continue; // 計算できないものはスキップ

    // startedAt と durationMins を上書き
    sh.getRange(i + 1, 5).setValue(startedAt);
    sh.getRange(i + 1, 7).setValue(dur);
    fixed++;
    Logger.log('修正: row=' + (i+1) + ' itemId=' + iid + ' step=' + stepIdx + ' dur=' + dur + '分');
  }

  Logger.log('✅ recalcStepDurations 完了: ' + fixed + '件修正');
  return fixed;
}
