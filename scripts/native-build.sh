#!/usr/bin/env bash
# Reproduce the Linux Node build in a disposable, writable checkout; never run as root.
# Requires Node 24.22.2 (including its matching headers), pnpm 10.34.5, Python 3, make and g++.
# This is a build helper, not an OS sandbox. Install dependencies in a restricted build account.
set -euo pipefail
cd -- "${BASH_SOURCE[0]%/*}/.."
[[ $(id -u) != 0 ]] || { echo 'Build as an unprivileged user' >&2; exit 1; }
[[ $(uname -s) == Linux ]] || { echo 'This helper targets Linux' >&2; exit 1; }
[[ $(node --version) == v24.22.2 ]] || { echo 'Expected Node v24.22.2; review the addon workaround before updating Node' >&2; exit 1; }
[[ $(pnpm --version) == 10.34.5 ]] || { echo 'Expected pnpm 10.34.5' >&2; exit 1; }
mode=${1:-build}
case "$mode" in download) pnpm install --frozen-lockfile --ignore-scripts; exit ;; build) ;; *) echo 'Usage: native-build.sh [download|build]' >&2; exit 2 ;; esac
headers=${NODE_HEADERS_DIR:-/usr/local/include/node}
[[ -f "$headers/node_object_wrap.h" && -f "$headers/node_version.h" ]] || { echo 'Set NODE_HEADERS_DIR to the matching Node include/node directory' >&2; exit 1; }
{ grep -q '^#define NODE_MAJOR_VERSION 24$' "$headers/node_version.h" &&
  grep -q '^#define NODE_MINOR_VERSION 22$' "$headers/node_version.h" &&
  grep -q '^#define NODE_PATCH_VERSION 2$' "$headers/node_version.h"; } ||
    { echo 'NODE_HEADERS_DIR does not hold the Node 24.22.2 headers' >&2; exit 1; }
scratch=$(mktemp -d "${TMPDIR:-/tmp}/gasless-node-build.XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch/include"
cp -a "$headers" "$scratch/include/node"
# Same reviewed ObjectWrap workaround as docker/relay.Dockerfile. Installed headers are unchanged.
sed -i -e '/^    AddCleanupHook();$/d' -e '/^    RemoveCleanupHook();$/d' "$scratch/include/node/node_object_wrap.h"
# `set -e` ignores a status inverted with `!`, so the check is an explicit branch.
if grep -qE '^ +(Add|Remove)CleanupHook\(\);' "$scratch/include/node/node_object_wrap.h"; then
    echo 'The ObjectWrap cleanup hooks are still in the copied headers; review the workaround for this Node version' >&2
    exit 1
fi
export CI=1 npm_config_build_from_source=true npm_config_nodedir="$scratch"
# Run this phase without network access. Download first with the separate mode above.
pnpm --recursive rebuild
addon=(node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3)
[[ ${#addon[@]} == 1 ]]
grep -q '"build_from_source": "true"' "${addon[0]}/build/config.gypi"
test -f "${addon[0]}/build/Release/obj.target/better_sqlite3/src/better_sqlite3.o"
(cd relay && node test/image/sqliteGcStress.cjs)
pnpm build
