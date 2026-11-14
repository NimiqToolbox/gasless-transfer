# Workloads run in Docker; host recipes only orchestrate Docker. See docs/DEVELOPMENT.md.
.NOTPARALLEL:
.DEFAULT_GOAL := test-contained
.PHONY: toolchain analysis test test-contracts test-fork test-node abi lock deps stack-up stack-test stack-down

.PHONY: test-alerts
test-alerts:
	bash docker/test-alerts-contained.sh

toolchain:
	docker build -f docker/dev.Dockerfile --target toolchain -t gasless/toolchain:1 .

analysis: toolchain
	docker build -f docker/analysis.Dockerfile -t gasless/analysis:1 .

test: test-contracts test-node

test-contracts: verify-image
	bash docker/test-contained.sh 'cd contracts && forge fmt --check && forge test -vvv'

test-fork: verify-image
	@test -n "$${POLYGON_RPC_URL:?Set POLYGON_RPC_URL to an archive Polygon RPC}"
	GASLESS_TEST_NETWORK=bridge bash docker/test-contained.sh 'cd contracts && FOUNDRY_PROFILE=fork forge test -vvv'

# Opt-in Solidity verification cases (contracts/test/fork-verify: EIP-7702 delegated accounts on real USDC and USDT0).
.PHONY: test-verify
test-verify: verify-image
	@test -n "$${POLYGON_RPC_URL:?Set POLYGON_RPC_URL to an archive Polygon RPC}"
	GASLESS_TEST_NETWORK=bridge VER_FORK=true bash docker/test-contained.sh 'cd contracts && forge test --match-path "test/fork-verify/*" -vvv'

test-node: verify-image
	bash docker/test-contained.sh 'pnpm -r run typecheck && pnpm -r run test && pnpm --filter @nimiq/gasless-relay test:integration'

# Local fault tests and optional Polygon fork checks.
.PHONY: test-fault test-fault-fork
test-fault: verify-image
	bash docker/test-contained.sh 'cd relay && pnpm exec vitest run -c test/fault/vitest.config.ts'

test-fault-fork: verify-image
	@test -n "$${POLYGON_RPC_URL:?Set POLYGON_RPC_URL to an archive Polygon RPC}"
	GASLESS_TEST_NETWORK=bridge VER_FORK=true bash docker/test-contained.sh 'cd relay && pnpm exec vitest run -c test/fault/vitest.config.ts'

# Artifact workloads have immutable source/runtimes and task-owned scratch; only validated outputs are copied.
.PHONY: artifact-image analysis-workspace artifact-check
artifact-image: toolchain
	docker build --network=none -f docker/artifacts.Dockerfile -t gasless/artifacts:workspace .

analysis-workspace: analysis
	docker build --network=none -f docker/artifacts.Dockerfile --build-arg ARTIFACT_BASE=gasless/analysis:1 -t gasless/artifacts:analysis .

artifact-check: artifact-image
	GASLESS_TEST_IMAGE=gasless/artifacts:workspace bash docker/test-contained.sh 'node --test scripts/verification/validate-artifacts.test.mjs'

abi: artifact-image
	bash docker/artifact-contained.sh abi

# Static analysis of contracts/src: Slither (every detector, plus the printers
# human-summary, function-summary and vars-and-auth), Aderyn and solhint (recommended), in gasless/analysis:1
# (`make analysis` builds it). Current source is baked into a snapshot, with no source mounts. Reports are
# exported to a fresh build/static/run-* directory; existing reports are preserved.
.PHONY: static
static: analysis-workspace
	bash docker/artifact-contained.sh static

lock: artifact-image
	bash docker/artifact-contained.sh lock

deps: artifact-image
	bash docker/artifact-contained.sh deps

# Local stack (compose profile "stack"): anvil (chain 31337), DeployLocalStack, and the relay's production
# image (docker/relay.Dockerfile) with an anvil dev key, on the compose network only (no host ports).
# stack-up rebuilds the images and starts a fresh stack (new chain, deployment and relay database);
# stack-test runs against the running stack (it starts one if needed). STACK_IMAGE_TAG tags the
# images (default "local"). See relay/README.md.
stack-up:
	docker compose --profile stack up -d --build --force-recreate --wait relay

stack-test:
	docker compose --profile stack run --rm stack-test

# Remove this project's local stack. No global prune or unrelated-container cleanup.
stack-down:
	docker compose --profile stack down -v anvil deploy relay stack-test

# Relay runtime image (docker/relay.Dockerfile): build it, then check it from the inside with its own node
# (relay/test/image/checkImage.mjs): non-root, no setuid/setgid binaries, no package managers or compilers,
# nothing writable outside /data and /tmp, a source-built SQLite addon with GC stress checks, and no
# binary downloader in the closure. STACK_IMAGE_TAG tags the image (default "local", as for the stack).
.PHONY: relay-image-check
relay-image-check:
	docker build -f docker/relay.Dockerfile -t gasless/relay:$${STACK_IMAGE_TAG:-local} .
	bash docker/check-image-contained.sh gasless/relay:$${STACK_IMAGE_TAG:-local}

# Contract checks: coverage uses forge coverage --ir-minimum on contracts/src. Targets are at least
# 95 % of lines and 90 % of branches. invariant-final: the long invariant profile. mutation: slither-mutate over
# contracts/src in gasless/analysis:1, mutants killed by the full default suite. A generated scratch copy is
# mutated; baked source stays read-only. Fresh results go to build/mutation/run-* (target: at least 80 % caught).
.PHONY: coverage invariant-final mutation mutation-smoke
coverage: artifact-image
	bash docker/artifact-contained.sh coverage

invariant-final: verify-image
	bash docker/test-contained.sh 'cd contracts && FOUNDRY_PROFILE=invariant-final forge test --summary'

mutation: analysis-workspace
	bash docker/artifact-contained.sh mutation

mutation-smoke: analysis-workspace
	bash docker/artifact-contained.sh mutation-smoke

# Contained test runs: all workloads run non-root with read-only source/runtime, bounded resources,
# no capabilities and no host mounts. The shell runner only assembles Docker CLI arguments.
.PHONY: verify-image test-contained test-fork-contained
verify-image:
	docker build -f docker/dev.Dockerfile --target workspace -t gasless/workspace:local .
	docker build -f docker/verify.Dockerfile --build-arg WORKSPACE_IMAGE=gasless/workspace:local -t gasless/verify:local .

test-contained: verify-image
	bash docker/test-contained.sh 'pnpm -r run typecheck && pnpm -r run test && pnpm --filter @nimiq/gasless-relay test:integration && cd relay && pnpm exec vitest run -c test/fault/vitest.config.ts'
	bash docker/test-contained.sh 'cd relay && node --test scripts/backup-state.test.mjs scripts/collect-token-pins.test.mjs'
	bash docker/test-contained.sh 'cd contracts && forge fmt --check && forge test --summary'

# Archive RPC reads only. Transactions are confined to local anvil; nothing is deployed to Polygon.
test-fork-contained: verify-image
	@test -n "$${POLYGON_RPC_URL:?Set POLYGON_RPC_URL to an archive Polygon RPC}"
	GASLESS_TEST_NETWORK=bridge bash docker/test-contained.sh 'cd contracts && FOUNDRY_PROFILE=fork forge test --summary'
	GASLESS_TEST_NETWORK=bridge VER_FORK=true bash docker/test-contained.sh 'cd relay && pnpm exec vitest run -c test/fault/vitest.config.ts'

# Read-only deployment evidence and actual top-level transactions on a disposable local fork.
.PHONY: test-deployment-verifier verify-deployment test-gas-calibration
test-deployment-verifier: verify-image
	bash docker/test-contained.sh 'cd contracts && forge build --ast && cd ../relay && node --test scripts/verify-deployment.test.mjs'

verify-deployment: verify-image
	@test -n "$${GASLESS_TRANSFER_OWNER:?Set GASLESS_TRANSFER_OWNER to the expected initial owner}"
	@test -n "$${DEPLOY_BLOCK:?Set DEPLOY_BLOCK to deployBlock of the deployment record}"
	GASLESS_TEST_NETWORK=bridge bash docker/test-contained.sh 'cd contracts && forge build --ast >&2 && cd ../relay && node scripts/verify-deployment.mjs "$${DEPLOYMENT_ADDRESS:?}" "$${DEPLOYMENT_TX_HASH:?}"'

test-gas-calibration: verify-image
	@test -n "$${POLYGON_RPC_URL:?Set POLYGON_RPC_URL to an archive Polygon RPC}"
	@test -n "$${FORK_BLOCK:?Set FORK_BLOCK to a recorded finalized Polygon block}"
	GASLESS_TEST_NETWORK=bridge VER_FORK=true bash docker/test-contained.sh 'cd relay && pnpm exec vitest run -c test/fault/vitest.config.ts test/fault/gasCalibration.fault.ts'

