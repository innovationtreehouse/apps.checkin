# Issue workflow — getting to the new states

The rules being migrated to are `ISSUE_WORKFLOW_RULES.md`. This file is the
route there: what is wrong now, what to change by hand, and what has to be
decided first. It is true only until the migration runs.

## 1. Problem

The tracker's Status is supposed to say what stage a piece of work is at. It
does not. Work where a written proposal is out for review and work where the
actual change is out for review show the same status, so the board cannot be
read without opening each item to find out which one it means. Getting from the
first to the second requires moving the item *backwards*.

Work that is half delivered — one part shipped, the rest waiting on a release
going out — sits under a status meaning "free for anyone to pick up". It is not.

Four of the eight available statuses have never been written down. Two of them
hold most of the tracker's contents.

## 2. Objective

Status becomes a ladder each item climbs once: entered at most once, never
returned to. The status alone says what stage the work is at and who acts next.
Work that is not available to pick up does not show as available.

## 3. Option changes

| Current option | Items | Becomes | Action |
|---|---|---|---|
| Ideation/Reporting | 140 | Ideation/Reporting | keep, definition tightened |
| Planning | 31 | Planning | keep, definition tightened |
| Backlog | **0** | — | **retire** |
| Ready | 1 | Ready | keep, narrowed to "design settled" |
| In progress | 1 | In progress | keep |
| In review | 9 | In review | keep, **narrowed to the implementation leg** |
| Done | 27 | Done | keep |
| Rejected | **0** | Rejected | keep — see question 2 |
| — | — | **Designing** | **add** |
| — | — | **Design review** | **add** |

Net: two options added, one retired. Blocked and partly-delivered deliberately
do not become options — a label and a decomposition respectively, per the rules.

## 4. Steps

Single-select option edits are a GitHub UI action, not safely scriptable. In
order:

1. Add option `Designing`.
2. Add option `Design review`.
3. Reorder options to the ladder: Ideation/Reporting, Planning, Designing,
   Design review, Ready, In progress, In review, Done, Rejected. The board reads
   left to right; a monotonic status should look monotonic.
4. Delete option `Backlog` — confirm zero items first; deleting an option with
   items on it silently clears their status.
5. Create the `blocked` label in `innovationtreehouse/checkin`.
6. Re-file the nine **In review** items: anything whose only open PR is a design
   PR moves to **Design review** (#1258 at minimum).
7. Decompose #975 into parent + one child per release (§5.3); label the Release 2
   child `blocked` with its gate in the body.
8. Backfill Iteration on everything at Planning or beyond. **34 items** qualify
   and carry none today — 31 Planning, 2 In review, 1 In progress — against 11
   items total currently in Iteration 2. Leave Ideation/Reporting unset; that is
   the rule, not an omission. Until this runs, the `iteration:@current` view
   shows 11 of the 44 items that are actually in flight.
9. Paste `ISSUE_WORKFLOW_RULES.md` over the `AGENTS.md` § "Issue workflow (org
   project 1)", then delete both working docs.

Built-in project workflows need no change. "Item closed" and "Pull request
merged" fire only on a *linked* PR, and a design PR carries no closing keyword,
so it cannot trigger them.

## 5. Where the in-flight work lands

Traces of the five cases the model had to represent. No state repeats in any.

### 5.1 #1258 — admin hour-correction review screen
Design PR #1497 open, no closing link (correct for a design PR). No
implementation PR. Today **In review**.
```
Ideation/Reporting → Planning → Designing → Design review ▸
```
Lands on **Design review**. In review is a state it has not yet entered — today
it shares that status with #1396, four rungs ahead of it.

### 5.2 #1396 — merge transfers the background check date
Design merged. Implementation PRs #1450, #1451, #1470 open. Today **In review**.
```
Ideation/Reporting → Planning → Designing → Design review → Ready → In progress → In review ▸
```
**Blocker for this issue, independent of the migration:** no open PR closes
#1396 — `closingIssuesReferences` is empty on #1450 and #1451, and points to
#1260 on #1470. Nothing will close the issue or drive Status → Done. Either give
it sub-issues or give one PR the closing keyword.

### 5.3 #975 — legacy two-variant Shopify shape
Design merged. Releases 0+1 shipped (#1464, cleanup #1493). Release 2
(`DROP COLUMN`) outstanding and cannot start until Release 1 is live in a
published **prod** release. Today **Ready**, which wrongly reads as free to pick
up.
```
#975 (parent)  Ideation/Reporting → Planning → Designing → Design review → In progress ▸
  ├─ Release 0+1 (code)       Ready → In progress → In review → Done
  └─ Release 2 (DROP COLUMN)  Ready + `blocked` ▸
```
Parent skips Ready and holds In progress, unassigned, until the last child
closes. The Release 2 child names its gate in the body: *"Release 1 live in a
published prod release."*

### 5.4 #1224 — individual agreement per adult child
Implementation PR #1477 open, closing link confirmed. Today **In review**.
```
Ideation/Reporting → Planning → Designing → Design review → Ready → In progress → In review ▸
```
Identical to #1396 — which is the point.

### 5.5 #1230 — "students ≥18 as of Sept 1" report
No design doc. PR #1495 open, closes it. Today **In review**.
```
Ideation/Reporting → Planning → Ready → In progress → In review ▸
```
Five rungs. The design leg is skipped at zero cost.

## 6. Decide before migrating

1. **Is Ideation/Reporting one bucket or two?** It holds 140 of 209 items, from
   one-line reports to accepted-but-unscheduled epics. This retires Backlog on
   the evidence it has never been used; the other reading is that it went unused
   *because* it was undocumented, and the real need is Reported → Backlog →
   Planning. One more rung. **Blocks step 4.**
2. **Keep Rejected, or just close?** Zero items — unwanted work is being closed
   without it. Closing as "not planned" trips "Item closed" into **Done**, which
   is wrong. Either set Rejected by hand before closing, or drop it and redefine
   Done as "closed, however".
3. **Should Designing require an assignee?** If designs are in practice written
   by whoever is already in the area rather than claimed in advance, Designing
   and Design review collapse into one state — a rung fewer. **Blocks steps 1–3.**
4. **Is the "no design needed" call final?** Planning → Ready is a one-way door
   in this model. If someone in Ready then decides a design *is* needed, that is
   Ready → Designing, covered by neither rework case. This assumes the call is
   final and any later design is rework.
5. **Renaming Ideation/Reporting.** The slash reads badly; a rename touches 140
   items' worth of habit for no functional gain. Left alone.
6. **Nothing enforces this.** A monotonicity check over each item's status-change
   timeline is buildable but not proposed — the rework exception means it could
   never be a hard gate.

## Appendix — evidence

All 209 items on project 1:

| Status | Items | | Status | Items |
|---|---|---|---|---|
| Ideation/Reporting | 140 | | In review | 9 |
| Planning | 31 | | Ready | 1 |
| Done | 27 | | In progress | 1 |
| | | | Backlog / Rejected | 0 |

The five §5 issues, all open, milestone v1.1, all unassigned:

| Issue | Status today | Open PRs | Closing link |
|---|---|---|---|
| #1258 | In review | #1497 (design) | none — correct for a design PR |
| #1396 | In review | #1450, #1451, #1470 | none to #1396; #1470 → #1260 |
| #975 | Ready | none | — (shipped via #1464, #1493) |
| #1224 | In review | #1477 | → #1224 |
| #1230 | In review | #1495 | → #1230 |

