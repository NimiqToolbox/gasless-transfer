#!/usr/bin/env bash
# Image check: what the node_object_wrap.h patch of docker/relay.Dockerfile and docker/dev.Dockerfile
# changes, and whether relay/test/image/sqliteGcStress.cjs catches the crash it prevents.
#
# Runs in the workspace or toolchain image (it needs the compiler and the image's Node headers), without
# network access, from the repository root:
#   docker build -f docker/dev.Dockerfile --target workspace -t gasless/workspace:check .
#   docker run --rm --network none gasless/workspace:check 'bash relay/test/image/objectWrapPatch.sh'
#
# 1. The patched copy of the headers (/opt/node-headers) differs from the image's own headers only by the
#    two deleted calls (AddCleanupHook() in the constructor, RemoveCleanupHook() in the destructor). The
#    class members (refs_, handle_) and the virtual functions stay, so the class layout is unchanged.
# 2. better-sqlite3 is compiled twice in a scratch directory, against the unpatched and the patched
#    headers. The unpatched build imports node::RemoveEnvironmentCleanupHook and must abort in
#    sqliteGcStress.cjs ("Assertion failed: (env) != nullptr") on every run; the patched build must not
#    import it and must pass every run.
# 3. Evidence only: worker threads that end with statements still alive. Without the hooks their C++
#    wrappers are never deleted (better-sqlite3's own cleanup hook still closes the database and
#    finalizes the statements), so each such worker leaks a little memory; the relay uses no workers.
#
# RUNS (default 5) sets how often each build runs the stress test. Exits 1 if an expectation fails.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STORE="$ROOT/node_modules/.pnpm"
GYP=/usr/local/lib/node_modules/pnpm/dist/node_modules/node-gyp/bin/node-gyp.js
STRESS="$ROOT/relay/test/image/sqliteGcStress.cjs"
RUNS="${RUNS:-5}"
WORK="$(mktemp -d)"
FAILED=0
fail() {
    echo "FAIL $*"
    FAILED=1
}

echo "== 1. header patch"
UNPATCHED=/usr/local/include/node
PATCHED=/opt/node-headers/include/node
if diff -r -x node_object_wrap.h "$UNPATCHED" "$PATCHED" >/dev/null; then
    echo "ok   the header copy is identical to the image's headers apart from node_object_wrap.h"
else
    fail "the header copy differs in other files"
fi
CHANGES="$(diff "$UNPATCHED/node_object_wrap.h" "$PATCHED/node_object_wrap.h" | grep -E '^[<>]')"
echo "$CHANGES" | sed 's/^/     /'
if [ "$CHANGES" = "$(printf '<     AddCleanupHook();\n<     RemoveCleanupHook();')" ]; then
    echo "ok   node_object_wrap.h: exactly the two hook calls are removed (members and virtual functions unchanged)"
else
    fail "node_object_wrap.h: unexpected changes"
fi

# A scratch copy of better-sqlite3 (sources) and its runtime dependencies, compiled against $1.
build() {
    local nodedir="$1" dir="$2"
    mkdir -p "$dir/node_modules"
    cp -rL "$(echo "$STORE"/better-sqlite3@*/node_modules/better-sqlite3)" "$dir/node_modules/"
    cp -rL "$(echo "$STORE"/bindings@*/node_modules)"/. "$dir/node_modules/"
    rm -rf "$dir/node_modules/better-sqlite3/build"
    (cd "$dir/node_modules/better-sqlite3" && env -u npm_config_nodedir node "$GYP" rebuild --release --nodedir="$nodedir" >"$dir/gyp.log" 2>&1) ||
        { tail -20 "$dir/gyp.log"; fail "compile against $nodedir"; return 1; }
    local addon="$dir/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
    echo "     $(sha256sum "$addon" | cut -d' ' -f1)  compiled against $nodedir"
    nm -D --undefined-only "$addon" | grep -o 'node[0-9]*[A-Za-z]*EnvironmentCleanupHook' | sed 's/^/     imports /'
}

# Runs the stress test RUNS times from $1; prints the exit status of each run; echoes the number of aborts.
stress() {
    local dir="$1" aborts=0 status
    for i in $(seq "$RUNS"); do
        (cd "$dir" && node "$STRESS") >"$dir/stress.log" 2>&1
        status=$?
        if [ "$status" -ne 0 ]; then
            aborts=$((aborts + 1))
            echo "     run $i: exit $status, $(grep -m1 -o 'Assertion failed.*' "$dir/stress.log" || echo 'no assertion message')" >&2
        else
            echo "     run $i: exit 0, $(tail -1 "$dir/stress.log")" >&2
        fi
    done
    echo "$aborts"
}

echo "== 2a. unpatched headers ($UNPATCHED): the stress test must abort"
if build /usr/local "$WORK/unpatched"; then
    nm -D --undefined-only "$WORK/unpatched/node_modules/better-sqlite3/build/Release/better_sqlite3.node" | grep -q RemoveEnvironmentCleanupHook ||
        fail "the unpatched build does not import RemoveEnvironmentCleanupHook"
    ABORTS="$(stress "$WORK/unpatched")"
    if [ "$ABORTS" = "$RUNS" ]; then echo "ok   aborted in $ABORTS of $RUNS runs"; else fail "aborted in only $ABORTS of $RUNS runs"; fi
fi

echo "== 2b. patched headers (/opt/node-headers): the stress test must pass"
if build /opt/node-headers "$WORK/patched"; then
    ! nm -D --undefined-only "$WORK/patched/node_modules/better-sqlite3/build/Release/better_sqlite3.node" | grep -q RemoveEnvironmentCleanupHook ||
        fail "the patched build imports RemoveEnvironmentCleanupHook"
    ABORTS="$(stress "$WORK/patched")"
    if [ "$ABORTS" = "0" ]; then echo "ok   no abort in $RUNS runs"; else fail "aborted in $ABORTS of $RUNS runs"; fi
fi

echo "== 3. evidence: 200 workers, each ending with 1000 live statements (RSS growth of the main process)"
cat >"$WORK/workers.cjs" <<'EOF'
'use strict';
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
if (isMainThread) {
    const run = () => new Promise((resolve, reject) => {
        const w = new Worker(__filename);
        w.on('error', reject);
        w.on('exit', resolve);
    });
    (async () => {
        for (let i = 0; i < 20; i++) await run();
        global.gc();
        const before = process.memoryUsage().rss;
        for (let i = 0; i < 200; i++) await run();
        global.gc();
        const growth = process.memoryUsage().rss - before;
        console.log(`${(growth / 1e6).toFixed(1)} MB (${(growth / 200 / 1024).toFixed(1)} KiB per worker)`);
    })().catch((err) => { console.error(err); process.exit(1); });
} else {
    const Database = require(require.resolve('better-sqlite3', { paths: [process.cwd()] }));
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (a INTEGER)');
    const keep = [];
    for (let i = 0; i < 2000; i++) {
        const s = db.prepare('SELECT a FROM t WHERE a = ?');
        s.all(i);
        if (i % 2 === 0) keep.push(s);
    }
    globalThis.keep = keep;
}
EOF
for variant in unpatched patched; do
    if [ -d "$WORK/$variant/node_modules/better-sqlite3/build" ]; then
        result="$(cd "$WORK/$variant" && node --expose-gc "$WORK/workers.cjs" 2>&1 | tail -1)" || fail "$variant: a worker failed"
        echo "     $variant: $result"
    fi
done

rm -rf "$WORK"
if [ "$FAILED" = 0 ]; then echo "objectWrapPatch: all checks passed"; else echo "objectWrapPatch: checks failed"; fi
exit "$FAILED"
