# Promtool only: reviewed rules and fixtures baked into an immutable, offline test image.
# --chmod: the test user must read them whatever the modes of the checkout (a umask of 077 gives 0600). 555, not
# 444: the mode also lands on the directories COPY creates.
FROM prom/prometheus:v3.14.0@sha256:5ce7540c3c00ef4ab0c9d2c995c6a5b9c421f44b4a115d97a2c7af3b1c21cbb0
WORKDIR /work
COPY --chmod=555 relay/config/alerts.yml relay/config/alerts.yml
COPY --chmod=555 relay/config/prometheus.yml.example relay/config/prometheus.yml.example
COPY --chmod=555 relay/test/ops/alerts.test.yml relay/test/ops/alerts.test.yml
USER 65534:65534
ENTRYPOINT ["/bin/sh", "-c"]
CMD ["promtool --version && promtool check config --syntax-only relay/config/prometheus.yml.example && promtool check rules relay/config/alerts.yml && promtool test rules relay/test/ops/alerts.test.yml"]
