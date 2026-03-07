#!/usr/bin/env bash
set -euo pipefail

# Chrome Web Store publish script
# First-time setup:
#   1. Register at https://chrome.google.com/webstore/devconsole ($5 fee)
#   2. Upload extension manually once, note the extension ID
#   3. Create OAuth2 credentials at https://console.cloud.google.com/apis/credentials
#      - Enable "Chrome Web Store API" on your project
#      - Create OAuth client (Desktop app type)
#   4. Copy .env.example to .env and fill in your credentials
#   5. Run: ./publish.sh setup   (one-time, to get refresh token)
#   6. Run: ./publish.sh         (to package and publish)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
DIST_DIR="$SCRIPT_DIR/dist"
ZIP_FILE="$DIST_DIR/uxly.zip"

# Load .env
if [[ -f "$ENV_FILE" ]]; then
  source "$ENV_FILE"
fi

# Files to include in the extension package
EXTENSION_FILES=(
  manifest.json
  content.js
  background.js
  sidepanel.html
  sidepanel.js
  sidepanel.css
  icons/
)

package() {
  echo "📦 Packaging extension..."
  rm -rf "$DIST_DIR"
  mkdir -p "$DIST_DIR"
  cd "$SCRIPT_DIR"
  zip -r "$ZIP_FILE" "${EXTENSION_FILES[@]}"
  echo "✅ Created $ZIP_FILE ($(du -h "$ZIP_FILE" | cut -f1))"
}

setup() {
  if [[ -z "${CHROME_CLIENT_ID:-}" || -z "${CHROME_CLIENT_SECRET:-}" ]]; then
    echo "❌ Set CHROME_CLIENT_ID and CHROME_CLIENT_SECRET in .env first"
    exit 1
  fi

  echo "🔑 Opening browser for OAuth authorization..."
  echo "   Authorize and copy the code you receive."
  echo ""

  AUTH_URL="https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=${CHROME_CLIENT_ID}&redirect_uri=http://127.0.0.1&access_type=offline"
  open "$AUTH_URL" 2>/dev/null || echo "Open this URL: $AUTH_URL"
  echo "   After authorizing, the browser will redirect to http://127.0.0.1/?code=..."
  echo "   Copy the 'code' parameter from the URL bar."

  echo ""
  read -rp "Paste the authorization code: " AUTH_CODE

  echo ""
  echo "🔄 Exchanging code for refresh token..."

  RESPONSE=$(curl -s "https://oauth2.googleapis.com/token" \
    -d "client_id=${CHROME_CLIENT_ID}" \
    -d "client_secret=${CHROME_CLIENT_SECRET}" \
    -d "code=${AUTH_CODE}" \
    -d "grant_type=authorization_code" \
    -d "redirect_uri=http://127.0.0.1")

  REFRESH_TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('refresh_token',''))" 2>/dev/null)

  if [[ -z "$REFRESH_TOKEN" ]]; then
    echo "❌ Failed to get refresh token:"
    echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
    exit 1
  fi

  # Append refresh token to .env
  if grep -q "CHROME_REFRESH_TOKEN" "$ENV_FILE" 2>/dev/null; then
    sed -i '' "s|^CHROME_REFRESH_TOKEN=.*|CHROME_REFRESH_TOKEN=${REFRESH_TOKEN}|" "$ENV_FILE"
  else
    echo "CHROME_REFRESH_TOKEN=${REFRESH_TOKEN}" >> "$ENV_FILE"
  fi

  echo "✅ Refresh token saved to .env"
}

get_access_token() {
  local RESPONSE
  RESPONSE=$(curl -s "https://oauth2.googleapis.com/token" \
    -d "client_id=${CHROME_CLIENT_ID}" \
    -d "client_secret=${CHROME_CLIENT_SECRET}" \
    -d "refresh_token=${CHROME_REFRESH_TOKEN}" \
    -d "grant_type=refresh_token")

  ACCESS_TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)

  if [[ -z "$ACCESS_TOKEN" ]]; then
    echo "❌ Failed to get access token:"
    echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
    exit 1
  fi
}

upload() {
  if [[ -z "${CHROME_EXTENSION_ID:-}" || -z "${CHROME_CLIENT_ID:-}" || -z "${CHROME_REFRESH_TOKEN:-}" ]]; then
    echo "❌ Missing credentials in .env. Run './publish.sh setup' first."
    exit 1
  fi

  if [[ ! -f "$ZIP_FILE" ]]; then
    package
  fi

  echo "🔑 Getting access token..."
  get_access_token

  echo "⬆️  Uploading to Chrome Web Store..."
  UPLOAD_RESPONSE=$(curl -s \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "x-goog-api-version: 2" \
    -X PUT \
    -T "$ZIP_FILE" \
    "https://www.googleapis.com/upload/chromewebstore/v1.1/items/${CHROME_EXTENSION_ID}")

  UPLOAD_STATUS=$(echo "$UPLOAD_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('uploadState',''))" 2>/dev/null)

  if [[ "$UPLOAD_STATUS" != "SUCCESS" ]]; then
    echo "❌ Upload failed:"
    echo "$UPLOAD_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$UPLOAD_RESPONSE"
    exit 1
  fi

  echo "✅ Upload successful"
}

publish() {
  echo "🚀 Publishing..."
  get_access_token

  PUBLISH_RESPONSE=$(curl -s \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "x-goog-api-version: 2" \
    -H "Content-Length: 0" \
    -X POST \
    "https://www.googleapis.com/chromewebstore/v1.1/items/${CHROME_EXTENSION_ID}/publish")

  PUBLISH_STATUS=$(echo "$PUBLISH_RESPONSE" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('status',[''])[0])" 2>/dev/null)

  if [[ "$PUBLISH_STATUS" == "OK" || "$PUBLISH_STATUS" == "PUBLISHED_WITH_FRICTION_WARNING" ]]; then
    echo "✅ Published successfully!"
  else
    echo "⚠️  Publish response:"
    echo "$PUBLISH_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$PUBLISH_RESPONSE"
  fi
}

case "${1:-all}" in
  setup)
    setup
    ;;
  package)
    package
    ;;
  upload)
    upload
    ;;
  publish)
    upload
    publish
    ;;
  all)
    package
    upload
    publish
    ;;
  *)
    echo "Usage: ./publish.sh [setup|package|upload|publish|all]"
    echo ""
    echo "  setup    — One-time OAuth setup to get refresh token"
    echo "  package  — Zip extension files into dist/uxly.zip"
    echo "  upload   — Package + upload to Chrome Web Store"
    echo "  publish  — Package + upload + publish"
    echo "  all      — Same as publish (default)"
    exit 1
    ;;
esac
