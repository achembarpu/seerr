#!/bin/bash
# Build a self-contained private Apple Silicon app; no model weights are bundled.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo 'Build this app on an Apple Silicon Mac.' >&2; exit 1
fi
for tool in node pnpm git cmake swiftc curl shasum ditto sips python3 codesign vtool; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
export MACOSX_DEPLOYMENT_TARGET=13.5
node_version=24.22.1
node_hash=89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7
revision=32bdc3a89e6528d3e419024c833c5dabf32c7541
output="$root/build/macos"
work=$(mktemp -d "${TMPDIR:-/tmp}/seerr-native-build.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$output"

cd "$root"
pnpm build

# Install only production dependencies. Skip this project's developer lifecycle
# scripts while retaining dependency install scripts for native modules.
mkdir -p "$work/dependencies"
cp package.json pnpm-lock.yaml .npmrc "$work/dependencies/"
node - "$work/dependencies/package.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
delete pkg.scripts;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
NODE
pnpm --dir "$work/dependencies" install --prod --frozen-lockfile

archive="$work/node.tar.gz"
curl --fail --location --retry 3 --output "$archive" "https://nodejs.org/dist/v$node_version/node-v$node_version-darwin-arm64.tar.gz"
echo "$node_hash  $archive" | shasum -a 256 -c -
tar -xzf "$archive" -C "$work" "node-v$node_version-darwin-arm64/bin/node"

if [[ -n ${SEERR_MACOS_LLAMA_BINARY:-} ]]; then
  llama=$SEERR_MACOS_LLAMA_BINARY
else
  git clone --filter=blob:none --no-checkout https://github.com/ggml-org/llama.cpp.git "$work/llama"
  git -C "$work/llama" checkout --detach "$revision"
  cmake -S "$work/llama" -B "$work/llama-build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=13.5 -DGGML_NATIVE=OFF -DGGML_METAL=ON -DGGML_OPENMP=OFF -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF
  cmake --build "$work/llama-build" --target llama-server -j 2
  llama="$work/llama-build/bin/llama-server"
fi
[[ $(file -b "$llama") == *arm64* ]] || { echo 'Expected an Apple Silicon llama-server binary.' >&2; exit 1; }

app="$work/Seerr.app"
resources="$app/Contents/Resources"
mkdir -p "$app/Contents/MacOS" "$resources/app" "$resources/runtime"
cp native/macos/Info.plist "$app/Contents/Info.plist"
CLANG_MODULE_CACHE_PATH="$work/swift-cache" swiftc -target arm64-apple-macos13.5 -module-cache-path "$work/swift-cache" -O \
  native/macos/Seerr.swift -o "$app/Contents/MacOS/Seerr"
cp "$work/node-v$node_version-darwin-arm64/bin/node" "$resources/runtime/node"
cp "$llama" "$resources/runtime/llama-server"
cp package.json next.config.mjs seerr-api.yml "$resources/app/"
ditto dist "$resources/app/dist"
ditto public "$resources/app/public"
rsync -a --exclude cache --exclude '/dev/' .next/ "$resources/app/.next/"
ditto "$work/dependencies/node_modules" "$resources/app/node_modules"

# Check every bundled Apple Silicon executable and native dependency. Building
# on a newer macOS must not silently make the app unusable on older systems.
check_minimum() {
  local executable=$1 minimum
  minimum=$(vtool -arch arm64 -show-build "$executable" | awk '$1 == "minos" { print $2; exit }')
  python3 - "$executable" "$minimum" <<'PYTHON'
import sys
name, version = sys.argv[1:]
parts = tuple(map(int, version.split('.'))) if version else ()
parts = (parts + (0, 0, 0))[:3]
if not version or parts > (13, 5, 0):
    raise SystemExit(f'{name} requires macOS {version or "unknown"}; expected 13.5 or earlier')
PYTHON
}
for executable in "$app/Contents/MacOS/Seerr" "$resources/runtime/node" "$resources/runtime/llama-server"; do
  check_minimum "$executable"
done
while IFS= read -r -d '' executable; do
  if file -b "$executable" | grep -q 'Mach-O.*arm64'; then check_minimum "$executable"; fi
done < <(find "$resources/app/node_modules" -type f \( -name '*.node' -o -name '*.dylib' \) -print0)

iconset="$work/icons"
mkdir -p "$iconset"
for size in 16 32 64 128 256 512 1024; do
  sips -z "$size" "$size" public/android-chrome-512x512.png --out "$iconset/$size.png" >/dev/null
done
python3 - "$iconset" "$resources/Seerr.icns" <<'PYTHON'
import pathlib, struct, sys
icons = pathlib.Path(sys.argv[1])
entries = []
for kind, size in [('icp4', 16), ('icp5', 32), ('icp6', 64), ('ic07', 128), ('ic08', 256), ('ic09', 512), ('ic10', 1024)]:
    image = (icons / f'{size}.png').read_bytes()
    entries.append(kind.encode('ascii') + struct.pack('>I', len(image) + 8) + image)
contents = b''.join(entries)
pathlib.Path(sys.argv[2]).write_bytes(b'icns' + struct.pack('>I', len(contents) + 8) + contents)
PYTHON
# Ad-hoc signing makes the bundle internally consistent; it is not notarized.
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
rm -rf "$output/Seerr.app"
ditto "$app" "$output/Seerr.app"
rm -f "$output/Seerr-macOS-arm64.zip"
ditto -c -k --sequesterRsrc --keepParent "$output/Seerr.app" "$output/Seerr-macOS-arm64.zip"
echo "Built $output/Seerr-macOS-arm64.zip"
