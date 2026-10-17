# prisma-runtime layer

One shared Lambda **layer** (not a function) holding the Prisma 7 driver-adapter
runtime. It is mounted at `/opt/nodejs/node_modules` on every function that talks to
Postgres: `s-read-function`, `s-replay-function`, `monitoring-relay-function`,
`monitoring-watchdog-function`.

## Why a layer

Each function is bundled with esbuild (`scripts/bundle-function.mjs`) into a single
`dist/handler.mjs`. The bundle inlines all reachable source — `@checkin/*`, the
**generated** Prisma client, zod — but deliberately leaves the Prisma *runtime*
external:

```
@prisma/client  @prisma/adapter-pg  pg     ← resolved from THIS layer at runtime
@aws-sdk/*                                  ← resolved from the Lambda Node runtime
```

The runtime is identical for both schemas (`s-ingest-core` and `monitoring-db`), so it
lives once in this layer instead of being copied into all four function zips. The two
*generated clients* differ per schema and stay in their function bundles — that is why
this is **one** layer, not two.

## Runtime: nodejs22.x + CJS handler (not negotiable)

Lambda exposes a layer **only via `NODE_PATH`**, and Node's **ESM loader ignores
`NODE_PATH`** — so the function bundle is emitted as **CommonJS** (`dist/handler.js`,
handler ref `handler.handler`) whose `require()` *does* honour `NODE_PATH`. The
externalized WASM query compiler is shipped as `.mjs`, so that `require()` is a
require-of-ESM — unflagged only from **Node 22**. Deploy these functions on
**`nodejs22.x`**; `nodejs20.x` throws `ERR_REQUIRE_ESM` at cold start.

## Contents are pure JS + WASM

Prisma 7's driver-adapter mode is Rust-free: the query compiler ships as a portable
`.wasm`, there is **no native `libquery_engine` binary**. So:

- the same zip runs on **x86_64 and arm64** — no per-arch build, no Docker;
- we default the functions to **arm64** (cheaper) since nothing here is arch-bound.

## Version lock (do not skip)

A generated client is version-locked to its `@prisma/client` runtime. The pins in
[`nodejs/package.json`](./nodejs/package.json) **must exactly match** the `prisma`
version used by `prisma generate` in `packages/s-ingest-core` and
`packages/monitoring-db` (currently `7.8.0`). Bump all of them together.

## Build

```sh
npm run build:prisma-layer        # -> layers/prisma-runtime/prisma-runtime-layer.zip
```

Then publish the zip as a new `aws_lambda_layer_version` and point the functions at its
ARN — see [`infra/lambda-packaging.tf.example`](../../infra/lambda-packaging.tf.example).
