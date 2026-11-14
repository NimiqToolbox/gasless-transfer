#!/usr/bin/env bash
# Native Linux or contained Forge coverage. All reports use OUT; source paths are configurable.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
label=${1:?label}
shift
[[ $label =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 2
OUT=${OUT:-$root/build/coverage/$label-$$-$RANDOM}
if [[ -d $OUT && -n $(find "$OUT" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
    echo 'OUT must be empty; existing coverage reports are preserved' >&2; exit 1
fi
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
cd "${CONTRACTS_ROOT:-$root/contracts}"
forge build >"$OUT/forge-build.txt" 2>&1
# Coverage instrumentation and --ir-minimum (no optimizer) change gas usage and storage reads, so these tests run
# in the default suite instead: the exact-gas test, the one-SLOAD tokenConfig read (one read per field without the
# optimizer) and the owner-configuration rate checks (their long call sequences exceed the gas limit).
forge coverage --ir-minimum --report summary --report lcov --report-file "$OUT/lcov.info" \
    --no-match-test 'test_T29_permitGasStarvationCausesNoPartialStateChange|test_D6_tokenConfig_oneSlotReadOnce|test_ownerConfigurationsVaryAtTheDesignedRate_' \
    "$@" >"$OUT/coverage.txt" 2>&1 || {
    tail -60 "$OUT/coverage.txt"
    exit 1
}
grep -E '^\| (File|src/)|Total' "$OUT/coverage.txt" || true
sed -n '/^SF:src\//,/^end_of_record/p' "$OUT/lcov.info" | grep -E '^(SF|LF|LH|BRF|BRH|FNF|FNH):'
sed -n '/^SF:src\//,/^end_of_record/p' "$OUT/lcov.info" | grep -E '^SF:|^DA:[0-9]+,0$|^BRDA:.*,(0|-)$' || true
grep -E 'Suite result|tests passed|FAIL' "$OUT/coverage.txt" | tail -40 || true
