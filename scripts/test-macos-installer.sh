#!/bin/bash
# Exercise replacement and quarantine handling without touching the installed app.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/seerr-installer-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
source_app="$work/source/Seerr.app"
target="$work/apps/Seerr.app"
mkdir -p "$source_app/Contents/MacOS" "$source_app/Contents/Resources" "$work/apps"
cp "$root/native/macos/Info.plist" "$source_app/Contents/Info.plist"
cp /usr/bin/true "$source_app/Contents/MacOS/Seerr"
printf 'test resource\n' > "$source_app/Contents/Resources/test.txt"
codesign --force --deep --sign - "$source_app" >/dev/null 2>&1
xattr -w com.apple.quarantine '0082;6af8a409;Keka;' "$source_app"
xattr -w com.apple.quarantine '0082;6af8a409;Keka;' "$source_app/Contents/Resources/test.txt"
"$root/scripts/install-macos-app.sh" "$source_app" "$target" >/dev/null
codesign --verify --deep --strict "$target"
if xattr -lr "$target" | grep -q com.apple.quarantine; then
  echo 'Installer left a quarantine attribute on the app' >&2; exit 1
fi
"$root/scripts/install-macos-app.sh" "$source_app" "$target" >/dev/null
printf 'tampered\n' > "$source_app/Contents/Resources/test.txt"
if "$root/scripts/install-macos-app.sh" "$source_app" "$target" >/dev/null 2>&1; then
  echo 'Installer accepted a damaged source' >&2; exit 1
fi
codesign --verify --deep --strict "$target"
echo 'macOS installer tests passed'
