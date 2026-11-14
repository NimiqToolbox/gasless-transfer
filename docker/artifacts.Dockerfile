# Artifact generation does not need a workspace dependency install. In particular a changed package.json must
# be able to regenerate its lockfile before --frozen-lockfile can build the verification workspace.
ARG ARTIFACT_BASE=gasless/toolchain:1
FROM ${ARTIFACT_BASE}
COPY --chown=node:node . /work
USER root
RUN install -d -o node -g node -m 0700 /export
USER node
WORKDIR /work
