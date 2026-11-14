# Container execution

The default test runner uses a source snapshot built into a Docker image. Rebuild it after source changes.

Test containers run with:

- no external network by default;
- a non-root user and read-only filesystem;
- dropped Linux capabilities and `no-new-privileges`;
- CPU, memory and process limits;
- bounded temporary storage for build output and caches.

The workload receives no Docker socket or writable source mount. Dependency builds and explicitly selected fork tests use network access. The local Compose stack communicates over an internal network and publishes no host ports.

## Relay runtime

The relay image runs as UID 1000. Launch it with read-only application files, resource limits and restricted writable paths. Mount the key and deployment record read-only, provide persistent storage at `/data`, and use temporary storage at `/tmp`.

Expose the public API through a TLS proxy and keep the operations listener private. The relay reads no forwarded headers and does not use client addresses, so it has no proxy-trust setting; per-client limits, if wanted, belong to the proxy.

## Native operation

The native build helper prepares the application; it does not configure OS isolation. Use an unprivileged service account, protected application and key files, dedicated database storage, and service-level resource and network limits.

See [deployment](deployment.md) for commands and configuration.
