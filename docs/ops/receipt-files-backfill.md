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

It runs as a one-off ECS task, because the database and the bucket's read rule
are only reachable from inside the network. The commands are for bash, such as
AWS CloudShell, and need `jq`. They only call AWS APIs.

The task launches from the migrate task definition (`checkin-migrate-<env>`,
container `checkin-migrate`), on Fargate Spot with the network flags of the
deploy workflow's Migrate step. That is the one-off launch the deploy workflows
use in every environment. The app's task definition can't stand in for it in
prod: there it runs only on the cluster's Managed Instances, and `run-task` with
Fargate flags fails with `Task definition does not support launch_type FARGATE`.

The migrate task definition doesn't carry everything the script needs, so the
`run-task` call adds what is missing:

- `RECEIPT_DATABASE_URL`: already on the migrate task, because the receipt
  library's migrations run there. It connects as the role those migrations run
  as, which owns the tables and so can set `file_key`.
- `RECEIPT_FILES_S3_BUCKET`: copied from the app's task definition into a
  container override.
- The task role: the app's task role, as a task override. The bucket policy
  admits only that role and the admin role
  ([design](../in-design/1265_RECEIPT_FILES_S3.md) §6), so the migrate task's
  own role is refused.

This repo can't confirm the rest, which lives in the infra repo: that your AWS
identity may pass the app's task role to ECS (`iam:PassRole`), that the role
accepts this task, and that the migrate subnets reach S3 through the gateway
endpoint the read rule requires. If `run-task` refuses the role, or the report
shows `AccessDenied` failures, stop and take it to infra. Don't change the
bucket policy or role to get past it.

### 1. Set the environment's names

Run the two commands for the environment you are working in.

Prod. The subnets and security group are `MIGRATE_SUBNETS` and `MIGRATE_SG` in
`deploy-prod.yml`; if they differ from these, use the workflow's.

```bash
CLUSTER=treehouse-prod SERVICE=checkin-prod MIGRATE_FAMILY=checkin-migrate-prod LOG_GROUP=/ecs/checkin-migrate-prod
```

```bash
NETWORK="awsvpcConfiguration={subnets=[subnet-0597513f1c0c3173e,subnet-0a67d72908bffbcd4,subnet-0c84ac2840be3a2bc],securityGroups=[sg-0a37ac72f79b2fd5b],assignPublicIp=ENABLED}"
```

Staging. Like its workflow, this reuses the service's own network
configuration.

```bash
CLUSTER=checkin-stg SERVICE=checkin-stg MIGRATE_FAMILY=checkin-migrate-stg LOG_GROUP=/ecs/checkin-migrate-stg
```

```bash
NETWORK=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].networkConfiguration' --output json)
```

Dev. Same as staging.

```bash
CLUSTER=checkin-dev SERVICE=checkin-dev MIGRATE_FAMILY=checkin-migrate-dev LOG_GROUP=/ecs/checkin-migrate-dev
```

```bash
NETWORK=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].networkConfiguration' --output json)
```

### 2. Read the app's image, task role and bucket

Find the task definition the service runs:

```bash
APP_TASK_DEF=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
```

```bash
IMAGE=$(aws ecs describe-task-definition --task-definition "$APP_TASK_DEF" --query 'taskDefinition.containerDefinitions[0].image' --output text)
```

```bash
APP_ROLE=$(aws ecs describe-task-definition --task-definition "$APP_TASK_DEF" --query 'taskDefinition.taskRoleArn' --output text)
```

```bash
BUCKET=$(aws ecs describe-task-definition --task-definition "$APP_TASK_DEF" --query "taskDefinition.containerDefinitions[0].environment[?name=='RECEIPT_FILES_S3_BUCKET'].value | [0]" --output text)
```

Check all three:

```bash
echo "$IMAGE $APP_ROLE $BUCKET"
```

None of them may read `None`.

### 3. Point the migrate task definition at the release image

`run-task` can't override the image. Register a migrate revision that runs the
image the service runs, as the deploy workflow does. The release in that image
carries `checkin-app/receipt-file-backfill.mjs`. The new revision is otherwise
the same as the latest one, and the next deploy registers its own on top.

```bash
aws ecs describe-task-definition --task-definition "$MIGRATE_FAMILY" --query taskDefinition --output json | jq --arg IMG "$IMAGE" '.containerDefinitions[0].image = $IMG | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions, requiresCompatibilities, cpu, memory, runtimePlatform}' > migrate-taskdef.json
```

```bash
MIGRATE_ARN=$(aws ecs register-task-definition --cli-input-json file://migrate-taskdef.json --query 'taskDefinition.taskDefinitionArn' --output text)
```

Check that it carries the receipt database URL. The list must include
`RECEIPT_DATABASE_URL`:

```bash
aws ecs describe-task-definition --task-definition "$MIGRATE_ARN" --query 'taskDefinition.containerDefinitions[0].[secrets[].name, environment[].name]' --output text
```

### 4. Start the copy

```bash
TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$MIGRATE_ARN" --capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=1 --network-configuration "$NETWORK" --overrides "{\"taskRoleArn\":\"$APP_ROLE\",\"containerOverrides\":[{\"name\":\"checkin-migrate\",\"command\":[\"node\",\"checkin-app/receipt-file-backfill.mjs\"],\"environment\":[{\"name\":\"RECEIPT_FILES_S3_BUCKET\",\"value\":\"$BUCKET\"}]}]}" --query 'tasks[0].taskArn' --output text)
```

If `TASK_ARN` is `None`, the task didn't start; run the command without
`--query` and `--output` to see the refusal.

Wait for it and read its exit code:

```bash
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
```

```bash
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --query 'tasks[0].[containers[0].exitCode, stoppedReason]' --output text
```

`aws ecs wait` gives up after 10 minutes; a large first run can outlast it, so run
it again.

Read the report:

```bash
aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "ecs/checkin-migrate/${TASK_ARN##*/}" --query 'events[].message' --output text
```

It names rows by id and carries no file contents.

The script waits up to 5 minutes for a paused database to resume. If the task is
interrupted, including by a Spot reclaim, start it again: it picks up the rows
that still have no key.

### 5. Verify

Start the verify run, then wait, read the exit code and read the report with the
same three commands as the copy:

```bash
TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$MIGRATE_ARN" --capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=1 --network-configuration "$NETWORK" --overrides "{\"taskRoleArn\":\"$APP_ROLE\",\"containerOverrides\":[{\"name\":\"checkin-migrate\",\"command\":[\"node\",\"checkin-app/receipt-file-backfill.mjs\",\"--verify\"],\"environment\":[{\"name\":\"RECEIPT_FILES_S3_BUCKET\",\"value\":\"$BUCKET\"}]}]}" --query 'tasks[0].taskArn' --output text)
```

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
