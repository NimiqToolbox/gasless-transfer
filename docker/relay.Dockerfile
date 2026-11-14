# Production image of the relay (relay/README.md): Node 24.22.2 on Debian bookworm, the SDK built in,
# production dependencies only, non-root, and no package manager, compiler or TypeScript in the final stage.
#
#   docker build -f docker/relay.Dockerfile -t gasless/relay:local .
#
# Configuration comes from RELAY_* variables (relay/README.md). The key is read from
# /run/secrets/relay_key (a Docker secret) and the SQLite database lives in /data (mount a volume).
#
# Supply chain (docs/supply-chain.md): both base images are pinned by digest, and the build installs no
# Debian packages. Every dependency is an npm tarball whose sha512 pnpm-lock.yaml pins. The only native
# code, better-sqlite3, is compiled here from the sources in its tarball: the install scripts run without
# any network access, so better-sqlite3's `prebuild-install || node-gyp rebuild --release` cannot download
# a prebuilt binary, and the build fails unless the compile ran.

# --- Build: compile the SDK and the relay, then extract the relay's production closure ----------
# The full node image (buildpack-deps) already has python3, make, g++ and CA certificates for node-gyp, so no
# apt-get runs. It must carry exactly the runtime stage's Node release: the runtime stage checks this.
FROM node:24.22.2-bookworm@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413 AS build
ARG PNPM_VERSION=10.34.5
# The registry's dist.integrity of pnpm-${PNPM_VERSION}.tgz, in hex; change it together with the version.
ARG PNPM_SHA512=a4ee05f2f73658255bd6a89859c065a45c28a57daefae2c893a168ee2b73168c37b91e83e57ea67654ad03f03031746430e8bce38e362e042605fb8abc80192e
# pnpm is installed from its tarball once the pinned sha512 matched, not from whatever the registry serves
# for the version.
RUN command -v python3 && command -v make && command -v g++ && test -s /etc/ssl/certs/ca-certificates.crt \
 && node -p process.version > /node-version \
 && npm pack --silent --ignore-scripts --pack-destination /tmp "pnpm@${PNPM_VERSION}" \
 && echo "${PNPM_SHA512}  /tmp/pnpm-${PNPM_VERSION}.tgz" | sha512sum -c - \
 && npm install -g --ignore-scripts "/tmp/pnpm-${PNPM_VERSION}.tgz" \
 && rm "/tmp/pnpm-${PNPM_VERSION}.tgz" \
 && npm cache clean --force
# Build against a private copy of matching Node headers. In this Node version, ObjectWrap cleanup hooks
# can fail when SQLite statements are collected outside a JavaScript context. Remove the two inline
# calls from the copy; installed headers remain unchanged. sqliteGcStress.cjs checks the resulting addon.
RUN mkdir -p /opt/node-headers/include \
 && cp -a /usr/local/include/node /opt/node-headers/include/node \
 && sed -i -e '/^    AddCleanupHook();$/d' -e '/^    RemoveCleanupHook();$/d' /opt/node-headers/include/node/node_object_wrap.h \
 && ! grep -qE '^ +(Add|Remove)CleanupHook\(\);' /opt/node-headers/include/node/node_object_wrap.h
# npm_config_build_from_source: prebuild-install does not even try a download.
ENV CI=1 \
    npm_config_build_from_source=true \
    npm_config_nodedir=/opt/node-headers
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY sdk/package.json sdk/
COPY relay/package.json relay/
# Network only to download the tarballs the lockfile pins (sha512-checked by pnpm); no script runs ...
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@nimiq/gasless-relay..."
# ... and none while the skipped install scripts run (better-sqlite3's compile, esbuild's check). The
# compile leaves node-gyp's config.gypi and object files.
RUN --network=none pnpm --recursive rebuild --pending \
 && B="$(echo node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3)" \
 && grep -q '"build_from_source": "true"' "$B/build/config.gypi" \
 && test -f "$B/build/Release/obj.target/better_sqlite3/src/better_sqlite3.o" \
 && sha256sum "$B/build/Release/better_sqlite3.node"
# Sources only, listed explicitly: nothing from a host node_modules or dist can reach the image.
COPY relay/test/image/sqliteGcStress.cjs relay/test/image/closureOrphans.mjs relay/test/image/lockedClosure.mjs /build/
COPY sdk/README.md sdk/tsconfig.json sdk/tsup.config.ts sdk/
COPY sdk/src sdk/src
COPY relay/tsconfig.build.json relay/
COPY relay/src relay/src
COPY relay/config relay/config
RUN --network=none pnpm --filter @nimiq/gasless-sdk build \
 && pnpm --filter @nimiq/gasless-relay build
# The deploy resolves the injected SDK's dependencies against registry metadata. The release-age policy of
# pnpm-workspace.yaml applied when the lockfile was written; it is off here so that the deploy keeps the
# lockfile's versions instead of re-selecting them by age (trustPolicy and blockExoticSubdeps still apply).
# lockedClosure.mjs then fails the build if any package in the closure is not exactly a locked version. The deploy must not bring its own better-sqlite3
# binary: the runtime closure holds exactly the binary compiled offline above (cmp), whatever the deploy did.
RUN pnpm --filter @nimiq/gasless-relay deploy --config.minimum-release-age=0 --legacy --prod /out \
 && rm -f /out/README.md \
 && cmp node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
        /out/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
 # Of node-gyp's output only the addon and config.gypi (the record of the source build) are kept.
 && BUILD="$(echo /out/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build)" \
 && find "$BUILD" -mindepth 1 -maxdepth 1 ! -name Release ! -name config.gypi -exec rm -rf {} + \
 && find "$BUILD/Release" -mindepth 1 -maxdepth 1 ! -name better_sqlite3.node -exec rm -rf {} + \
 # prebuild-install (better-sqlite3's binary downloader) only runs at install time: not in the runtime image.
 && rm -rf /out/node_modules/.pnpm/prebuild-install@* \
 && find /out/node_modules/.pnpm -path '*/node_modules/prebuild-install' -type l -delete \
 # viem's optional TypeScript peer is only used for types: no compiler in the runtime image.
 && rm -rf /out/node_modules/.pnpm/typescript@* \
 && find /out/node_modules/.pnpm -path '*/node_modules/typescript' -type l -delete \
 # Remove packages needed only by the build tools (prebuild-install's HTTP client, tarball extractor, config reader,
 # ...) goes too: every package that the walk from /out/package.json cannot reach, and the links to it.
 && node /build/closureOrphans.mjs /out --prune \
 && node /build/closureOrphans.mjs /out \
 # Nothing the deploy resolved may differ from pnpm-lock.yaml.
 && node /build/lockedClosure.mjs /out /build/pnpm-lock.yaml \
 # Every module of the relay still loads, SQLite works, and garbage collection of statements does not abort.
 && cd /out && node -e "require('better-sqlite3')(':memory:').close()" \
 && node --input-type=module -e "await import('/out/dist/index.js')" \
 && node /build/sqliteGcStress.cjs

# --- Runtime -------------------------------------------------------------------------------------
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runtime
# better_sqlite3.node was compiled against the build stage's Node headers, so both base images must carry the
# same Node release (bump the two FROM lines together); the build fails otherwise.
COPY --from=build /node-version /tmp/build-node-version
# The base image ships npm, npx, corepack and yarn, which the relay does not
# need; no binary keeps a setuid/setgid bit; the apt and dpkg front ends are removed (their database in
# /var/lib/dpkg stays for image scanners); the node user can write only /data and /tmp (its home,
# /run/lock and /var/tmp belong to root; SQLite then puts its temporary files in /tmp). A shell stays
# for `docker exec` diagnostics. Run the container with a read-only root filesystem, a tmpfs /tmp, no
# capabilities and no-new-privileges (compose.yaml);
# relay/test/image/checkImage.mjs (make relay-image-check) checks the image.
RUN node -e "const b = require('node:fs').readFileSync('/tmp/build-node-version', 'utf8').trim(); if (b !== process.version) throw new Error('Node mismatch: build stage ' + b + ', runtime stage ' + process.version)" \
 && rm /tmp/build-node-version \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && rm -f /usr/bin/apt /usr/bin/apt-* /usr/bin/dpkg /usr/bin/dpkg-* /usr/sbin/dpkg-* \
 && chown -R root:root /home/node && chmod 0755 /home/node /run/lock /var/tmp \
 && install -d -o node -g node -m 0700 /data
# Owned by root: the relay process cannot modify its own code or configuration.
COPY --from=build /out /app
COPY --chown=0:0 relay/scripts/backup-state.mjs /app/scripts/backup-state.mjs
RUN --network=none chmod -R u=rwX,go=rX /app
WORKDIR /app
# The internal listener (/metrics, the readiness report) stays on 127.0.0.1:9464 unless RELAY_OPS_HOST
# says otherwise, and is deliberately not EXPOSEd (`docker run -P` would publish it).
ENV NODE_ENV=production \
    RELAY_PRIVATE_KEY_FILE=/run/secrets/relay_key \
    RELAY_DB_PATH=/data/relay.sqlite \
    RELAY_GAS_TABLE_FILE=/app/config/gasTable.json \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8080
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
