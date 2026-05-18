#!/bin/bash
# =============================================================
#  受注管理システム — デプロイスクリプト
#
#  使い方:
#    ./deploy.sh frontend "変更内容の説明"   # フロントエンドのみ
#    ./deploy.sh gas "変更内容の説明"        # GASのみ
#    ./deploy.sh all "変更内容の説明"        # 両方
#
#  GitHub へのプッシュ後:
#    - フロントエンド: GitHub Pages が自動デプロイ（数分後）
#    - GAS:           GitHub Actions が自動デプロイ（セットアップ済みの場合）
#                     未設定の場合は releases/gas_vN.gs を手動貼り付け
# =============================================================

set -e

TARGET=${1:-"all"}
MESSAGE=${2:-"更新"}

REPO_URL="https://omanbosan.github.io/marche-system/"

# releases/ フォルダ内のプレフィックス別の最大バージョン番号+1を返す
get_next_version() {
  local prefix=$1
  local max=0
  for f in releases/${prefix}_v*; do
    if [[ -f "$f" ]]; then
      num=$(echo "$f" | grep -o 'v[0-9]*' | grep -o '[0-9]*')
      if [[ -n "$num" && "$num" -gt "$max" ]]; then max=$num; fi
    fi
  done
  echo $((max + 1))
}

# 未コミットの変更がある場合に確認
check_dirty() {
  if ! git diff --quiet src/ 2>/dev/null; then
    echo "⚠️  src/ に未ステージの変更があります（続行します）"
  fi
}

deploy_frontend() {
  local ver
  ver=$(get_next_version "index")
  echo "🔖 フロントエンド v${ver} をリビジョン保存中..."

  cp src/index.html "releases/index_v${ver}.html"
  cp src/index.html index.html
  echo "✅ releases/index_v${ver}.html 保存完了"

  git add src/index.html "releases/index_v${ver}.html" index.html
  git commit -m "frontend v${ver}: ${MESSAGE}"
  git push origin main
  echo "🚀 GitHub Pages へプッシュ完了"
  echo "   URL: ${REPO_URL}（反映まで数分かかる場合があります）"
}

deploy_gas() {
  local ver
  ver=$(get_next_version "gas")
  echo "🔖 GAS v${ver} をリビジョン保存中..."

  cp src/gas_code.gs "releases/gas_v${ver}.gs"
  echo "✅ releases/gas_v${ver}.gs 保存完了"

  git add src/gas_code.gs "releases/gas_v${ver}.gs"
  git commit -m "gas v${ver}: ${MESSAGE}"
  git push origin main
  echo "🚀 GitHub へプッシュ完了"

  # GitHub Actions が設定済みかチェック
  if git ls-remote --exit-code origin HEAD > /dev/null 2>&1; then
    echo ""
    echo "📋 GAS デプロイ状況:"
    if gh secret list 2>/dev/null | grep -q "CLASP_CREDENTIALS"; then
      echo "   ✅ GitHub Actions で自動デプロイが実行されます"
      echo "   📊 進捗: https://github.com/omanbosan/marche-system/actions"
    else
      echo "   ⚠️  GitHub Actions の Secrets が未設定です"
      echo "   手動デプロイ: releases/gas_v${ver}.gs を Apps Script に貼り付けて"
      echo "   「新しいバージョンでデプロイ」を実行してください"
      echo "   自動化手順: SETUP.md の「GAS 自動デプロイ セットアップ」を参照"
    fi
  fi
}

deploy_all() {
  local ver_f ver_g ver
  ver_f=$(get_next_version "index")
  ver_g=$(get_next_version "gas")
  ver=$(( ver_f > ver_g ? ver_f : ver_g ))

  echo "🔖 v${ver} をリビジョン保存中..."
  cp src/index.html "releases/index_v${ver}.html"
  cp src/gas_code.gs "releases/gas_v${ver}.gs"
  cp src/index.html index.html
  echo "✅ releases/index_v${ver}.html 保存完了"
  echo "✅ releases/gas_v${ver}.gs 保存完了"

  git add -A
  git commit -m "v${ver}: ${MESSAGE}"
  git push origin main
  echo "🚀 GitHub へプッシュ完了"
  echo "   フロントエンド: ${REPO_URL}（反映まで数分）"
  echo "   GAS: GitHub Actions で自動デプロイされます（Secrets設定済みの場合）"
  echo "   　　 未設定の場合: releases/gas_v${ver}.gs を Apps Script に貼り付け"
}

# メイン処理
check_dirty

case $TARGET in
  frontend) deploy_frontend ;;
  gas)      deploy_gas      ;;
  all)      deploy_all      ;;
  *)
    echo "使い方: ./deploy.sh [frontend|gas|all] \"変更内容\""
    exit 1
    ;;
esac

echo ""
echo "✅ 完了！"
