#!/bin/bash
# Test the delivered ZIP with a disposable data directory and loopback listener.
set -euo pipefail
archive="${1:?Usage: bash scripts/test-macos-artifact.sh /path/to/Seerr-macOS-arm64.zip [expected-commit]}"
expected_commit=${2:-}
work=$(mktemp -d "${TMPDIR:-/tmp}/seerr-artifact-test.XXXXXX")
server_pid=
# Called by the EXIT trap.
# shellcheck disable=SC2329
cleanup() {
  local status=$1
  if [[ -n "$server_pid" ]]; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ "$status" != 0 && -f "$work/server.log" ]]; then
    cat "$work/server.log" >&2
  fi
  rm -rf "$work"
}
trap 'cleanup "$?"' EXIT

ditto -x -k "$archive" "$work"
app="$work/Seerr.app"
runtime="$app/Contents/Resources/runtime"
test -x "$work/Install Seerr.command"
test -x "$app/Contents/MacOS/SeerrServer"
codesign --verify --deep --strict "$app"
if [[ -n "$expected_commit" ]]; then
  test "$(cat "$app/Contents/Resources/BUILD_COMMIT")" = "$expected_commit"
fi
for binary in "$app/Contents/MacOS/Seerr" "$runtime/node" "$runtime/llama-server" "$runtime/seerrvectors.dylib"; do
  test "$(lipo -archs "$binary")" = arm64
done

port=$("$runtime/node" -e '
  const server = require("node:net").createServer();
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(String(server.address().port));
    server.close();
  });
')
CONFIG_DIRECTORY="$work/data" HOST=127.0.0.1 PORT="$port" \
  "$app/Contents/MacOS/SeerrServer" > "$work/server.log" 2>&1 &
server_pid=$!
for ((attempt=0; attempt<30; attempt++)); do
  kill -0 "$server_pid"
  if curl --noproxy '*' --fail --silent --max-time 2 \
    "http://127.0.0.1:$port/api/v1/status?checkUpdateAvailable=false" > "$work/status.json" &&
    "$runtime/node" -e 'if (!require(process.argv[1]).version) process.exit(1)' "$work/status.json"; then
    test -L "$work/data/runtime/dist"
    codesign --verify --deep --strict "$app"
    echo 'macOS archive and headless startup verified'
    exit 0
  fi
  sleep 1
done
echo 'Packaged headless server did not become ready' >&2
exit 1
