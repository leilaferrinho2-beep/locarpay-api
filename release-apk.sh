#!/usr/bin/env bash
# Uso: bash release-apk.sh <caminho-do-apk> <versionCode> <versionName> <tag-ex: v91>
set -e

APK_PATH="$1"
VERSION_CODE="$2"
VERSION_NAME="$3"
TAG="$4"
APK_NAME="locarpay-${TAG}.apk"
REPO="leilaferrinho2-beep/locarpay-api"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${APK_NAME}"

if [ -z "$APK_PATH" ] || [ -z "$VERSION_CODE" ] || [ -z "$VERSION_NAME" ] || [ -z "$TAG" ]; then
  echo "Uso: bash release-apk.sh <apk> <versionCode> <versionName> <tag>"
  echo "Ex:  bash release-apk.sh locarpay-v91.apk 236 5.16 v91"
  exit 1
fi

echo "→ Criando release ${TAG} e fazendo upload do APK..."
gh release create "$TAG" "$APK_PATH#$APK_NAME" \
  --repo "$REPO" \
  --title "iLocarPay ${VERSION_NAME}" \
  --notes "Release automático — versionCode ${VERSION_CODE}" \
  2>/dev/null || \
gh release upload "$TAG" "$APK_PATH#$APK_NAME" \
  --repo "$REPO" \
  --clobber

echo "→ Atualizando version.json..."
echo "{ \"versionCode\": ${VERSION_CODE}, \"versionName\": \"${VERSION_NAME}\", \"url\": \"${DOWNLOAD_URL}\" }" \
  > "$(dirname "$0")/version.json"
echo "{ \"versionCode\": ${VERSION_CODE}, \"versionName\": \"${VERSION_NAME}\", \"url\": \"${DOWNLOAD_URL}\" }" \
  > "$(dirname "$0")/public/version.json"

echo "→ Commitando version.json..."
cd "$(dirname "$0")"
git add version.json public/version.json
git commit -m "release: APK ${TAG} (${VERSION_NAME}) — versionCode ${VERSION_CODE}"
git push origin master

echo ""
echo "✅ Concluído! APK disponível em:"
echo "   ${DOWNLOAD_URL}"
