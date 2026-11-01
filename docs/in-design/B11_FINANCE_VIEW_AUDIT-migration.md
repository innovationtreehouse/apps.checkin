# Finance view audit: cutover

One-time steps for moving to the finance view log. Everything here stops being
true once the copy has run. The permanent design is in
`B11_FINANCE_VIEW_AUDIT.md`.

## The donor-read copy (FV-9)

Before the finance view log exists, the app records each look at a donor as a
`DONOR_DATA_READ` row in the bulk-donation database's `WorkflowEvent` table.
The Board's new tab reads only the checkin database, so those rows are copied
once into `FinanceViewLog`. The originals stay where they are.

### Which rows

Only `DONOR_DATA_READ` rows written **before PR 2 deployed**. From PR 2 onward
the handler logs the same views itself, and until PR 4 removes the old writers
both logs receive them; copying those later rows would record each view twice
under two endpoint spellings that the repeat key cannot match. The cutoff is
PR 2's production deploy time, read from the deploy record and passed to the
script as an argument.

### How each row maps

| `FinanceViewLog` | From `WorkflowEvent` |
|---|---|
| `viewedAt` | `occurredAt` |
| `actorId` | `actorUserId` |
| `role` | null; the donor-read audit did not record it |
| `endpoint` | `payload.route` as stored. The receipt glue stored the concrete path (`GET /api/receipts/abc`) rather than the registry key, and it is kept as-is rather than guessed back. |
| `params` | `{}` |
| `recordIds` | `[entityId]` when set; otherwise `payload.ids` |
| `rowCount` | `payload.count` when set; otherwise the number of record ids |
| `window`, `viewKey` | computed by the same writer function the handler uses |

A row with no `actorUserId` cannot say who looked. It is not copied; the script
reports how many it skipped, and they stay readable in the original table.

### Running it

It runs once, in production, as a one-off ECS task from the app's own task
definition, because both databases are reachable only from inside the network.
The production image carries the script bundled as
`checkin-app/copy-donor-reads.mjs`, so it can't be run from a checkout, from
CloudShell or with `npx tsx`.

#### Before you run it

Production must run a release built after the PR that bundles the script
merged. An older image has no `copy-donor-reads.mjs`, and the task exits with
`Cannot find module`. Any such release also carries PR 4 (#2742).

The commands are for bash, such as AWS CloudShell; they only call AWS APIs, so
they need no network path to the databases.

The task definition already carries both URLs the script reads:

- `DATABASE_URL`, the app's checkin connection. The script inserts into
  `FinanceViewLog`, which the app's role already writes on every audited read.
- `BULK_DONATION_DATABASE_URL`, the app's bulk-donation connection. In AWS that
  is the bulk-donation library's DML role from the infra repo's cluster
  bootstrap (in the self-hosted compose stack, `bulk_donation_dml`): rows only,
  no DDL. The script only SELECTs from `workflow_events`, which that role
  already reads and writes at runtime.

#### Find the cutoff

The cutoff is the time PR 2 (#2683) went live in production: when the release
containing its merge commit, `42adf95b38d28c5c6d9394622f312382ac93451e`, finished
rolling out. Run these from a checkout with the release tags fetched.

The first release tag that contains PR 2:

```bash
git tag --contains 42adf95b38d28c5c6d9394622f312382ac93451e --sort=creatordate | head -1
```

The "Deploy prod" run for that tag (put the tag in for `<TAG>`):

```bash
gh run list --repo innovationtreehouse/apps.checkin --workflow deploy-prod.yml --limit 100 --json databaseId,headBranch,conclusion,createdAt --jq '.[] | select(.headBranch == "<TAG>")'
```

The time its rollout finished, from the run's successful "Deploy to ECS" step
(put the run's `databaseId` in for `<RUN_ID>`):

```bash
gh run view <RUN_ID> --repo innovationtreehouse/apps.checkin --json jobs --jq '.jobs[] | select(.name == "Build, migrate, roll out") | .steps[] | select(.name == "Deploy to ECS") | .completedAt'
```

That prints an ISO time in UTC, such as `2026-10-30T19:42:07Z`. Use it as
`--cutoff`. If that run was re-run, use the attempt that succeeded.

The ECS service's own events say the same thing, as the service "has reached a
steady state" after that deployment, but it keeps only its last 100 events:

```bash
aws ecs describe-services --cluster treehouse-prod --services checkin-prod --query 'services[0].events[?contains(message, `steady state`)].[createdAt,message]' --output text
```

#### Find the task definition and launch flags

Find the app's task definition and container name:

```bash
TASK_DEF=$(aws ecs describe-services --cluster treehouse-prod --services checkin-prod --query 'services[0].taskDefinition' --output text)
```

```bash
CONTAINER=$(aws ecs describe-task-definition --task-definition "$TASK_DEF" --query 'taskDefinition.containerDefinitions[0].name' --output text)
```

The launch flags are the Migrate step's in `.github/workflows/deploy-prod.yml`:
`FARGATE_SPOT`, and its `MIGRATE_SUBNETS` and `MIGRATE_SG`. If that workflow has
changed them, copy the new values.

```bash
LAUNCH_FLAGS="--capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=1 --network-configuration awsvpcConfiguration={subnets=[subnet-0597513f1c0c3173e,subnet-0a67d72908bffbcd4,subnet-0c84ac2840be3a2bc],securityGroups=[sg-0a37ac72f79b2fd5b],assignPublicIp=ENABLED}"
```

Find where the task's output goes:

```bash
LOG_GROUP=$(aws ecs describe-task-definition --task-definition "$TASK_DEF" --query 'taskDefinition.containerDefinitions[0].logConfiguration.options."awslogs-group"' --output text)
```

```bash
LOG_PREFIX=$(aws ecs describe-task-definition --task-definition "$TASK_DEF" --query 'taskDefinition.containerDefinitions[0].logConfiguration.options."awslogs-stream-prefix"' --output text)
```

#### Dry run

Set the cutoff from above:

```bash
CUTOFF=<ISO time from "Find the cutoff">
```

Start the dry run. It only counts, and writes nothing:

```bash
TASK_ARN=$(aws ecs run-task --cluster treehouse-prod --task-definition "$TASK_DEF" $LAUNCH_FLAGS --overrides "{\"containerOverrides\":[{\"name\":\"$CONTAINER\",\"command\":[\"node\",\"checkin-app/copy-donor-reads.mjs\",\"--cutoff\",\"$CUTOFF\"]}]}" --query 'tasks[0].taskArn' --output text)
```

Wait for it and read its exit code:

```bash
aws ecs wait tasks-stopped --cluster treehouse-prod --tasks "$TASK_ARN"
```

```bash
aws ecs describe-tasks --cluster treehouse-prod --tasks "$TASK_ARN" --query 'tasks[0].containers[0].exitCode' --output text
```

`aws ecs wait` gives up after 10 minutes; if it does, run it again. Read the
counts from the task's log stream:

```bash
aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "$LOG_PREFIX/$CONTAINER/${TASK_ARN##*/}" --query 'events[].message' --output text
```

Exit code 0 and a `DRY RUN — would copy` report with `total`, `copied` and
`skipped` is a good dry run. Any other exit code prints its error to the same
stream. An unreadable payload names its row id and stops the run; take it to
the owner rather than working around it.

#### Commit

Run the same task with `--commit`:

```bash
TASK_ARN=$(aws ecs run-task --cluster treehouse-prod --task-definition "$TASK_DEF" $LAUNCH_FLAGS --overrides "{\"containerOverrides\":[{\"name\":\"$CONTAINER\",\"command\":[\"node\",\"checkin-app/copy-donor-reads.mjs\",\"--cutoff\",\"$CUTOFF\",\"--commit\"]}]}" --query 'tasks[0].taskArn' --output text)
```

Then wait, read the exit code and read the log stream with the same three
commands as the dry run. The report now starts `Copied` and adds `inserted`.
`copied` and `skipped` should match the dry run. If the task stops partway,
run it again: the insert skips rows already copied.

#### Afterwards

1. Check: `copied` plus `skipped` equals `total`, the number of
   `DONOR_DATA_READ` rows before the cutoff. Record `total`, `copied`,
   `skipped` and `inserted`, and the cutoff used, on PR 4 (#2742).
2. Delete the script in a follow-up PR, and delete this file with the design
   doc when the last PR merges.
