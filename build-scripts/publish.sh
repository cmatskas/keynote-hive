#!/bin/bash
# publish.sh — Build, sign, notarize, and publish Transcribely to GitHub Releases
#
# Prerequisites:
#   - Apple Developer ID cert in Keychain (for macOS signing)
#   - Apple env vars in build-scripts/.apple-env
#   - GITHUB_TOKEN env var with repo write access
#
# Apple env file (build-scripts/.apple-env):
#   APPLE_ID=your@email.com
#   APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
#   APPLE_TEAM_ID=XXXXXXXXXX
#
# Usage:
#   GITHUB_TOKEN=ghp_xxx ./build-scripts/publish.sh [mac|win|all]

set -e

PLATFORM=${1:-all}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Validate GITHUB_TOKEN ─────────────────────────────────
if [ -z "$GITHUB_TOKEN" ]; then
  echo "✗ GITHUB_TOKEN is required. Set it before running:"
  echo "  export GITHUB_TOKEN=ghp_..."
  exit 1
fi
echo "✓ GitHub token found"

# ── Load Apple signing env vars ───────────────────────────
APPLE_ENV="$SCRIPT_DIR/.apple-env"
if [ -f "$APPLE_ENV" ]; then
  set -a
  source "$APPLE_ENV"
  set +a
  echo "✓ Apple signing config loaded"
else
  if [ "$PLATFORM" = "mac" ] || [ "$PLATFORM" = "all" ]; then
    echo "⚠ No build-scripts/.apple-env found — macOS build will not be notarized"
  fi
fi

echo ""
echo "Publishing Transcribely to GitHub Releases..."
echo ""

if [ "$PLATFORM" = "mac" ] || [ "$PLATFORM" = "all" ]; then
  echo "▸ Building macOS (universal)..."
  npx electron-builder --mac --universal --publish never

  DMG=$(ls dist/temp/*.dmg 2>/dev/null | head -1)
  if [ -z "$DMG" ]; then
    echo "✗ No DMG found in dist/temp/"
    exit 1
  fi

  if [ -n "$APPLE_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ]; then
    echo "▸ Notarizing $DMG..."
    SUBMISSION=$(xcrun notarytool submit "$DMG" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait 2>&1)
    echo "$SUBMISSION"

    if echo "$SUBMISSION" | grep -q "status: Accepted"; then
      echo "▸ Stapling notarization ticket..."
      xcrun stapler staple "$DMG"
    else
      echo "✗ Notarization failed — check output above"
      exit 1
    fi
  fi

  echo "▸ Publishing macOS to GitHub Release..."
  TAG=$(node -p "require('./package.json').version")
  DMG=$(ls dist/temp/*.dmg 2>/dev/null | head -1)
  ZIP=$(ls dist/temp/*.zip 2>/dev/null | head -1)
  YML="dist/temp/latest-mac.yml"
  gh release create "v$TAG" --title "v$TAG" --notes "" 2>/dev/null || true
  gh release upload "v$TAG" "$DMG" "${DMG}.blockmap" "$ZIP" "${ZIP}.blockmap" "$YML" --clobber
  echo ""
fi

if [ "$PLATFORM" = "win" ] || [ "$PLATFORM" = "all" ]; then
  echo "▸ Building & publishing Windows x64..."
  npx electron-builder --win --x64 --publish always
  echo ""
  echo "▸ Building & publishing Windows arm64..."
  npx electron-builder --win --arm64 --publish always
  echo ""
fi

echo "✓ Done. Release published to https://github.com/cmatskas/keynote-hive/releases"
