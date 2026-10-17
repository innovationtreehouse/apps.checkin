# CheckMeIn

A member check-in and program management system built with Next.js, Prisma, and PostgreSQL.

## Repository layout

An npm-workspaces monorepo. The web app lives in `checkin-app/`; the rest are satellites around it.

- **[`checkin-app/`](checkin-app/)** — the Next.js + Prisma web app: membership, programs, attendance, payments, ops.
- **[`client/`](client/README.md)** — Python kiosk client for Raspberry Pi devices at the facility entrance (a transparent Ed25519 signing proxy in front of the backend).
- **[`s-read-function/`](s-read-function/README.md)** — Lambda that pulls Shopify orders/payouts/balance transactions into a dedicated Postgres ([deploy notes](s-read-function/DEPLOY.md), [monitoring PRD](s-read-function/MONITORING-PRD.md)).
- **[`s-replay-function/`](s-replay-function/README.md)** — admin/replay operations for that ingestion pipeline (pure database consumer).
- **[`monitoring-watchdog-function/`](monitoring-watchdog-function/README.md)** / **[`monitoring-relay-function/`](monitoring-relay-function/README.md)** — the detection and delivery halves of fleet monitoring.
- **[`packages/`](packages/)** — shared workspaces: [`telemetry`](packages/telemetry/README.md) (emission core), [`monitoring-db`](packages/monitoring-db/README.md) (monitoring Postgres layer), [`pg-test-harness`](packages/pg-test-harness/README.md) (throwaway-Postgres integration testing).
- **[`layers/prisma-runtime/`](layers/prisma-runtime/README.md)** — shared Lambda layer with the Prisma 7 driver-adapter runtime.
- **[`deploy/`](deploy/)** — docker-compose stacks (local dev DB, self-hosted prod, flow tests) and Caddyfile.
- **[`docs/`](docs/)** — cross-cutting documentation: setup, designs, security (see the map below).

## Local Setup

Follow the guide for your operating system:

- **[macOS Setup Guide](docs/setup/SETUP_MACOS.md)** — Install and run on a MacBook (Intel or Apple Silicon)
- **[Linux Setup Guide](docs/setup/SETUP_LINUX.md)** — Install and run on Ubuntu/Debian, Fedora, or Arch

## Quick Start (if prerequisites are already installed)

```bash
npm install
docker compose -f deploy/docker-compose.yml up -d db
npm -w checkin-app exec -- prisma generate
npm -w checkin-app exec -- prisma db push
npm -w checkin-app exec -- prisma db seed
npm -w checkin-app run dev
```

The app runs at **http://localhost:4000** (Postgres on port **5433**). Environment
variables go in `checkin-app/.env` — the setup guides list them.

## Documentation map

### Start here

- **[AGENTS.md](AGENTS.md)** — orientation for contributors and agents: test commands, repo conventions, editing rules.
- **[CONSTITUTION.md](CONSTITUTION.md)** — purpose and core principles (security, privacy, auditability); what must never be weakened.
- **[Canonical Vocabulary](checkin-app/docs/VOCABULARY.md)** — what every domain word means (people, roles, money, tools, attendance).
- **[Domain rules](docs/rules/)** — the register of board and operations decisions, one file per domain; read the relevant file before changing behaviour in that domain. How the corpus is organised and retired: **[Documentation Standard](docs/DOCUMENTATION_STANDARD.md)**.
- **[Critical User Journeys](docs/backlog/CUJS.md)** — every user-facing flow, per step, tagged with what exists and what does not.
- **[Design Specification](docs/designs/DESIGN.md)** — the original system design; further design notes live in [`docs/designs/`](docs/designs/).

### Deployment & operations

- **[Production Launch Runbook](docs/designs/PRODUCTION_PLAN.md)** — the ordered checklist behind ops.innovationtreehouse.org.
- **[Deploy / Migration Order of Operations](checkin-app/docs/DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md)** — why migrations run before rollout and what that implies for schema changes.
- **[Migration Coalesce Flow](checkin-app/docs/MIGRATION_COALESCE_FLOW.md)** — a release may apply at most **one** new migration; how to coalesce accumulated migrations ([`checkin-app/scripts/coalesce-migrations.ts`](checkin-app/scripts/coalesce-migrations.ts)).
- **[`.github/workflows/`](.github/workflows/)** — [`ci.yml`](.github/workflows/ci.yml) (lint, tests, build — also reused to revalidate release tags), [`deploy-dev.yml`](.github/workflows/deploy-dev.yml) (merge to main → dev), [`deploy-prod.yml`](.github/workflows/deploy-prod.yml) (published `v*` release → prod, human-approved), [`migration-safety.yml`](.github/workflows/migration-safety.yml) (new migrations must apply to a *populated* DB), [`flow-tests.yml`](.github/workflows/flow-tests.yml), [`shopify-live.yml`](.github/workflows/shopify-live.yml), [`security-boundary-isolation.yml`](.github/workflows/security-boundary-isolation.yml).

### Security

- **[Security Policy Layer](docs/security/SECURITY-POLICY.md)** — the declarative model-security layer and its contract tests.
- [`docs/security/`](docs/security/) also holds the [auth-consistency analysis](docs/security/auth-consistency-analysis.md), [presence/identity tiering](docs/security/presence-identity-tiering.md), and [pentest findings (2026-04-21)](docs/security/pentest_findings_2026-04-21.md).

### Money & Shopify

- **[s-read-function/README.md](s-read-function/README.md)** — the Shopify → Postgres ingestion pipeline; [DEPLOY.md](s-read-function/DEPLOY.md) for rollout, [FUTUREWORK.md](s-read-function/FUTUREWORK.md) for the backlog.
- **[Program Capacity & Scholarships](checkin-app/docs/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md)** — capacity as single-pool Shopify inventory and the scholarship hold-ledger lifecycle.

### Testing

- **Two runners by workspace type** — Jest for `checkin-app/`, Vitest for `packages/*` and `*-function` (see [AGENTS.md](AGENTS.md)). Root scripts: `npm run test` (app), `npm run test:packages`, `npm run test:functions`, `npm run test:all`.
- **[AGENTS.md](AGENTS.md)** defines the three app test classes (unit / integration / flow) and their commands — run them from `checkin-app/`.
- **[Test Coverage Plan](docs/test-coverage-plan.md)** — the path to 80% line coverage and how to re-measure.
- **[pg-test-harness](packages/pg-test-harness/README.md)** — the fleet template for real-Postgres integration tiers.

---

Licensing: [LICENSE](LICENSE) · [TRADEMARKS.md](TRADEMARKS.md)
