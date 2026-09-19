# Production Launch Runbook (checkin → ops.innovationtreehouse.org)

Supersedes the pre-AWS hosting-selection plan (2026-07-13). The infrastructure
decisions are made and mostly applied; this is the ordered checklist from the
current state to a served production app. Companion docs: the release-promotion
security review (treehouse workspace root, untracked) whose findings are carried
here, and infra `modules/checkin/overview.tf` for the design decisions.

## Already in place (verified 2026-07-13)

- **Infra staged**: `checkin_prod_enabled = true` in infra `live/mgmt/main.tf` —
  ECR `checkin-prod` (immutable tags), ECS service `checkin-prod` on the shared
  `treehouse-prod` cluster (c6g capacity provider, `desired_count = 0` until a
  real image + secrets exist), task-def families `checkin-prod` /
  `checkin-migrate-prod`, per-env secret shells, IAM.
- **Release pipeline** (`deploy-prod.yml`): publishing a `v*` GitHub release →
  `validate` re-runs the FULL CI pipeline against the released tag (security
  review H1 ✅) → `production` environment gate: required reviewers
  (ryannazaretian, dkaygithub, thpr, dmkorten — one approval,
  `prevent_self_review`, no admin bypass, `v*` tags only; H2 ✅) → migrate task
  → ECS rollout → smoke against https://ops.innovationtreehouse.org.
- **OIDC pinning** (C1, config level ✅): `checkin-deploy-prod` trust =
  `repo:innovationtreehouse/checkin:environment:production`; dev role pinned to
  `refs/heads/main`. Verify the APPLIED trust policy once during step 6.
- **DNS**: `ops.innovationtreehouse.org` resolves (rides the wiki ALB cert).
- **Per-env store domains** (M1 ✅): infra bakes
  `9jhydb-ka.myshopify.com` (prod) / `treehouse-dev-4folhtgx` (dev) into the
  task defs; the shared repo variable is gone.
- **Dev as rehearsal**: the same parameterized module + pipeline shape runs
  checkin-dev on every merge to main.

## Launch sequence

### 1. Land the DDL/DML split FIRST (infra #119 — strongest C2 fix)

The prod database does not exist yet, so if #119 merges before the bootstrap
run, `checkin_prod` is **born** with the split: the app role can never touch
the schema, and dev/prod isolation on the shared Aurora cluster rests on
per-database least-privilege roles (exactly what security finding C2 asks for).
Order: merge infra #122 (verify-full TLS) → rebase #119 onto main (it rewrites
bootstrap.sh, which #121/#122 touched) → merge.
Side effect: the bootstrap run in step 3 also migrates checkin-DEV to the
split model and rotates its credentials — **force-new-deployment the
checkin-dev service immediately after** (running tasks hold the old password
and fail on their next reconnect).

### 2. Set the prod secret values (human-owned; never in chat/git)

`aws secretsmanager put-secret-value --secret-id checkin-prod/<name> ...`:

| Secret | Source |
|---|---|
| `nextauth-secret`, `cron-secret` | generate (`openssl rand -base64 32`) |
| `google-client-id` / `google-client-secret` | prod OAuth client in GCP (authorized origin/callback = ops.innovationtreehouse.org) |
| `bootstrap-sysadmins` | comma-separated admin emails (first-login bootstrap) |
| `resend-api-key` | Resend dashboard (prod sending domain verified) |
| `kiosk-public-key` | kiosk client keypair |
| `shopify-client-id` / `shopify-client-secret` | the REAL store's app (Dev Dashboard) |
| `shopify-webhook-secret` | ⚠ store Settings→Notifications signing secret — prod uses the store-secret path, NOT the app client secret (see SHOPIFY_DEV_STORE_WEBHOOK.md §2/§4) |
| `database-url` (+ `-ddl` after #119) | written automatically by step 3 — do NOT set by hand |

ECS refuses to launch a task referencing a valueless secret — every shell above
needs a version before the first deploy.

### 3. Provision the prod database

Run the bootstrap task (infra modules/checkin-bootstrap, `terraform output
-raw run_command`) with `TARGETS=checkin`: creates the `checkin_prod` role(s) +
database on the shared Aurora cluster and writes the database-url secret(s),
save-then-verify. Idempotent. Then the dev redeploy from step 1's side effect.

### 4. Membership-agreement PDF (likely already done)

The assets bucket is deliberately ONE bucket shared by dev and prod (infra
`live/mgmt/checkin-assets.tf` — single legal document; dev signatures are
watermarked at runtime via `CHECKIN_ENV`). If dev's signing flow already
works, the PDF is already there — just verify:
`aws s3 ls s3://checkin-assets-639595353568/membership-agreement.pdf`
Only upload (`aws s3 cp ...`) if missing.

### 5. Repo settings (GitHub)

- Enable **Require review from Code Owners** on `main` (security review L2 —
  currently OFF; CODEOWNERS covers `.github/` so promotion workflows can't be
  quietly weakened once this is on).
- Consider adding the `Package & function tests (Vitest)` job (#993, broadened in #228) to required status checks.

### 6. One-time in-AWS verification (with `aws login`)

- All `checkin-prod/*` shells have versions; task defs reference ONLY
  `checkin-prod/*` ARNs and set `CHECKIN_ENV=prod` (C3).
- Applied trust policy of `checkin-deploy-prod` matches the pinned sub (C1).
- ECR `checkin-prod` tag immutability is IMMUTABLE as applied (L3).
- Capacity: wiki (1024 MiB) + checkin-prod (768 MiB) both place on the single
  prepaid c6g.medium — confirm headroom before raising desired_count/memory.

### 7. Cut the release

```bash
gh release create v1.0.0 --target main --generate-notes
```
`validate` goes green on the tag → one reviewer approves the `production`
deployment → migrate runs (expand/contract, retry loop for Aurora auto-pause
resume) → service rolls out → workflow smoke-checks the app URL.

### 8. First-boot configuration (in the app)

- Sign in as a `bootstrap-sysadmins` member; confirm admin bootstrap.
- `/settings/membership`: set the org membership variant id (BoardSettings —
  never in code or seed).
- Register the prod Shopify webhook via the store-admin path and confirm
  deliveries return 200 (the secret-pairing rule from step 2 applies).
- Walk one end-to-end journey: member check-in, a program registration link,
  agreement signing.

### 9. Post-launch follow-ups (tracked, not blocking)

- M2: promote the tested artifact instead of rebuilding from the tag; pin base
  images/actions by digest.
- M3: delete the legacy `deploy/` + `install_aws/` bare-metal path once
  confirmed dead (uncontrolled promotion path; `reload.sh` uses `prisma db push`).
- Monitoring: wire checkin-prod into the watchdog/heartbeat stack; the s-read
  `MONITORING_DATABASE_URL` gap is the same follow-up family.
- checkin URLs still use `sslmode=require`: give the checkin image the RDS CA
  treatment and pin verify-full (s-read did this in infra #122).
