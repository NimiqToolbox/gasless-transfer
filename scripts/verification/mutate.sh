#!/usr/bin/env bash
# Mutate a disposable derived copy only; the input repository and installed runtimes stay unchanged.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
label=${1:?label}
target=${2:-src}
shift 2 || shift "$#"
[[ $label =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 2
OUT=${OUT:-$root/build/mutation/$label-$$-$RANDOM}
if [[ -d $OUT && -n $(find "$OUT" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
    echo 'OUT must be empty; existing mutation reports are preserved' >&2; exit 1
fi
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/gasless-mutation.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
input=${CONTRACTS_ROOT:-$root/contracts}
cp -R "$input" "$scratch/contracts"
cd "$scratch/contracts"
# Plain solc used by crytic-compile needs dependencies inside its allowed paths.
deps=${GASLESS_SOLIDITY_DEPS:-$input/lib}
rm -rf lib out cache broadcast deployments
cp -RL "$deps" lib
solc_binary=${SOLC_BINARY:-$HOME/.svm/0.8.28/solc-0.8.28}
test -x "$solc_binary" || { echo 'Set SOLC_BINARY to the pinned solc 0.8.28 executable' >&2; exit 1; }
mkdir -p "$scratch/bin"
ln -s "$solc_binary" "$scratch/bin/solc"
export PATH="$scratch/bin:$PATH"
solc --version >&2
cp -R src "$scratch/src-original"
forge build > "$OUT/forge-build.txt" 2>&1
forge test --summary > "$OUT/baseline-forge-test.txt" 2>&1 || {
    tail -50 "$OUT/baseline-forge-test.txt" >&2
    exit 1
}
start=$(date +%s)
result=0
# Forge replays a persisted invariant counterexample before a campaign. Replayed on the next mutant, a short sequence
# fails the per-run afterInvariant guards ("no request judged"), so that mutant would count as caught: each run starts
# without the counterexamples of the runs before it.
slither-mutate "$target" --test-cmd 'rm -rf cache/invariant cache/fuzz && forge test' \
    --solc-remaps '@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/ forge-std/=lib/forge-std/src/' \
    --timeout 600 --comprehensive -v --output-dir "$OUT/campaign" "$@" > "$OUT/slither-mutate.log" 2>&1 || result=$?
end=$(date +%s)
{
    echo "label=$label target=$target exit=$result elapsed_seconds=$((end - start))"
    echo "caught=$(grep -c -- '--> CAUGHT' "$OUT/slither-mutate.log" || true)"
    echo "uncaught=$(grep -c -- '--> UNCAUGHT' "$OUT/slither-mutate.log" || true)"
    echo "compile_failures=$(grep -c -- '--> COMPILATION FAILURE' "$OUT/slither-mutate.log" || true)"
    if diff -r "$scratch/src-original" src >/dev/null; then echo 'sources_restored=yes'; else echo 'sources_restored=NO'; fi
} > "$OUT/summary.txt"
cat "$OUT/summary.txt"
exit "$result"
