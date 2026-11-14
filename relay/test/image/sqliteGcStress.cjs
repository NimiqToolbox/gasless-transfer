// Regression check for the better-sqlite3 build in docker/relay.Dockerfile: leaves many garbage
// Statement objects (node::ObjectWrap) behind while allocating from timers, so that V8 also collects
// them from its own GC tasks, outside any JavaScript context, as it does in the long-running relay.
// An addon compiled against this Node version's unpatched node_object_wrap.h aborts here
// ("RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr", exit 133).
// Run from a directory that resolves better-sqlite3: `cd /out && node sqliteGcStress.cjs`.
'use strict';
const Database = require(require.resolve('better-sqlite3', { paths: [process.cwd()] }));

const db = new Database(':memory:');
db.exec('CREATE TABLE t (a INTEGER)');
let rounds = 0;
const timer = setInterval(() => {
    for (let i = 0; i < 2000; i++) db.prepare('SELECT a FROM t WHERE a = ?').all(i);
    const garbage = [];
    for (let i = 0; i < 20000; i++) garbage.push({ i, s: 'x'.repeat(32) });
    if (++rounds === 300) {
        clearInterval(timer);
        db.close();
        console.log(`better-sqlite3 GC stress: ${rounds} rounds, no abort`);
    }
}, 10);
