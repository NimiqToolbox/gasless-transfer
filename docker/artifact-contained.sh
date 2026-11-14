#!/usr/bin/env bash
# Host-side Docker orchestration only. Source and installed tools remain baked and read-only; no host mounts.
set -euo pipefail
# Parse the orchestration body before starting long generators; editing this script during a run must not
# change the shell's next read offset midway through artifact export.
main() {
root=$(cd "$(dirname "$0")/.." && pwd)
kind=${1:?usage: artifact-contained.sh abi|lock|deps|static|coverage|mutation|mutation-smoke}
case "$kind" in
    abi|lock|deps|coverage) image=${GASLESS_ARTIFACT_IMAGE:-gasless/artifacts:workspace} ;;
    static|mutation|mutation-smoke) image=${GASLESS_ANALYSIS_IMAGE:-gasless/artifacts:analysis} ;;
    *) echo "Unsupported artifact kind: $kind" >&2; exit 2 ;;
esac
label="run-$$-$RANDOM"
id="gasless-artifact-$kind-$label"
created=false
volume_created=false
cleanup() {
    if $created; then docker rm -f "$id" >/dev/null 2>&1 || true; fi
    if $volume_created; then docker volume rm "$id-output" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Only lockfile resolution may contact the registry. It runs without lifecycle scripts or pnpm hooks.
network=none
[[ $kind != lock ]] || network=bridge
args=(--name "$id" --init --read-only --user 1000:1000 --network "$network"
      --cpus 4 --memory 6g --memory-swap 6g --pids-limit 512
      --cap-drop ALL --security-opt no-new-privileges:true
      --tmpfs /tmp:rw,nosuid,nodev,size=4g,mode=1777
      --tmpfs /home/node/.solc-select:rw,nosuid,nodev,size=16m,uid=1000,gid=1000
      --tmpfs /home/node/.foundry/cache:rw,nosuid,nodev,size=256m,uid=1000,gid=1000
      -e CI=1 -e NO_COLOR=1 -e RAYON_NUM_THREADS=4 -e TOKIO_WORKER_THREADS=4)
for path in out cache broadcast deployments; do
    args+=(--tmpfs "/work/contracts/$path:rw,nosuid,nodev,size=768m,uid=1000,gid=1000")
done
docker volume create --label io.gasless.purpose=artifact-export "$id-output" >/dev/null
volume_created=true
args+=(--mount "type=volume,source=$id-output,target=/export")
docker create "${args[@]}" --entrypoint node "$image" -e 'setInterval(() => {}, 60000)' >/dev/null
created=true
docker start "$id" >/dev/null
docker exec "$id" bash /work/scripts/verification/artifacts.sh "$kind" "$label"
docker exec "$id" node /work/scripts/verification/validate-artifacts.mjs "$kind" "$label"
# docker cp cannot archive this container's tmpfs. Stage the validated, bounded output in a
# dedicated node-owned volume; no source or installed runtime is writable. The volume is removed on exit.
docker exec "$id" cp -R /tmp/export/. /export/
# The validator admits only the two generated ABI files, the lockfile, or this run's versioned artifact subtree.
# Nothing is copied on generator/validation failure. Existing reports are never deleted or overwritten.
docker cp "$id:/export/." "$root/"
case "$kind" in
    abi) echo 'Generated sdk/abi/GaslessTransfer.json and sdk/src/core/abi.ts' ;;
    lock) echo 'Generated pnpm-lock.yaml' ;;
    *) echo "Artifacts: $root/build/$kind/$label" ;;
esac
}
main "$@"
