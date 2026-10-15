---
name: jest-run
description: Safe way to run jest / npm test in the checkin-app repo. Use whenever running, narrowing, or re-scoping tests here (jest, npm test, test:ci, test:integration, test:flow), or when a test run hangs, produces no output, or seems slow. Covers scope narrowing, --forceExit, foreground-only, and the 60s-no-output rule. A PreToolUse hook already hard-blocks the three worst mistakes; this skill is the judgment the hook can't encode.
---

# Running jest safely in checkin-app

Run all commands from `checkin-app/`. A `.claude/hooks/jest-guard.sh` PreToolUse hook
hard-blocks the three catastrophic shapes (background test, tail/head pipe, hand-rolled
`--testPathIgnorePatterns`). Everything below is the part the hook leaves to judgment.

## Use the package.json scripts verbatim

They already carry the right worker flags (unit: `--runInBand`; integration: one worker by
default, each worker on its own cloned DB, `INTEGRATION_WORKERS=N` for more):

| Want | Command |
|------|---------|
| Full unit suite | `npm test` |
| CI-style | `npm run test:ci` |
| Integration (needs a DB) | `npm run test:integration` |
| Flow (needs a running dev server + separate config) | `npm run test:flow` |

## Narrowing scope — append, never replace

To run a subset, **append ONE `--testPathPatterns <regex>`**. Never touch the ignore array.

```
npm test -- --testPathPatterns scopeBindings
```

Why: `--testPathIgnorePatterns` is variadic and **replaces** jest's entire config ignore
array. The config excludes the integration, flow, and `.claude/worktrees/` tests on
purpose; replacing it pulls them back in, and they hang 5–16 min against a DB/dev-server
that isn't up. The hook blocks the raw flag; the fix is `--testPathPatterns`, not a
"corrected" ignore list. A bare positional path (`jest src/foo.test.ts`) also narrows but
is easy to get wrong — prefer `--testPathPatterns`.

## Direct `jest` invocations: add `--forceExit --runInBand`

If you must call `jest` directly instead of a script:

```
npx jest --forceExit --runInBand --testPathPatterns <regex>
```

`--forceExit`: open Prisma pool handles keep the jest process alive after tests pass.
Without it a *finished* run looks like a hang — don't misread that as slow and background it.

## Foreground only. No tail/head. The 60s rule.

- **Always foreground.** Backgrounded test output buffers and hides hangs (hook blocks it).
- **Never pipe through `tail`/`head`** — piped output buffers until process exit, so the
  stream looks empty the whole time even while it hangs (hook blocks it). Need to trim
  output? Redirect to a file and Read it: `npm test -- --testPathPatterns X > /tmp/t.log 2>&1`
- **No output for ~60s ⇒ wrong-scope hang.** Almost always the run pulled in integration/
  flow tests against something that isn't running. Kill it, re-scope with
  `--testPathPatterns`, re-run. Do not wait it out; do not background it.

## Worktrees

This repo uses `.claude/worktrees/`. A worktree has no `node_modules` — run a real
`npm install` in `checkin-app/` (not a symlink) before any test or dev server. Jest's
config ignores the worktree rootDir, so a naive full run inside a worktree can find 0 tests.
