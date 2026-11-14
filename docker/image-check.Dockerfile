ARG RELAY_IMAGE
FROM ${RELAY_IMAGE}
# Tests are baked into an immutable layer; no host source is mounted at runtime. The mode is set here so that the
# image's user can read them whatever mode the checkout has (a umask of 077 gives 0600).
COPY --chown=0:0 --chmod=555 checks/ /checks/
