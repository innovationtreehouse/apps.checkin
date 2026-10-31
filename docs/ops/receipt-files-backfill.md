# Receipt files backfill

Run this once in each environment, after `RECEIPT_FILES_S3` is on there, to copy
existing receipt and held-mail files from the receipt database to that
environment's private bucket. Then run `--verify`. A clean verify in prod is the
gate for removing the database reads. The design is
[`1265_RECEIPT_FILES_S3.md`](../in-design/1265_RECEIPT_FILES_S3.md) §4.

The script never changes or clears `file_blob`, never overwrites an object and
never deletes one. Verify only reads. It is safe to stop and re-run either at any
point.

Delete this page once the database reads are gone (§9, PR 4) in every environment.

## Before you run it

In the environment you are about to run:

- The release containing this script is fully rolled out.
- `RECEIPT_FILES_S3` is on, and has been since that rollout finished. Rows written
  before the flag hold bytes; with it on, no new ones do.
- `RECEIPT_FILES_S3_BUCKET` is set and the config-health page shows no gap.
- In order: dev, then staging, then prod. Finish one before starting the next.

As soon as a row has its key, the app serves that row's file from the bucket.

## Run it

It runs as a one-off ECS task from the app's own task definition, because the
database and the bucket's read rule are only reachable from inside the network.
The task role, bucket and database URL come with that definition.

The commands below use prod's names. For dev and staging, use the cluster and
family from `deploy-dev.yml` and `deploy-staging.yml`. Copy the capacity provider
and network flags from the same workflow's Migrate step, into `$LAUNCH_FLAGS`.

Find the app's task definition and container name:

```bash
TASK_DEF=$(aws ecs describe-services --cluster treehouse-prod --services checkin-prod --query 'services[0].taskDefinition' --output text)
```

```bash
CONTAINER=$(aws ecs describe-task-definition --task-definition "$TASK_DEF" --query 'taskDefinition.containerDefinitions[0].name' --output text)
```

Start the copy:

```bash
TASK_ARN=$(aws ecs run-task --cluster treehouse-prod --task-definition "$TASK_DEF" $LAUNCH_FLAGS --overrides "{\"containerOverrides\":[{\"name\":\"$CONTAINER\",\"command\":[\"node\",\"checkin-app/receipt-file-backfill.mjs\"]}]}" --query 'tasks[0].taskArn' --output text)
```

Wait for it and read its exit code:

```bash
aws ecs wait tasks-stopped --cluster treehouse-prod --tasks "$TASK_ARN"
```

```bash
aws ecs describe-tasks --cluster treehouse-prod --tasks "$TASK_ARN" --query 'tasks[0].containers[0].exitCode' --output text
```

`aws ecs wait` gives up after 10 minutes; a large first run can outlast it, so run
it again. The report is in the task's log stream, under the log group in the task
definition. It names rows by id and carries no file contents.

The script waits up to 5 minutes for a paused database to resume. If the task is
interrupted, start it again: it picks up the rows that still have no key.

Then run the same `run-task` command with `"command":["node","checkin-app/receipt-file-backfill.mjs","--verify"]`.

## Read the result

Each mode exits 0 only when its report is clean.

**Copy report**

| Field | Meaning | Action |
|---|---|---|
| `copied` | Object written and key set | None |
| `alreadyStored` | An earlier run wrote the object; key now set | None |
| `gone` | The row was assigned or discarded during the copy | None; its object is never served |
| `failures` | The store or database refused, named by error | Fix the cause and re-run |
| `mismatches` | The row's bytes don't match its stored hash, or the key already holds other bytes | Don't re-run in hope. See below |

**Verify report**

| Field | Meaning | Action |
|---|---|---|
| `matched` | Object, `file_blob` and stored hash agree | None |
| `noKey` | The row has bytes and no key | Re-run the copy, then verify again |
| `failures` | The read failed, named by error | Fix the cause and verify again |
| `missing` | The row's key names no object | See below |
| `mismatches` | Object, `file_blob` and stored hash disagree | See below |

The gate is `noKey`, `missing`, `mismatches` and `failures` all empty, in that
environment, on a verify run after the last copy.

## When a row mismatches or its object is missing

Stop and take the row ids to the owner. Nothing repairs these on its own, on
purpose: `file_blob` is still the original, and a person decides which copy is
right. Don't edit the row or the object by hand to make verify pass.

A row in `missing` answers 404 on its file route until that is settled, even
though its bytes are still in the database, because a key takes priority.

## Trying it locally

With `CHECKIN_ENV=local`, the script uses the temp-directory store. From
`checkin-app/`, with `RECEIPT_DATABASE_URL` pointing at a local database:

```bash
npx tsx scripts/receipt-file-backfill.ts --verify
```
