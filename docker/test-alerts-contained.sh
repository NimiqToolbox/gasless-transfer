#!/usr/bin/env bash
# Snapshot only the public rule inputs; never mount the host workspace into the workload.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
mkdir -p build/alert-rules
run=$(mktemp -d "$root/build/alert-rules/run-XXXXXXXX")
mkdir -p "$run/source/docker" "$run/source/relay/config" "$run/source/relay/test/ops"
for file in docker/alerts.Dockerfile docker/test-alerts-contained.sh relay/config/alerts.yml relay/config/prometheus.yml.example relay/test/ops/alerts.test.yml; do
    cp "$file" "$run/source/$file"
done
(
    cd "$run/source"
    sha256sum docker/alerts.Dockerfile docker/test-alerts-contained.sh relay/config/alerts.yml relay/config/prometheus.yml.example relay/test/ops/alerts.test.yml
) > "$run/SHA256SUMS"
image="gasless/alerts:$(basename "$run" | tr '[:upper:]' '[:lower:]')"
docker build --network=none -f "$run/source/docker/alerts.Dockerfile" -t "$image" "$run/source" 2>&1 | tee "$run/build.log"
docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$image" > "$run/image.txt"
docker run --rm --init --read-only --user 65534:65534 --network none \
    --cpus 1 --memory 256m --memory-swap 256m --pids-limit 64 \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
    "$image" 2>&1 | tee "$run/tests.log"
echo "Alert validation evidence: $run"
