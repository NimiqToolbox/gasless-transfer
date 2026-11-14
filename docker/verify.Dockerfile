# Build JS before the read-only verification run: tsup bundles its config next to the source.
ARG WORKSPACE_IMAGE=gasless/workspace:local
FROM ${WORKSPACE_IMAGE}
# COPY overlays directories and does not remove deleted files. Retain only installed dependencies
# and the vendored-library links, so a removed helper/source cannot silently survive in a test image.
RUN --network=none find /work -mindepth 1 -maxdepth 1 \
        ! -name node_modules ! -name sdk ! -name relay ! -name contracts ! -name lib -exec rm -rf {} + \
 && find /work/sdk /work/relay -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + \
 && find /work/contracts -mindepth 1 -maxdepth 1 ! -name lib -exec rm -rf {} +
# Refresh source without reinstalling the unchanged, frozen-lockfile dependencies of the workspace image.
COPY --chown=node:node . /work
RUN --network=none mkdir -p contracts/deployments contracts/broadcast \
 && chmod 0700 contracts/deployments contracts/broadcast \
 && pnpm build
