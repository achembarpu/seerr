#!/bin/bash
# Install a locally built, ad-hoc-signed Seerr app without changing system-wide security settings.
set -euo pipefail
if [[ $(uname -s) != Darwin ]]; then
  echo 'This installer requires macOS.' >&2
  exit 1
fi
script_dir=$(cd "$(dirname "$0")" && pwd)
if [[ -d "$script_dir/Seerr.app" ]]; then
  default_source="$script_dir/Seerr.app"
else
  default_source="$script_dir/../build/macos/Seerr.app"
fi
source_app=${1:-$default_source}
destination=${2:-"$HOME/Applications/Seerr.app"}
if [[ $# -lt 2 && -d "$HOME/Applications" ]]; then
  shopt -s nullglob
  installed=()
  for candidate in "$HOME/Applications"/Seerr*.app; do
    if [[ $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$candidate/Contents/Info.plist" 2>/dev/null || :) == dev.seerr.private ]]; then
      installed+=("$candidate")
    fi
  done
  if [[ ${#installed[@]} -eq 1 ]]; then destination=${installed[0]}; fi
  if [[ ${#installed[@]} -gt 1 ]]; then
    echo 'Multiple Seerr apps found. Specify which app to replace as the second argument.' >&2
    exit 1
  fi
fi
if [[ $# -gt 2 || ! -d "$source_app" || "$destination" != /* || "$destination" != *.app ]]; then
  echo "Usage: $0 [built-Seerr.app] [absolute-install-path.app]" >&2
  exit 1
fi
bundle_id() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist"
}
if [[ $(bundle_id "$source_app") != dev.seerr.private ]]; then
  echo 'The source is not the private Seerr app.' >&2
  exit 1
fi
# An ad-hoc signature detects accidental corruption, but does not establish
# who made the app. Only install builds obtained from a source you trust.
codesign --verify --deep --strict "$source_app"
parent=$(dirname "$destination")
mkdir -p "$parent"
if [[ -e "$destination" ]]; then
  if [[ ! -d "$destination" || $(bundle_id "$destination" 2>/dev/null || :) != dev.seerr.private ]]; then
    echo "Refusing to replace a different app at $destination" >&2
    exit 1
  fi
  if lsof -t "$destination/Contents/MacOS/Seerr" >/dev/null 2>&1; then
    echo 'Quit the running Seerr app before installing an update.' >&2
    exit 1
  fi
fi
staging=$(mktemp -d "$parent/.seerr-install.XXXXXX")
cleanup() {
  if [[ -e "$staging/previous.app" && ! -e "$destination" ]]; then
    if ! mv "$staging/previous.app" "$destination"; then
      echo "Could not restore the previous app; it is at $staging/previous.app" >&2
      return
    fi
  fi
  rm -rf "$staging"
}
trap cleanup EXIT
# Stage beside the destination for an atomic move. Existing app data is stored
# separately in Application Support and is never touched by the installer.
ditto "$source_app" "$staging/Seerr.app"
codesign --verify --deep --strict "$staging/Seerr.app"
xattr -dr com.apple.quarantine "$staging/Seerr.app" 2>/dev/null || {
  echo 'Could not clear quarantine from the staged app.' >&2
  exit 1
}
codesign --verify --deep --strict "$staging/Seerr.app"
if [[ -e "$destination" ]]; then mv "$destination" "$staging/previous.app"; fi
mv "$staging/Seerr.app" "$destination"
echo "Installed $destination"
echo 'Your Seerr data and indexes in Application Support were preserved.'
