## Issue workflow (org project 1)

Org **project 1** is the canonical triage surface. Its Status field is a
**forward-only ladder**: an issue enters each state at most once and never
returns to one it has left. Jumping *forward* past states is fine — a one-line
fix can go Ideation/Reporting → In progress in one move; re-entering a state is
not. Status says what stage the work is at; the assignee says whether someone is
at a keyboard on it right now.

| Status | An issue here is… | Assignee |
|---|---|---|
| **Ideation/Reporting** | filed; nobody has decided we will do it | none |
| **Planning** | one we will do, whose shape isn't settled — scope, decomposition, whether it needs a design doc | none |
| **Designing** | one whose design doc is being written | author |
| **Design review** | one whose design PR is open | none |
| **Ready** | shape settled — design merged, or none needed — and free to pick up | none |
| **In progress** | one whose implementation is being written | implementer |
| **In review** | one whose implementation PR is open | none |
| **Done** | shipped and closed | none |
| **Rejected** | one we've decided not to do, and closed | none |

**Design leg** = Designing → Design review. **Implementation leg** = In progress
→ In review. **Ready** is the hinge: the design question is answered, whichever
way — work needing no design skips the design leg entirely. **Rejected** is
reachable from any rung. **Done is terminal**: a regression in shipped work is a
new issue referencing the old one, never a reopen.

| Event | From | To |
|---|---|---|
| Triage accepts it | Ideation/Reporting | Planning |
| Scoping: design doc needed, author takes it | Planning | Designing *(assign)* |
| Scoping: no design doc needed | Planning | Ready |
| Design PR opens | Designing | Design review *(unassign)* |
| Design PR merges | Design review | Ready |
| Implementer picks it up | Ready | In progress *(assign)* |
| Implementation PR opens | In progress | In review *(unassign)* |
| Implementation PR merges | In review | Done *(automatic)* |
| We decide not to do it | any rung | Rejected *(close)* |

**Assignment means one thing: someone is working it right now.** Only Designing
and In progress carry an assignee — never leave one standing as a soft
reservation, and never trust it as the only claim signal. A parent issue is
exempt: it sits in **In progress**, unassigned, from its first child starting
until its last child closes.

- **Pick up**: choose an issue in **Ready** that is unassigned, has no `blocked`
  label, and has no open PR claiming it. The open-PR check is two-pronged,
  because design PRs create no closing link: (1) `closingIssuesReferences` on
  open PRs / the issue's Development panel, and (2) open PRs whose title or body
  mentions `#NNN` and carries a design doc for it. Assignment is dropped when a
  PR opens, so "unassigned" alone does not mean free. Then assign yourself and
  set Status → **In progress** (or **Designing**, if you're writing the design).
- **Re-verify before building**: issue bodies go stale — renames, moved files,
  callers added since filing. Re-run the blast-radius search against current
  `main` before implementing, and comment corrections on the issue (see #300:
  filed against `isMinor`/3 callers, fixed as `isYouth`/10 callers).
- **PR open**: **unassign the issue** and set Status by which leg the PR is on.
  The next action belongs to reviewers, not the author; a standing assignment
  would claim work that isn't happening.
  - **Design-doc PR** → Status **Design review**. Reference the issue WITHOUT a
    closing keyword (plain `#NNN`, "Design for #NNN"). A closing link here would
    auto-close the issue when the doc merges, with nothing implemented.
  - **Implementation PR** → Status **In review**. Use a closing keyword —
    `Fixes #NNN`, `Closes #NNN`, or `Resolves #NNN` — and confirm the link
    registered via `closingIssuesReferences`. Without it the merge closes
    nothing and Status never reaches Done.
- **Not a state change**: a reviewer requesting changes — the PR stays open, the
  status stays put, and the issue stays unassigned while the author revises — or
  a PR being retargeted, rebased, split, or stacked.
- **Merge**: a merged design PR → set Status **Ready** for implementation
  pickup. A merged implementation PR needs nothing manual — the closing keyword
  closes the issue and the project's built-in workflows set Status → Done.
- **Blocked is a label, not a status.** Work waiting on a release, an external
  party, or another issue keeps its status and gains the `blocked` label, with
  the gate named in the issue body. Status tracks progress; blocking toggles,
  and a ladder can't have a rung you step off and back onto.
- **More than one deployable release = more than one issue.** If a design names
  separately deployable releases with an ordering constraint between them, file
  one issue per release before the first one starts, under a parent. Merging to
  `main` only deploys dev — prod cuts from a published release, so two PRs
  merged before one release land in prod together.
- **Rework is the one backward move**, and it is comment-gated. If a PR is
  closed unmerged and the work must be redone, or implementation shows a merged
  design is wrong, move back to Designing / In progress **and comment on the
  issue saying what was abandoned and why**. The status can no longer tell the
  second pass from the first; that comment is what does.

### Iteration and Priority

Status is one field of several, and the ladder says nothing about the rest. Two
of them decide whether an issue is visible at all and what order it gets worked
in.

**Iteration is what the canonical view filters on.** Project 1's default view is
filtered `iteration:@current` (14-day iterations), so an item in no iteration is
invisible there however far up the ladder it has climbed. Set it as the issue
leaves Ideation/Reporting:

- **Planning and beyond** — the current iteration, or a named future one when
  the work is deliberately deferred.
- **Ideation/Reporting** — leave unset. Nothing has been committed to, and a
  triage backlog does not belong in a sprint view.

Work that slips carries to the next iteration. That is a scheduling change, not
a Status change; the two move independently and neither implies the other.

**Priority is an org-level Issue field, not a project field.** It is projected
into project 1, but its options and values live on the organization, so
`updateProjectV2ItemFieldValue` fails against it — use `createIssueFieldValue`,
which also takes a `rationale`. Fill the rationale: it is the only record of why
a ranking was chosen.

**High, Medium and Low are the working set. Never set Urgent.** Urgent means a
human has decided something jumps the queue. Proposing it in a comment is fine;
setting it is not an agent's call.

The two big columns are ranked on different questions, because they are asking
different things:

| Column | Rank by |
|---|---|
| Ideation/Reporting | applicability to the business rules and the app's design — does this fit what the system is for |
| Planning | relative importance against a codebase where every v1.1 feature is already complete |

Size and Estimate are unused. Leave them empty rather than guessing.

### The Ideation/Reporting → Planning bar

This is the highest-traffic gate on the board and the easiest to apply
inconsistently, so the bar is written down rather than left to taste. Read the
item as a product manager would and promote only if it clears the standard for
its kind:

| Kind | Clears when it names |
|---|---|
| Bug report | the observed behaviour, the expected behaviour, and how to reach it |
| Feature request | who it is for, what they cannot do today, and what "done" looks like |
| Chore / refactor | the concrete cost of leaving it alone |
| Question / idea | the decision being asked for, and who can make it |

An item that does not clear its bar stays put — comment saying what is missing
rather than promoting it and discovering the gap at Planning. Promotion claims
the shape is discussable, not that the work is scheduled.

### Working the board

- **Record linkage when you see it.** When an item relates to another issue or a
  PR — superseding, superseded by, blocked on, duplicating, or simply the PR
  that will close it — say so in a comment on the item. Linkage is what the
  ladder cannot encode, and it is how a stale claim gets caught: an issue whose
  only implementation PR was closed unmerged looks identical, from Status alone,
  to one being actively worked.
- **Stamp agent-authored comments.** Anything an agent writes on an issue or a
  PR ends with a line naming the agent that wrote it — `_Posted by <agent>._` —
  so a reader can tell a machine's reading of the code from a human's decision
  about the product. More than one agent works here; the rule fixes the field,
  and each supplies its own name.
- **This board is not automated, deliberately.** No label-mirror sync, no CLI
  wrapper, no bot moving items between states beyond the two built-in workflows
  already in use (Item closed, Pull request merged). The `blocked` label is
  applied and removed by a person. Propose automation if you think it is
  warranted; do not build it.

Project queries need the `read:project` token scope and field writes need
`project`; if GraphQL returns INSUFFICIENT_SCOPES, have the user run
`gh auth refresh -s read:project` or `gh auth refresh -s project`.
