#!/bin/sh
# Run Seerr's embedding model on the macOS host for a Docker Desktop container.
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo 'This helper requires macOS.' >&2
  exit 1
fi
for command in git cmake curl shasum; do
  command -v "$command" >/dev/null || { echo "Missing dependency: $command" >&2; exit 1; }
done

runtime_dir=${SEERR_METAL_RUNTIME_DIR:-"$HOME/Library/Caches/Seerr/smart-search"}
revision=32bdc3a89e6528d3e419024c833c5dabf32c7541
model_name=bekko-embedding-v1-a8m-Q8_0.gguf
model_revision=4acacdea60b9393ae247a6ebf5b5707938c9755b
model_hash=0b0214214287e90ffb98ffb47e1071e5b193fb420d1d99b2ec8aab0ebb507fc0
mkdir -p "$runtime_dir"
if [ ! -x "$runtime_dir/llama-$revision/bin/llama-server" ]; then
  source_dir="$runtime_dir/llama-source-$revision"
  if [ ! -d "$source_dir/.git" ]; then
    git clone --filter=blob:none --no-checkout https://github.com/ggml-org/llama.cpp.git "$source_dir"
  fi
  git -C "$source_dir" checkout --detach "$revision"
  cmake -S "$source_dir" -B "$runtime_dir/llama-$revision" \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON \
    -DGGML_OPENMP=OFF -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF
  cmake --build "$runtime_dir/llama-$revision" --target llama-server -j 2
fi
if [ "${1:-}" = "--install" ]; then
  printf 'Metal runtime installed at %s\n' "$runtime_dir/llama-$revision/bin/llama-server"
  exit 0
fi
if [ "$#" -ne 0 ]; then
  echo 'Usage: smart-search-metal.sh [--install]' >&2
  exit 1
fi
: "${SEERR_EMBEDDING_API_KEY:?Set SEERR_EMBEDDING_API_KEY to a random secret of at least 32 characters}"
if [ "${#SEERR_EMBEDDING_API_KEY}" -lt 32 ]; then
  echo 'SEERR_EMBEDDING_API_KEY must contain at least 32 characters.' >&2
  exit 1
fi
model="$runtime_dir/$model_name"
if [ ! -f "$model" ] || [ "$(shasum -a 256 "$model" | cut -d ' ' -f 1)" != "$model_hash" ]; then
  temporary="$model.partial"
  trap 'rm -f "$temporary"' EXIT HUP INT TERM
  curl --fail --location --retry 3 --output "$temporary" \
    "https://huggingface.co/hotchpotch/bekko-embedding-v1-a8m-GGUF/resolve/$model_revision/$model_name"
  [ "$(shasum -a 256 "$temporary" | cut -d ' ' -f 1)" = "$model_hash" ] || { echo 'Model checksum failed.' >&2; exit 1; }
  mv "$temporary" "$model"
  trap - EXIT HUP INT TERM
fi
# Docker Desktop forwards host.docker.internal to macOS loopback. The shared
# secret prevents other local processes from submitting requests.
exec "$runtime_dir/llama-$revision/bin/llama-server" \
  --model "$model" --alias seerr-bekko-q8-0b021421 --embedding --pooling mean \
  --ctx-size 512 --threads 2 --parallel 1 --host "${SEERR_METAL_BIND:-127.0.0.1}" \
  --port "${SEERR_METAL_PORT:-38767}" --api-key "$SEERR_EMBEDDING_API_KEY" \
  --device MTL0 --n-gpu-layers all --no-warmup
