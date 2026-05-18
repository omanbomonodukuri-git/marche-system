#!/bin/bash
# =============================================================
#  受注管理システム — Claude Code セットアップスクリプト
#  初回のみ実行してください
# =============================================================

set -e

echo "📦 セットアップ開始..."

# ディレクトリ構造を作成
mkdir -p src releases gas

# 現行ファイルをsrcに配置（すでにある場合はスキップ）
if [ ! -f "src/index.html" ]; then
  echo "⚠️  src/index.html が見つかりません。最新のindex.htmlをsrc/に配置してください。"
fi
if [ ! -f "src/gas_code.gs" ]; then
  echo "⚠️  src/gas_code.gs が見つかりません。最新のgas_code.gsをsrc/に配置してください。"
fi

# claspのインストール確認
if ! command -v clasp &> /dev/null; then
  echo "📥 clasp をインストール中..."
  npm install -g @google/clasp
fi

echo ""
echo "✅ ディレクトリ構造の作成完了"
echo ""
echo "次の手順を実行してください:"
echo "1. clasp login                    # Googleアカウントでログイン"
echo "2. gas/ ディレクトリに .clasp.json を作成"
echo "   → {\"scriptId\":\"<SCRIPT_ID>\",\"rootDir\":\"./\"}"
echo "3. SCRIPT_IDはApps Script > プロジェクトの設定 で確認"
echo ""
echo "デプロイは deploy.sh を使ってください。"
