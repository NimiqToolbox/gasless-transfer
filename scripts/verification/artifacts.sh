#!/usr/bin/env bash
# Container-side artifact generator. The caller supplies a read-only snapshot at /work and disposable /tmp.
set -euo pipefail
kind=${1:?artifact kind}
label=${2:?run label}
[[ $label =~ ^run-[0-9]+-[0-9]+$ ]] || exit 2
root=$(cd "$(dirname "$0")/../.." && pwd)
export_root=/tmp/export
mkdir -p "$export_root"
out="$export_root/build/$kind/$label"
case "$kind" in
    abi)
        GASLESS_ABI_OUTPUT="$export_root" bash "$root/sdk/scripts/gen-abi.sh"
        ;;
    lock)
        mkdir -p /tmp/lock/sdk /tmp/lock/relay /tmp/pnpm-cache
        cp "$root/package.json" "$root/pnpm-workspace.yaml" "$root/pnpm-lock.yaml" /tmp/lock/
        cp "$root/sdk/package.json" /tmp/lock/sdk/
        cp "$root/relay/package.json" /tmp/lock/relay/
        cd /tmp/lock
        XDG_CACHE_HOME=/tmp/pnpm-cache pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile --no-frozen-lockfile --store-dir /tmp/pnpm-store
        cp pnpm-lock.yaml "$export_root/pnpm-lock.yaml"
        ;;
    deps)
        mkdir -p "$out"
        cp -R /deps/. "$out/"
        ;;
    coverage)
        OUT="$out" bash "$root/scripts/verification/coverage.sh" "$label"
        ;;
    static)
        OUT="$out" bash "$root/scripts/verification/static.sh"
        ;;
    mutation)
        # Mutants and their local dependency copies are generated artifacts, not the immutable input snapshot.
        OUT="$out" bash "$root/scripts/verification/mutate.sh" "$label" src
        ;;
    mutation-smoke)
        # A representative workflow check, not the full mutation score. It still runs the full default tests.
        OUT="$out" bash "$root/scripts/verification/mutate.sh" "$label" src --mutators-to-run RR --contract-names GaslessTransfer
        ;;
    *) echo "Unsupported artifact kind: $kind" >&2; exit 2 ;;
esac
