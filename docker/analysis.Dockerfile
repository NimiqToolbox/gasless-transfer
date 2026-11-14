# Static analysis and mutation testing on top of the pinned toolchain (same forge and solc):
# Slither + slither-mutate, Aderyn, solhint.
#
#   docker build -f docker/analysis.Dockerfile -t gasless/analysis:1 .
#
# Requires gasless/toolchain:1 (docker/dev.Dockerfile, target toolchain).
#
# Supply chain (docs/supply-chain.md): Slither, crytic-compile and every transitive Python dependency are
# pinned by version and sha256 in docker/analysis/slither/requirements.txt (wheels only, no source build);
# solhint and its dependencies by sha512 in docker/analysis/solhint/package-lock.json; Aderyn by sha256.

ARG TOOLCHAIN_IMAGE=gasless/toolchain:1
FROM ${TOOLCHAIN_IMAGE}
ARG ADERYN_VERSION=0.6.8
ARG ADERYN_SHA256_AARCH64=961070bf5ee4ed0f82f67a261c616e1525ec1b036bae60cdaec94d087eb5e405
ARG ADERYN_SHA256_X86_64=ffd6ca658962e211a3ac821c646f69c8e14bf1b1001cbfe091bcd4535a691e46

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv python3-pip curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
COPY docker/analysis/slither/requirements.txt /opt/slither-requirements.txt
RUN python3 -m venv /opt/slither \
 && /opt/slither/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --only-binary=:all: \
        -r /opt/slither-requirements.txt \
 && /opt/slither/bin/pip check
RUN arch="$(uname -m)" \
 && case "${arch}" in aarch64) sha="${ADERYN_SHA256_AARCH64}" ;; x86_64) sha="${ADERYN_SHA256_X86_64}" ;; *) exit 1 ;; esac \
 && curl -sSfL -o /tmp/aderyn.tar.xz "https://github.com/Cyfrin/aderyn/releases/download/aderyn-v${ADERYN_VERSION}/aderyn-${arch}-unknown-linux-gnu.tar.xz" \
 && echo "${sha}  /tmp/aderyn.tar.xz" | sha256sum -c - \
 && mkdir /tmp/aderyn && tar -xJf /tmp/aderyn.tar.xz -C /tmp/aderyn \
 && install -m 0755 "$(find /tmp/aderyn -type f -name aderyn | head -1)" /usr/local/bin/aderyn \
 && rm -rf /tmp/aderyn /tmp/aderyn.tar.xz
# npm ci installs exactly the lockfile's tarballs (sha512-checked) and fails if package.json and the lockfile disagree.
COPY docker/analysis/solhint/package.json docker/analysis/solhint/package-lock.json docker/analysis/solhint/.npmrc /opt/solhint/
RUN cd /opt/solhint \
 && npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && ln -s /opt/solhint/node_modules/.bin/solhint /usr/local/bin/solhint \
 && test "$(solhint --version)" = "$(node -p "require('/opt/solhint/package.json').dependencies.solhint")"
ENV PATH=/opt/slither/bin:${PATH}
USER node
CMD ["slither --version && aderyn --version && solhint --version"]
