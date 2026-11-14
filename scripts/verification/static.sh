#!/usr/bin/env bash
# Every detector remains enabled. Finding exit codes are report data, not a claim that analysis is clean.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-$root/build/static/run-$$-$RANDOM}
if [[ -d $OUT && -n $(find "$OUT" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
    echo 'OUT must be empty; existing static reports are preserved' >&2; exit 1
fi
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
record() { echo "$1 $2" >> "$OUT/exit-codes.txt"; }
run_report() {
    local name=$1; shift
    local result=0
    "$@" >"$OUT/$name.txt" 2>&1 || result=$?
    record "$name" "$result"
}
: > "$OUT/exit-codes.txt"
{
    slither --version
    aderyn --version
    solhint --version
    forge --version
    if [[ -f /deps/VERSIONS ]]; then cat /deps/VERSIONS; fi
} > "$OUT/versions.txt" 2>&1
cd "${CONTRACTS_ROOT:-$root/contracts}"
# Slither's Forge backend cleans and forces recompilation: these are removable children of the artifact root,
# not tmpfs mount roots or source directories. Installed compilers and Solidity dependencies remain read-only.
export FOUNDRY_OUT="$OUT/forge/out" FOUNDRY_CACHE_PATH="$OUT/forge/cache"
forge build --skip test --skip script > "$OUT/forge-build.txt" 2>&1
record forge-build 0
run_report slither slither . --config-file slither.config.json --json "$OUT/slither.json"
run_report slither-detectors slither . --config-file slither.config.json --list-detectors
echo '{}' > "$OUT/slither-empty.config.json"
run_report slither-with-dependencies slither . --config-file "$OUT/slither-empty.config.json"
for printer in human-summary function-summary vars-and-auth; do
    run_report "slither-print-$printer" slither . --config-file slither.config.json --print "$printer"
done
result=0
aderyn . --src src -o "$OUT/aderyn.md" > "$OUT/aderyn-stdout.txt" 2>&1 || result=$?
record aderyn-md "$result"
result=0
aderyn . --src src -o "$OUT/aderyn.json" >> "$OUT/aderyn-stdout.txt" 2>&1 || result=$?
record aderyn-json "$result"
run_report solhint solhint --disc --noPoster -c "$root/scripts/verification/solhint.json" -f unix 'src/**/*.sol'
# A crashed/misconfigured analyzer must not look like a completed report bundle.
node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1]));if(a.success===false)throw Error("Slither analysis failed");JSON.parse(fs.readFileSync(process.argv[2]));' "$OUT/slither.json" "$OUT/aderyn.json"
test -s "$OUT/aderyn.md"
# Compiler intermediates are not part of the maintained static report bundle.
rm -rf "$OUT/forge"
cat "$OUT/exit-codes.txt"
