#!/bin/bash
# =============================================================
#  受注管理システム — デプロイスクリプト
#
#  使い方:
#    ./deploy.sh frontend "変更内容の説明"   # GitHub Pagesのみ
#    ./deploy.sh gas "変更内容の説明"        # GASのみ
#    ./deploy.sh all "変更内容の説明"        # 両方
# =============================================================

set -e

TARGET=${1:-"all"}
MESSAGE=${2:-"更新"}

# releases/ フォルダ内の最大バージョン番号+1を返す
get_next_version() {
  local prefix=$1
  local max=0
  for f in releases/${prefix}_v*; do
    if [[ -f "$f" ]]; then
      num=$(echo "$f" | grep -o 'v[0-9]*' | grep -o '[0-9]*')
      if [[ -n "$num" && $num -gt $max ]]; then max=$num; fi
    fi
  done
  echo $((max + 1))
}

deploy_frontend() {
  local ver=$(get_next_version "index")
  echo "🔖 フロントエンド v${ver} をデプロイ中..."

  cp src/index.html releases/index_v${ver}.html
  echo "✅ releases/index_v${ver}.html を保存しました"

  # GitHub Pagesはルートのindex.htmlを使う
  cp src/index.html index.html

  git add src/index.html releases/index_v${ver}.html index.html
  git commit -m "frontend v${ver}: ${MESSAGE}"
  git push origin main
  echo "🚀 GitHub Pages へプッシュ完了"
  echo "   URL: https://omanbomonodukuri-git.github.io/marche-system/"
}

deploy_gas() {
  local ver=$(get_next_version "gas")
  echo "🔖 GAS v${ver} をデプロイ中..."

  cp src/gas_code.gs releases/gas_v${ver}.gs
  echo "✅ releases/gas_v${ver}.gs を保存しました"

  if command -v clasp &> /dev/null && [ -f "gas/.clasp.json" ]; then
    cp src/gas_code.gs gas/gas_code.gs
    cd gas
    clasp push
    clasp deploy --description "v${ver}: ${MESSAGE}"
    cd ..
    echo "🚀 GAS へデプロイ完了"
  else
    echo "⚠️  clasp未設定のため手動でデプロイしてください:"
    echo "   releases/gas_v${ver}.gs をApps Scriptに貼り付けて"
    echo "   「新しいバージョンでデプロイ」を実行"
  fi

  git add src/gas_code.gs releases/gas_v${ver}.gs
  git commit -m "gas v${ver}: ${MESSAGE}"
  git push origin main
}

# メイン処理
case $TARGET in
  frontend)
    deploy_frontend
    ;;
  gas)
    deploy_gas
    ;;
  all)
    VER_F=$(get_next_version "index")
    VER_G=$(get_next_version "gas")
    VER=$(( VER_F > VER_G ? VER_F : VER_G ))

    cp src/index.html releases/index_v${VER}.html
    cp src/gas_code.gs releases/gas_v${VER}.gs
    cp src/index.html index.html
    echo "✅ releases/index_v${VER}.html を保存しました"
    echo "✅ releases/gas_v${VER}.gs を保存しました"

    if command -v clasp &> /dev/null && [ -f "gas/.clasp.json" ]; then
      cp src/gas_code.gs gas/gas_code.gs
      cd gas && clasp push && clasp deploy --description "v${VER}: ${MESSAGE}" && cd ..
      echo "🚀 GAS へデプロイ完了"
    else
      echo "⚠️  GASは手動でデプロイしてください（releases/gas_v${VER}.gs）"
    fi

    git add -A
    git commit -m "v${VER}: ${MESSAGE}"
    git push origin main
    echo "🚀 GitHub Pages へプッシュ完了"
    ;;
  *)
    echo "使い方: ./deploy.sh [frontend|gas|all] \"変更内容\""
    exit 1
    ;;
esac

echo ""
echo "✅ デプロイ完了！"
