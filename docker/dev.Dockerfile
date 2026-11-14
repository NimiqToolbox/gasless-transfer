# Dev/test toolchain for the whole repo: Foundry (pinned), solc 0.8.28 (pre-cached, sha256-pinned), vendored
# OpenZeppelin + forge-std, Node 24 and pnpm. Images are pinned by digest, libraries by tag and commit,
# binaries by hash (docs/supply-chain.md). The FROM lines are literal so that update tools can bump them.
#
#   docker build -f docker/dev.Dockerfile --target toolchain -t gasless/toolchain:1 .
#   docker build -f docker/dev.Dockerfile --target workspace -t gasless/workspace:local .   (compose)

# --- Solidity dependencies, pinned by tag and verified by commit -----------------------------
FROM ghcr.io/foundry-rs/foundry:v1.8.3@sha256:2e4287278639262de76db72477301d5d3212fa1b1cce710d7d148750a46ce9e7 AS deps
ARG OZ_TAG=v5.6.1
ARG OZ_COMMIT=5fd1781b1454fd1ef8e722282f86f9293cacf256
ARG FORGE_STD_TAG=v1.16.2
ARG FORGE_STD_COMMIT=bf647bd6046f2f7da30d0c2bf435e5c76a780c1b
RUN git clone --quiet --depth 1 --branch "${OZ_TAG}" https://github.com/OpenZeppelin/openzeppelin-contracts.git /tmp/deps/openzeppelin-contracts \
 && test "$(git -C /tmp/deps/openzeppelin-contracts rev-parse HEAD)" = "${OZ_COMMIT}" \
 && git clone --quiet --depth 1 --branch "${FORGE_STD_TAG}" https://github.com/foundry-rs/forge-std.git /tmp/deps/forge-std \
 && test "$(git -C /tmp/deps/forge-std rev-parse HEAD)" = "${FORGE_STD_COMMIT}" \
 && rm -rf /tmp/deps/*/.git \
 && printf 'openzeppelin-contracts %s %s\nforge-std %s %s\n' "${OZ_TAG}" "${OZ_COMMIT}" "${FORGE_STD_TAG}" "${FORGE_STD_COMMIT}" > /tmp/deps/VERSIONS

FROM ghcr.io/foundry-rs/foundry:v1.8.3@sha256:2e4287278639262de76db72477301d5d3212fa1b1cce710d7d148750a46ce9e7 AS foundry

# --- Toolchain: Node 24 + pnpm + Foundry binaries + deps + cached solc -------------------------
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS toolchain
ARG PNPM_VERSION=10.34.5
# The registry's dist.integrity of pnpm-${PNPM_VERSION}.tgz, in hex; change it together with the version.
ARG PNPM_SHA512=a4ee05f2f73658255bd6a89859c065a45c28a57daefae2c893a168ee2b73168c37b91e83e57ea67654ad03f03031746430e8bce38e362e042605fb8abc80192e
# solc from the source forge's solc manager (svm) uses: the official Solidity build on x86_64, the community
# build at a fixed commit of github.com/nikitastupin/solc on aarch64. Its sha256 is checked before solc first
# runs and again after the offline warm-up build; change the hashes together with the version.
ARG SOLC_VERSION=0.8.28
ARG SOLC_COMMIT=7893614a
ARG SOLC_SHA256_X86_64=9a0fb7e0db2c0641dbae1c5cc645dc686820c83af516226abb1c0a2f76636f25
ARG SOLC_AARCH64_SOURCE_COMMIT=2287d4326237172acf91ce42fd7ec18a67b7f512
ARG SOLC_SHA256_AARCH64=891ecdd8f92a8211ee99f21bc3052b63fa098b4807f21ed8311d66e35d5aeb84
# python3/make/g++: node-gyp compiles better-sqlite3 (below); git/jq: used by tests and tooling. pnpm is installed
# from its tarball once the pinned sha512 matched.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git jq python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm pack --silent --ignore-scripts --pack-destination /tmp "pnpm@${PNPM_VERSION}" \
 && echo "${PNPM_SHA512}  /tmp/pnpm-${PNPM_VERSION}.tgz" | sha512sum -c - \
 && npm install -g --ignore-scripts "/tmp/pnpm-${PNPM_VERSION}.tgz" \
 && rm "/tmp/pnpm-${PNPM_VERSION}.tgz" \
 && npm cache clean --force
# Compile the SQLite addon against a private copy of the pinned Node headers.
# Keep the header configuration aligned with docker/relay.Dockerfile and the native build helper.
RUN mkdir -p /opt/node-headers/include \
 && cp -a /usr/local/include/node /opt/node-headers/include/node \
 && sed -i -e '/^    AddCleanupHook();$/d' -e '/^    RemoveCleanupHook();$/d' /opt/node-headers/include/node/node_object_wrap.h \
 && ! grep -qE '^ +(Add|Remove)CleanupHook\(\);' /opt/node-headers/include/node/node_object_wrap.h
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/anvil /usr/local/bin/cast /usr/local/bin/chisel /usr/local/bin/
COPY --from=deps --chown=node:node /tmp/deps /deps
USER node
ENV FOUNDRY_DISABLE_NIGHTLY_WARNING=1 \
    PNPM_STORE_DIR=/home/node/.local/share/pnpm/store \
    CI=1 \
    npm_config_build_from_source=true \
    npm_config_nodedir=/opt/node-headers
# Pre-fetch solc into svm's cache so builds need no network; the warm-up build proves that forge uses it offline.
RUN case "$(uname -m)" in \
      x86_64) url="https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-v${SOLC_VERSION}+commit.${SOLC_COMMIT}" sha="${SOLC_SHA256_X86_64}" ;; \
      aarch64) url="https://raw.githubusercontent.com/nikitastupin/solc/${SOLC_AARCH64_SOURCE_COMMIT}/linux/aarch64/solc-v${SOLC_VERSION}" sha="${SOLC_SHA256_AARCH64}" ;; \
      *) echo "no pinned solc for $(uname -m)" >&2; exit 1 ;; \
    esac \
 && solc="/home/node/.svm/${SOLC_VERSION}/solc-${SOLC_VERSION}" \
 && node -e "fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error(r.status + ' ' + r.url); require('node:fs').writeFileSync(process.argv[2], Buffer.from(await r.arrayBuffer())); })" "${url}" /tmp/solc \
 && echo "${sha}  /tmp/solc" | sha256sum -c - \
 && mkdir -p "/home/node/.svm/${SOLC_VERSION}" \
 && install -m 0755 /tmp/solc "${solc}" && rm /tmp/solc \
 && mkdir -p /tmp/warm/src \
 && printf 'pragma solidity %s;\ncontract Warm {}\n' "${SOLC_VERSION}" > /tmp/warm/src/Warm.sol \
 && cd /tmp/warm && forge build --offline --use "${SOLC_VERSION}" --evm-version cancun --root /tmp/warm >/dev/null \
 && cd / && rm -rf /tmp/warm \
 && echo "${sha}  ${solc}" | sha256sum -c - \
 && "${solc}" --version | grep -qF "Version: ${SOLC_VERSION}+commit.${SOLC_COMMIT}" \
 && mkdir -p /home/node/.foundry/cache/rpc /home/node/.local/share/pnpm/store
# Remappings use contracts/lib/…; the vendored deps stand in for it inside containers.
USER root
RUN mkdir -p /work/contracts && ln -s /deps /work/contracts/lib && ln -s /deps /work/lib && chown -R node:node /work \
 && install -d -o node -g node -m 0700 /stack /stack-secrets /relay-data
USER node
WORKDIR /work
ENTRYPOINT ["/bin/bash", "-eo", "pipefail", "-c"]
CMD ["forge --version && node --version && pnpm --version && cat /deps/VERSIONS"]

# --- Workspace: the repo copied in, JS deps installed (used by compose.yaml) -----------------
FROM toolchain AS workspace
COPY --chown=node:node . /work
# The install compiles better-sqlite3 (see the toolchain stage); config.gypi records the source build, and
# the relay image's GC stress test must pass.
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN --network=none pnpm --recursive rebuild --pending \
 && grep -q '"build_from_source": "true"' "$(echo node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3)/build/config.gypi" \
 && (cd relay && node test/image/sqliteGcStress.cjs) \
 && pnpm build
