# 受注管理システム — Claude Code 引き継ぎドキュメント

## プロジェクト概要

レーザー工房向けの受注管理システム。
- **フロントエンド**: GitHub Pages（静的HTML/JS/CSS 単一ファイル）
- **バックエンド**: Google Apps Script（GAS）
- **データ**: Googleスプレッドシート

---

## 重要URLs・認証情報

```
GitHub リポジトリ : https://github.com/omanbomonodukuri-git/marche-system
GitHub Pages URL  : https://omanbomonodukuri-git.github.io/marche-system/
GAS URL           : https://script.google.com/macros/s/AKfycbwQ8-M1NueHtjLf8Q1B5I6X-YTfdDUTcczYaFxRIaP4Ocq9UL-gj6rcucHZWNAGF28Ulg/exec
スプレッドシートID : 1-27E8JVuZ3aD-cGsNCiq6WdCB6OemqghRKvx7NhjTQE
アプリパスワード   : luke1227mb
担当               : 美咲（受付・デザイン・撮影・完成連絡）、栄人（2値化・彫刻）
```

---

## ファイル構成

```
marche-system/
├── CLAUDE.md          # このファイル（Claude Codeへの指示）
├── src/
│   ├── index.html     # フロントエンド（現行バージョン）
│   └── gas_code.gs    # GASバックエンド（現行バージョン）
├── releases/
│   ├── index_v1.html  # 過去バージョン
│   ├── index_v2.html
│   ├── ...
│   ├── gas_v1.gs
│   └── ...
└── README.md
```

---

## 必須ルール（必ず守ること）

### 1. リビジョン管理
- **修正前に必ずバージョンを上げて保存する**
- `src/index.html` を編集する前に `releases/index_vN.html` にコピー（Nは現在の最新番号+1）
- `src/gas_code.gs` を編集する前に `releases/gas_vN.gs` にコピー
- コミットメッセージには変更内容を日本語で明記

```bash
# 例：リビジョンアップの手順
cp src/index.html releases/index_v8.html
cp src/gas_code.gs releases/gas_v8.gs
# → 編集作業
git add -A
git commit -m "v8: 工程別実績時間の集計修正、商品名表示バグ修正"
git push
```

### 2. デプロイ手順

#### フロントエンド（GitHub Pages）
```bash
# src/index.html を編集後
git add src/index.html releases/
git commit -m "vN: 変更内容の説明"
git push origin main
# → GitHub Pagesが自動でデプロイ（数分かかる場合あり）
```

#### バックエンド（GAS）
```bash
# clasp を使う場合
cd gas/
clasp push
clasp deploy --versionNumber N --description "変更内容"

# 手動の場合
# src/gas_code.gs の内容をApps Scriptエディタに貼り付けて
# 「新しいバージョンでデプロイ」を実行
```

---

## スプレッドシート シート構成

| シート名 | 主な列 |
|---------|--------|
| orders | id, num, note, deliveryType, createdAt, completedAt, status, sharedImageRef, channel |
| items | id, orderId, pid, idx, totalOf, skipBinarize, skipDesign, price, paymentMethod, onHold, paid, typeId, typeName, optionFee, optionNote, doubleBinarize |
| steps | id, itemId, stepIndex, done, startedAt, completedAt, durationMins |
| products | id, name, price, totalMinutes, stepTimesJson, stock, stockWarn, typesJson, stockLoc, stockShip |
| history | id, orderId, num, completedAt, waitMinutes, deliveryType |
| sales | id, historyId, orderId, pid, productName, price, paymentMethod, completedAt |
| config | key, value |
| stock_log | id, productId, stock, reason, createdAt |

---

## システム設計の重要事項

### 工程ステップ
- **現地（6ステップ）**: 受付→2値化→デザイン→彫刻→撮影→完成連絡
- **郵送（7ステップ）**: 受付→2値化→デザイン→顧客確認→彫刻→撮影→発送

### 在庫管理
- 在庫は**注文登録時**に引き落とし（完了時ではない）
- 注文削除時に在庫を戻す
- タイプ別×現地/郵送で4軸管理（stockLoc/stockShip）

### 通信設計
- GASはGETリクエストのみ（CORS対策）
- 大きいデータはchunk分割して送信（MAX 1500文字）
- ステップ更新・保留・入金確認は`apiAsync`（fire-and-forget、ローディングなし）
- 注文登録・削除はローディング表示あり

### 認証
- パスワードはSHA-256ハッシュでGASのconfigシートに保存
- トークンは当日23:59まで有効
- 複数端末対応（トークンリスト管理）

---

## clasp セットアップ（GAS自動デプロイ用）

```bash
# claspのインストール
npm install -g @google/clasp

# Googleアカウントでログイン
clasp login

# プロジェクトをクローン（既存GASプロジェクトの場合）
mkdir gas && cd gas
clasp clone <SCRIPT_ID>

# または新規作成
clasp create --type standalone --title "受注管理システム"

# .clasp.json に scriptId を設定
echo '{"scriptId":"<SCRIPT_ID>","rootDir":"./"}' > .clasp.json

# デプロイ
clasp push
clasp deploy --description "v8: バグ修正"
```

GASのSCRIPT_IDはApps Scriptエディタの「プロジェクトの設定」から確認できます。

---

## よくある問題と対処

### アイテムが表示されない
- itemsシートのヘッダーが正しいか確認
- GASで `fixAllSheets()` を実行

### 工程別実績時間が--になる
- stepsシートのdurationMinsが0になっている
- GASの `handleUpdateStep` で前のステップのcompletedAtからstartedAtを計算

### Unauthorized エラー
- localStorageのトークンが切れている
- ログインし直す（当日23:59で自動切れ）

### 在庫が反映されない
- productsシートのstockLoc/stockShip列があるか確認
- `fixAllSheets()` を実行してから `migrateStockToLoc()` を実行

---

## 現在の未解決問題（引き継ぎ事項）

1. **工程別実績時間の2値化が--になる**
   - GASのhandleUpdateStepで前ステップのcompletedAtを参照するよう修正済みだが、既存データには反映されない
   - 新規データから正しく記録されるはず

2. **商品別平均時間の名前がIDになっていた**
   - productsシートから直接名前を引くよう修正済み

---

## 開発メモ

- タブ: 現地 / 郵送 / 履歴 / 売上 / 商品
- 自動同期: 30秒ごと（入力中・モーダル表示中はスキップ）
- 手動同期: ヘッダーの↺ボタン
- パスワードを変更する場合は `setup()` を再実行
