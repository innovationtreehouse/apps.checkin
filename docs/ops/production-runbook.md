# Production runbook

A production release is a published GitHub release on a `rel/<major>.<minor>`
branch, approved by one reviewer. [`deploy-prod.yml`](../../.github/workflows/deploy-prod.yml)
does the rest: it migrates, rolls out and smoke-tests ops.innovationtreehouse.org.
To back out a bad release, point the service at the previous task definition and
leave the database alone (see [Roll back](#roll-back)).

Why migrations run before the rollout, and what that demands of a schema change,
is in [Deploy / Migration Order of Operations](DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md).
Read it before releasing anything that carries a migration.

## Deploy

### 1. Update the release line

Each `major.minor` is one branch, and every patch on it ships from that branch.

- **Next release on an existing line:** open a PR from a `release/sync-*` branch
  into `rel/<major>.<minor>` that makes its tree match `main`. The branch requires
  a code owner's approval, so a direct push does not work. The PR body lists any
  commit that exists only on the release line and confirms `main` has it, because
  the sync would otherwise drop it.
- **Hotfix:** open a PR with only the fix into the release line, and make sure the
  same fix is on `main`.
- **New line:** `git push origin main:refs/heads/rel/<major>.<minor>`.

### 2. Check it on staging

Any push to `rel/**` runs [`deploy-staging.yml`](../../.github/workflows/deploy-staging.yml),
after approval on the `staging` environment. It rebuilds a scrubbed copy of
production's data, applies the release's migrations to it, and deploys to
ops-stg.innovationtreehouse.org. A migration that fails on real data shape fails
here first, so wait for this run before cutting the release.

To redeploy a line with no new commit, run the workflow by hand from that branch.
Set `reseed` off to keep staging's current data.

If a migration wedges staging with `P3009`, rerun by hand with
`resolve_rolled_back` set to the migration's name. That input exists only on
staging.

### 3. Cut the release

```bash
gh release create v<major>.<minor>.<patch> --target rel/<major>.<minor> --generate-notes
```

Publishing starts the deploy. A draft does not, and a pre-release does, so don't
mark a release as a pre-release unless it should ship.

### 4. Approve and watch

The run takes these steps in order, and each one stops the run if it fails.

| Step | What it does | What failure leaves running |
|---|---|---|
| Release branch match | The tag's commit must be on the branch its version names | Previous release |
| Revalidate | Runs all of CI against the tag | Previous release |
| Approval | One reviewer on the `production` environment | Previous release |
| Migrate | One-off ECS task: library databases first, then checkin's | Previous release, on a schema that may be partly migrated |
| Roll out | Registers a new task definition and waits for the service to stabilise | Depends how far ECS got; check the service |
| Smoke test | Expects a 200 or redirect from the live URL within about two minutes | New release |
| s-read, then the QuickBooks token refresher | Each deploys from the same tag | New app release |

The run's summary reports the result. Migrate task logs are printed in the run.

## When a deploy fails

- **Branch match or revalidate:** nothing has changed. Fix the release line and cut
  a new patch release.
- **Migrate:** the old release is still serving. A failed migration blocks every
  later deploy with `P3009` until someone resolves it; follow
  [rule 6](DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md#6-a-failed-migration-wedges-every-future-deploy-until-a-human-intervenes).
  Production has no workflow input for this, so it takes a one-off ECS task. Then
  re-run the failed run, which reuses the same tag.
- **Roll out or smoke test:** decide whether the new release is the cause. If it
  is, roll back. A cold database or a slow first boot can also exhaust the smoke
  test, so check the live URL before acting.
- **s-read or the refresher:** the app is already live on the new release. Fix the
  cause and re-run the failed run; its migrate and rollout steps run again against
  the same tag and apply nothing new.

## Roll back

Rolling back restores the previous image and nothing else. Migrations stay
applied, because the [order of operations](DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md#the-deploy-sequence)
already requires old code to run against the migrated schema during every
rollout. A migration that turns out to be wrong gets a new migration that
corrects it, never a by-hand reversal.

No workflow does this and it has not been rehearsed. It needs AWS credentials that
can update the service.

1. Find the revision running the previous release. The workflow tags each image
   with its commit, so compare the image against that tag's commit:

   ```bash
   git rev-parse 'v<previous>^{commit}'
   ```

   ```bash
   aws ecs list-task-definitions --family-prefix checkin-prod --sort DESC --max-items 5
   ```

   ```bash
   aws ecs describe-task-definition --task-definition checkin-prod:<revision> --query 'taskDefinition.containerDefinitions[0].image' --output text
   ```

2. Point the service at it and wait:

   ```bash
   aws ecs update-service --cluster treehouse-prod --service checkin-prod --task-definition checkin-prod:<revision>
   ```

   ```bash
   aws ecs wait services-stable --cluster treehouse-prod --services checkin-prod
   ```

3. Check the live URL, then fix the problem on the release line and cut a new patch
   release. The next deploy replaces the image in the latest task definition, so a
   rollback needs no cleanup.

Going back more than one release needs a check first. A destructive migration
ships only once the release before it has stopped using the old shape, so the
release two back may read a column that no longer exists. Compare the migrations
in between against that release's code before going further.

This covers the app only; s-read and the token refresher stay on the new release.
If one of them is at fault, fix it and release forward.

## Alerts

The incident engine (`checkin-app/src/lib/opsIncidents.ts`) turns job failures
into email: one alert per outage, not one per item or per run. Every scheduled
job ends its run in one shared step (`checkin-app/src/lib/finishRun.ts`): it
records the run with its failures by kind, then hands the run to the engine,
which also checks every job for a stopped schedule.

**What it hears.** The receipt, expense, gift-of-goods, income and receiving
libraries report each sorted failure through their "on failure" port; the app files the
reports under the job run in progress. The daily reconcile job runs the receipt
lanes (re-push, mailbox reading, OCR of mailed files), expense intake, and receiving's
matching re-run, which reports a receipt whose matching gave up; the daily posting job runs
the expense, gift-of-goods and income posting lanes. A step of either job that
crashes counts too, as a bug unless its error was sorted. An item counts once
per run, however often its lane reports it. A run covers only the lanes whose
work it reached, so a step that crashed or could not run keeps its incident open. A failure outside a job run, such
as a receipt finalized by hand, is only logged.

**Who gets them.** The engine reads the alert address and the Board address
from app settings (Settings → Email).
Every alert goes to the alert address; the two-week escalation goes to the
Board address. Both are group addresses, and alerts ignore personal email
opt-outs. With no address set, nothing is sent, with no fallback to anyone
else: the incident stays unannounced, so the next run tries again.

**What opens an incident.** Each failure has a cause (QuickBooks, Gmail, OCR,
the database, catalog events) and a kind.

| Kind | Alerts when | One incident per |
| --- | --- | --- |
| System | Two runs in a row fail, or a lane stops | cause and kind, listing every lane hit |
| Connection | The first run fails | cause and kind |
| Settings, with work waiting | The first run fails | cause and kind |
| Bug | A new code, on its first run | lane and code |
| Data | Never: it stays in finance's queue | — |
| Stopped job | No successful run in 48 hours | job (`cron:<job>:stale`) |

A single system failure that heals on the next run stays quiet.

**Where to see them.** System Status → Health has an "Open problems" panel
listing every incident not yet closed: its kind, cause, lanes, when it was
first seen, and runs and items so far. *Watching* means seen but below the
alert threshold; *open* means the notice went out. Open incidents add to the
red System Status pill. A stopped job with an open incident counts there once,
not again as an unhealthy scheduled job.

**What arrives, and when.**

1. *Opened*: the first notice, once the threshold is met. It counts as sent
   only if at least one address took it; a failed send retries next run.
2. *Reminder*: three days after the notice, then weekly, with the runs seen so far.
3. *Escalation*: to the Board address, once, after two weeks open.
4. *Recovered*: when a run covers every lane on the incident without the
   failure. It is sent only if an opening notice went out.
5. *Back again*: the same problem within 24 hours of recovering reopens the
   same incident, and the opened notice says "back again".

The subject reads `[<kind>] <cause>: <lanes> — <status>`. The body says what
is happening, the lanes, when it was first seen, runs seen, items waiting,
what to do, and links to System Status. It carries codes and counts only, never
amounts, donor or vendor names, or memo text. The Board can edit the wording
under Settings → Email like any other template.

**Acting on one.** Follow the email's "what to do" line. For a QuickBooks
connection that is [step 3 of the go-live runbook](quickbooks-go-live.md)
with the infra operator, then reseeding the secret. For a bug, read the job
logs for the code named. Nothing needs closing by hand: the next clean run
closes the incident and sends the recovery note.

Closed incidents are deleted after 90 days.
