# Dependencies

Project code uses the [MIT License](../LICENSE). Dependencies retain their own licenses and notices.

## Solidity libraries

The build pins Solidity libraries to the commits below. Native builds place them in `contracts/lib`.

| Library | Pinned source | License |
| --- | --- | --- |
| OpenZeppelin Contracts | v5.6.1, `5fd1781b1454fd1ef8e722282f86f9293cacf256` | MIT; copyright remains with the upstream copyright holders |
| forge-std | v1.16.2, `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b` | MIT or Apache-2.0; both upstream license files are retained |

The pins and verification commands are in [docker/dev.Dockerfile](../docker/dev.Dockerfile). `make deps` exports the pinned libraries to a fresh `build/deps/run-*` directory without importing their Git histories. Inspect that export and copy it to `contracts/lib` only when the destination is absent. Retain upstream license files if redistributing those libraries.

### Fully native Linux acquisition

For a native build, run the following from the repository root with Bash, Git and GNU coreutils. The destination `contracts/lib` must not already exist.

```bash
(
  set -euo pipefail
  repo_root=$(pwd -P)
  test -f "$repo_root/contracts/foundry.toml"
  if [[ -e "$repo_root/contracts/lib" || -L "$repo_root/contracts/lib" ]]; then
    echo "contracts/lib already exists; inspect it before installing dependencies" >&2
    exit 1
  fi

  deps_tmp=$(mktemp -d "$repo_root/contracts/.deps.XXXXXXXX")
  # Cleanup is confined to the exact freshly created directory, never a parent.
  [[ "$deps_tmp" == "$repo_root/contracts/.deps."* ]]
  [[ "$deps_tmp" =~ \.deps\.[[:alnum:]]{8}$ ]]
  [[ -d "$deps_tmp" && ! -L "$deps_tmp" ]]
  cleanup() {
    if [[ -d "$deps_tmp" && ! -L "$deps_tmp" ]]; then
      rm -rf -- "$deps_tmp"
    fi
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  mkdir "$deps_tmp/lib"

  git clone --quiet --depth 1 --branch v5.6.1 \
    https://github.com/OpenZeppelin/openzeppelin-contracts.git \
    "$deps_tmp/lib/openzeppelin-contracts"
  test "$(git -C "$deps_tmp/lib/openzeppelin-contracts" rev-parse HEAD)" = \
    5fd1781b1454fd1ef8e722282f86f9293cacf256
  git clone --quiet --depth 1 --branch v1.16.2 \
    https://github.com/foundry-rs/forge-std.git \
    "$deps_tmp/lib/forge-std"
  test "$(git -C "$deps_tmp/lib/forge-std" rev-parse HEAD)" = \
    bf647bd6046f2f7da30d0c2bf435e5c76a780c1b

  test -f "$deps_tmp/lib/openzeppelin-contracts/LICENSE"
  test -f "$deps_tmp/lib/forge-std/LICENSE-MIT"
  test -f "$deps_tmp/lib/forge-std/LICENSE-APACHE"
  for library in openzeppelin-contracts forge-std; do
    [[ -d "$deps_tmp/lib/$library/.git" && ! -L "$deps_tmp/lib/$library/.git" ]]
    rm -rf -- "$deps_tmp/lib/$library/.git"
  done
  printf '%s\n' \
    'openzeppelin-contracts v5.6.1 5fd1781b1454fd1ef8e722282f86f9293cacf256' \
    'forge-std v1.16.2 bf647bd6046f2f7da30d0c2bf435e5c76a780c1b' \
    > "$deps_tmp/lib/VERSIONS"

  # GNU mv: never merge into or overwrite a destination created in the meantime.
  mv -T -n -- "$deps_tmp/lib" "$repo_root/contracts/lib"
  test ! -e "$deps_tmp/lib"
)
```

The command verifies both commits, retains their license files and installs the libraries without Git metadata.

## JavaScript and native dependencies

[pnpm-lock.yaml](../pnpm-lock.yaml) fixes the dependency graph and package integrity values. The manifests in [sdk](../sdk/package.json) and [relay](../relay/package.json) define direct dependencies. The runtime includes independently licensed packages such as viem, Fastify, Pino and better-sqlite3; consult each installed package's license and notices when redistributing the runtime.

The build uses Node 24.22.2 and pnpm 10.34.5. Solidity compilation uses solc 0.8.28 with Foundry 1.8.3 and the optimizer/EVM settings in [foundry.toml](../contracts/foundry.toml). Image digests are pinned in the Dockerfiles; changing a tag, compiler or lockfile requires fresh validation. [Supply chain](supply-chain.md) lists every pinned input and how to update it.

The SQLite addon is compiled from source using the pinned Node toolchain. Use the Docker build or [native build helper](../scripts/native-build.sh) to apply the required build configuration. When upgrading Node or better-sqlite3, rerun the native build and `make relay-image-check`.
