#!/usr/bin/env bash
# Docker orchestration only; runtime checks execute inside an offline, bounded container.
set -euo pipefail
image=${1:-gasless/relay:local}
repo_root=$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd)
mkdir -p "$repo_root/build/image-check"
run=$(mktemp -d "$repo_root/build/image-check/run-XXXXXXXX")
mkdir -p "$run/source/checks"
cp "$repo_root/docker/image-check.Dockerfile" "$run/source/Dockerfile"
cp "$repo_root/relay/test/image/checkImage.mjs" "$repo_root/relay/test/image/closureOrphans.mjs" "$run/source/checks/"
# Resolve mutable tags once, before building, and record the exact production image inspected.
runtime_id=$(docker image inspect --format '{{.Id}}' "$image")
printf '%s\n' "$runtime_id" > "$run/runtime-image.txt"
# The checks below run with --user 1000:1000 whatever the image declares, so the declared user is checked here.
image_user=$(docker image inspect --format '{{.Config.User}}' "$runtime_id")
[[ $image_user == node ]] || { echo "the relay image must declare USER node, not '${image_user:-root}'" >&2; exit 1; }
(cd "$run/source" && sha256sum Dockerfile checks/*.mjs) > "$run/SHA256SUMS"
check_image="gasless/image-check:$(basename "$run" | tr '[:upper:]' '[:lower:]')"
base_image="gasless/image-check-base:$(basename "$run" | tr '[:upper:]' '[:lower:]')"
docker tag "$runtime_id" "$base_image"
docker build --network=none --build-arg "RELAY_IMAGE=$base_image" -t "$check_image" "$run/source" 2>&1 | tee "$run/build.log"
check_id=$(docker image inspect --format '{{.Id}}' "$check_image")
printf '%s\n' "$check_id" > "$run/check-image.txt"
for check in checkImage.mjs closureOrphans.mjs; do
    docker run --rm --init --network none --read-only --user 1000:1000 \
        --cpus 2 --memory 512m --memory-swap 512m --pids-limit 128 \
        --cap-drop ALL --security-opt no-new-privileges:true \
        --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 \
        --tmpfs /data:rw,nosuid,nodev,size=64m,uid=1000,gid=1000 \
        "$check_id" node "/checks/$check" 2>&1 | tee "$run/$check.log"
done
echo "Runtime image validation evidence: $run"
