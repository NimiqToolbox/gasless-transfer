# Supply chain

Every external input of the build is pinned by content: an image digest, a file hash or a Git commit. The one exception is the Debian packages that the development and analysis images install (below). A pinned input never changes on its own. It also never receives security patches on its own. OS packages and Node in the base images stay as they were when the digest was taken until a pin is bumped deliberately (see [Refreshing pins](#refreshing-pins)).

## Inputs and pins

| Input | Pinned in | Pinned by | Checked |
| --- | --- | --- | --- |
| Build image `node:24.22.2-bookworm` (python3, make, g++, CA certificates for node-gyp) | `docker/relay.Dockerfile` (stage `build`) | Index digest `sha256:e7add2a4…` | Docker. The runtime stage fails the build unless both stages run the same `process.version` (the native addon is compiled against the build stage's Node headers). |
| Runtime and toolchain image `node:24.22.2-bookworm-slim` | Same file (stage `runtime`), `docker/dev.Dockerfile` | Index digest `sha256:c86ecead…` | Docker |
| `ghcr.io/foundry-rs/foundry:v1.8.3` | `docker/dev.Dockerfile` | Index digest `sha256:2e428727…` | Docker |
| `prom/prometheus:v3.14.0` | `docker/alerts.Dockerfile` | Index digest `sha256:5ce7540c…` | Docker |
| pnpm 10.34.5 | `PNPM_VERSION`/`PNPM_SHA512` in the dev and relay Dockerfiles; `packageManager` in `package.json` | sha512 of the registry tarball | `sha512sum -c` before installation |
| npm dependencies of `sdk/` and `relay/` | `pnpm-lock.yaml` | sha512 integrity of every tarball | `pnpm install --frozen-lockfile --ignore-scripts`. Only better-sqlite3 and esbuild may run install scripts. |
| better-sqlite3 native addon | Its locked source tarball | Compiled from source, offline, in the image build | GC stress test and `make relay-image-check` |
| solc 0.8.28 | `docker/dev.Dockerfile` | sha256 per architecture: the official Solidity build on x86_64 (`9a0fb7e0…`); on aarch64 the build forge's solc manager uses, from `nikitastupin/solc` at a fixed commit (`891ecdd8…`) | Before solc first runs and again after the offline warm-up build |
| OpenZeppelin Contracts v5.6.1, forge-std v1.16.2 | `docker/dev.Dockerfile` | Tag and verified commit | `git rev-parse HEAD` against the pinned commit |
| Slither 0.11.6, crytic-compile 0.4.2 and 45 transitive packages | `docker/analysis/slither/requirements.txt` (from `requirements.in`) | Version and sha256 of every distribution | `pip install --require-hashes --only-binary=:all:` (wheels only; nothing is built from source) |
| solhint 6.2.4 and 95 transitive packages | `docker/analysis/solhint/package-lock.json` | sha512 integrity | `npm ci --ignore-scripts` |
| Aderyn 0.6.8 | `docker/analysis.Dockerfile` | sha256 per architecture | `sha256sum -c` |

Debian packages are not pinned by content. The production images install none: the build stage uses what the pinned full node image contains, and the runtime image is the pinned slim image with tools removed. The development and analysis images install git, jq, python3, make, g++, python3-venv, python3-pip, curl and xz-utils with `apt-get` from the current Debian mirrors. apt verifies the Debian archive signatures, and a rebuild picks up current Debian security fixes.

Image builds need network access to Docker Hub, ghcr.io, registry.npmjs.org, pypi.org, deb.debian.org, github.com (library clones, Aderyn), binaries.soliditylang.org and raw.githubusercontent.com (solc).

## Resolution policy

[pnpm-workspace.yaml](../pnpm-workspace.yaml) constrains every resolution that writes `pnpm-lock.yaml`: `pnpm add`, `pnpm update` and `make lock`. Installs with `--frozen-lockfile` resolve nothing.

| Setting | Effect |
| --- | --- |
| `minimumReleaseAge: 10080` | Only versions published at least 7 days ago are resolved. This gives the registry and the community time to detect and remove a malicious release before it can be locked. |
| `trustPolicy: no-downgrade` | A version is refused when an earlier version of the same package had stronger publish evidence (a trusted publisher or a provenance attestation) and this one has less. Such a downgrade is a sign of an account takeover. |
| `blockExoticSubdeps: true` | Transitive dependencies must come from the registry, not from Git repositories or tarball URLs. |
| `strictDepBuilds: true` | A dependency with install scripts that `onlyBuiltDependencies` does not list fails the install instead of printing a warning. |
| `trustPolicyExclude` | Reviewed exceptions, exact versions only. Two dev-only versions are listed: `chokidar@4.0.3` and `undici-types@6.19.8`. Their maintainers published them in 2024 without provenance, after earlier releases had it. Without these entries, resolving the current manifests from scratch fails. |
| `minimumReleaseAgeExclude` | Empty. See [Urgent security fixes](#urgent-security-fixes). |
| `overrides` | Security fixes for transitive dependencies whose parent pins a vulnerable version. One dev-only entry: ethers 5.8.0, the SDK's `ethers5` test dependency, pins `ws` 8.18.0; it is raised to 8.21.0, the version viem already locks. Changing `overrides` makes pnpm resolve every version again, so the lockfile update also applies the age check to versions that are already locked. |

The production build's `pnpm deploy` resolves the SDK's dependencies again. The trust and subdependency checks still apply there. The age check is switched off for that step (`--config.minimum-release-age=0`): it applied when the lockfile was written, and the deploy must keep the lockfile's versions. `relay/test/image/lockedClosure.mjs` enforces that. After the deploy, it compares the name and version of every package in the production closure with `pnpm-lock.yaml`, and fails the image build if any package isn't a locked version. So a release published after the lockfile was written can never enter the relay image through this step, even within a dependency's semver range.

The analysis tools follow the same 7-day rule. `docker/analysis/solhint/.npmrc` sets `min-release-age=7`, and `requirements.txt` was compiled with `--uploaded-prior-to=P7D`.

### Urgent security fixes

A fix released less than 7 days ago is refused until you let it through:

1. Add the exact version to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, for example `- viem@2.56.10`.
2. Update the lockfile (`make lock`), then build and test.
3. Remove the entry once the version is 7 days old.

For solhint, add `min-release-age-exclude[]=<package>` to `docker/analysis/solhint/.npmrc`. For the Python lock, regenerate it with a later `--uploaded-prior-to` value.

pnpm may refuse a version with `ERR_PNPM_TRUST_DOWNGRADE`. Treat that as a possible compromise. Add the version to `trustPolicyExclude` only after you have confirmed with the maintainers or in the release history that the release is genuine.

## Refreshing pins

The pinned base images receive OS and Node security patches only when you refresh their digests. When a Debian or Node security advisory affects the images, refresh them at once.

Some pins need a review, not only a bump. OpenZeppelin Contracts and forge-std are pinned by commit in `docker/dev.Dockerfile`: the deployed GaslessTransfer contract is immutable, and a library bump changes the compiled contract. A Node major version changes the native addon ABI. An update tool that opens version PRs must leave these to a reviewed upgrade; it runs pnpm under the resolution policy above, so a fix released less than 7 days ago fails its lockfile update until the version is listed in `minimumReleaseAgeExclude`.

Base images, by hand:

1. Run `docker buildx imagetools inspect node:<version>-bookworm` and `docker buildx imagetools inspect node:<version>-bookworm-slim` for the same Node version. Copy each top-level `Digest:` value, the multi-architecture index digest.
2. Update the FROM lines of both stages in `docker/relay.Dockerfile`, and the toolchain stage in `docker/dev.Dockerfile`. For a new Node version, also update `scripts/native-build.sh` and the Node version in the documentation.
3. Run `make test-contained` and `make relay-image-check`. A Node major version also changes the native addon ABI: review the header workaround in the Dockerfiles first.

The same applies to the Foundry and Prometheus images.

Other pins:

- **npm dependencies:** `make lock` regenerates `pnpm-lock.yaml` under the resolution policy; then run the default checks.
- **pnpm:** update `packageManager`, and `PNPM_VERSION` and `PNPM_SHA512` in `docker/dev.Dockerfile` and `docker/relay.Dockerfile`, plus `scripts/native-build.sh`. The hash is the registry's `dist.integrity` in hex. Inside a container: `npm view pnpm@<version> dist.integrity`, then `node -p "Buffer.from('<base64 after sha512->', 'base64').toString('hex')"`.
- **solc:** like the libraries, a compiler change alters the compiled contract and needs review. Update `SOLC_VERSION`, `SOLC_COMMIT` and both hashes in `docker/dev.Dockerfile`, and the version in `contracts/foundry.toml`, `sdk/test/fixtures/solidity/foundry.toml` and `scripts/verification/mutate.sh`. The x86_64 hash is the `sha256` of the build in `https://binaries.soliditylang.org/linux-amd64/list.json`. On aarch64, use the source and hash that the pinned Foundry's solc manager uses: `SOLC_AARCH64_SOURCE_COMMIT`, and `linux/aarch64/list.json` in that repository.
- **Aderyn:** the sha256 of both release archives.
- **Slither and crytic-compile:** edit `docker/analysis/slither/requirements.in`, then regenerate `requirements.txt` in the analysis image:

  ```sh
  docker run --rm -i --read-only --user 1000:1000 --network bridge --cap-drop ALL \
    --security-opt no-new-privileges:true --tmpfs /tmp:rw,exec,nosuid,nodev,size=3g,mode=1777 \
    -e HOME=/tmp gasless/analysis:1 \
    'python3 -m venv /tmp/v && /tmp/v/bin/python -m pip install -q --upgrade pip pip-tools && cd /tmp && cat > requirements.in \
     && /tmp/v/bin/python -m piptools compile -q --allow-unsafe --generate-hashes --strip-extras \
        --pip-args "--uploaded-prior-to=P7D" --output-file=requirements.txt requirements.in >&2 \
     && cat requirements.txt' \
    < docker/analysis/slither/requirements.in > docker/analysis/slither/requirements.txt.new
  ```

  Review the diff, then replace `requirements.txt` with it.
- **solhint:** edit `docker/analysis/solhint/package.json`, then regenerate the lockfile with the settings of that directory's `.npmrc`:

  ```sh
  docker run --rm -i --read-only --user 1000:1000 --network bridge --cap-drop ALL \
    --security-opt no-new-privileges:true --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 -e HOME=/tmp \
    node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c \
    sh -c 'mkdir /tmp/s && cd /tmp/s && cat > package.json \
      && npm install --package-lock-only --ignore-scripts --min-release-age=7 --no-audit --no-fund >&2 \
      && cat package-lock.json' \
    < docker/analysis/solhint/package.json > docker/analysis/solhint/package-lock.json.new
  ```

  Review the diff, then replace `package-lock.json` with it.
