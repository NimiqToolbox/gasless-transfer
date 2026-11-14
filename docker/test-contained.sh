#!/usr/bin/env bash
# Run the baked workspace with read-only source/runtimes and task-owned, disposable build outputs.
set -euo pipefail
image=${GASLESS_TEST_IMAGE:-gasless/verify:local}
network=${GASLESS_TEST_NETWORK:-none}
case "$network" in none|bridge) ;; *) echo 'GASLESS_TEST_NETWORK must be none or bridge' >&2; exit 2 ;; esac
args=(--rm --init --read-only --user 1000:1000 --network "$network"
      --cpus 4 --memory 6g --memory-swap 6g --pids-limit 512
      --cap-drop ALL --security-opt no-new-privileges:true
      --tmpfs /tmp:rw,nosuid,nodev,size=2g,mode=1777
      -e CI=1 -e GASLESS_PREBUILT_SDK=true -e NO_COLOR=1 -e RAYON_NUM_THREADS=4 -e TOKIO_WORKER_THREADS=4)
for path in relay/dist contracts/out contracts/cache contracts/broadcast contracts/deployments \
            node_modules/.vite-temp sdk/node_modules/.vite-temp relay/node_modules/.vite-temp \
            sdk/node_modules/.vite relay/node_modules/.vite; do
    args+=(--tmpfs "/work/$path:rw,nosuid,nodev,size=768m,uid=1000,gid=1000")
done
args+=(--tmpfs /home/node/.foundry/cache:rw,nosuid,nodev,size=512m,uid=1000,gid=1000)
for name in TOKEN_PINS_RPC_URLS POLYGON_RPC_URL POLYGON_VERIFY_RPC_URL POLYGON_NATIVE_GAS DEPLOYMENT_ADDRESS DEPLOYMENT_TX_HASH \
            GASLESS_TRANSFER_OWNER GASLESS_TRANSFER_CURRENT_OWNER DEPLOY_BLOCK FORK_BLOCK VER_FORK FOUNDRY_PROFILE; do
    if printenv "$name" >/dev/null; then args+=(-e "$name"); fi
done
docker run "${args[@]}" "$image" "$@"
