# Documentation migration — getting the corpus to the standard

**Status: WORKING DOC — delete when complete.**
One-time plan for moving the existing ~43 docs, and the years of
undocumented decisions into the shape defined by `DOCUMENTATION_STANDARD.md`.
This file is scaffolding: it follows its own rule and gets deleted when the work
lands.

---

## 1. Evidence

### 1.1 Rules ship without a home

Two examples surfaced during a single design review:

- **The intake-note hold** (since removed — the note no longer gates payment).
  An applicant note held the membership application at background-check review
  so reviewers read it before dues were settled — unless the household already
  held a still-valid background clearance, which took the direct path to
  payment. Stated only in a code comment in
  `checkin-app/src/lib/membership/external.ts`, a parenthetical inside the
  lifecycle transition table, and one aside in `docs/backlog/CUJS.md`.

- **The member-pricing coverage window.** Member program pricing requires the
  membership to cover the program's end date, not merely be active today; a
  program with no end date requires coverage only through its start. Stated only
  in a JSDoc block in `checkin-app/src/lib/orgMembership.ts` — which tags it
  `POLICY (flag for veto)`, so it is an open question that has been shipping as
  behaviour, not a settled decision. It cannot be written into `docs/rules/`
  until the owner answers it.

Neither was skipped through carelessness. There was no file either one belonged
in. A design doc proposing to change both cited the lifecycle doc (mechanics)
and a pricing doc that is itself an unbuilt proposal, and found nothing factual
to check itself against.

### 1.2 The cost is already measured

An existing PR-history analysis distilled **941 PRs (#249–1372)** and labelled
each with the upstream cause that produced it. **216 of them — just under a
quarter — carry a `SPEC`-stage cause:**

| Cause | PRs | What it means |
|---|---|---|
| `scope-miss` | 116 | a rule existed but was not considered |
| `domain-knowledge-gap` | 82 | a rule nobody had written down |
| `auth-unclear` | 31 | an access or approval rule left undecided |

These columns **overlap** — a PR can carry several causes, so they sum to more
than 216. The 216 is the deduplicated union and is the figure to quote. Adding
`data-model-misfit` (34) brings the rule-bearing set to **243**.

Two counting caveats, so the figure is not overclaimed:

- The corpus counts **all** PRs in range, not merged ones. Merged-only over
  #249–1372 is 885 (816 up to #1168, 69 after). The cause labels are what the
  argument rests on, and those are per-PR regardless of outcome — but "941
  merged PRs" would be wrong.
- The labels come from an LLM distillation pass, owner-reviewed in aggregate but
  not line-by-line. Treat 216 as well-founded, not exact.

A second analysis, run independently to answer a different question, points the
same way: 19% of technical fixes trace to spec gaps, money paths worst
(reconciliation, 43%), and of 229 `feat:` PRs only 24% were real features — the
plurality were business misses.

Roughly one PR in four carries a cause that means a rule was not written down
anywhere a person or an agent would look. That is the quantified case for a
rules register, and why §3 mines this history rather than starting blank.

### 1.3 Sprawl

One doc per change means the corpus grows with the PR count and is never pruned.
Docs describing finished work sit next to live proposals, and a reader cannot
tell which files are worth opening without opening all of them.

---

## 2. Step 1 — seed two rules files

Create `docs/rules/membership.md` and `docs/rules/programs.md` from what is
already known, before any mining. Sources:

- the intake-note hold from §1.1. The member-pricing window is **not** seeded —
  it is tagged `POLICY (flag for veto)` and needs an owner answer first.
- `checkin-app/docs/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md` — a domain rules doc
  named after one feature; capacity and scholarship policy folds into
  `programs.md`
- `docs/backlog/CUJS.md` journey A1, which already states several membership
  rules inline

Draft both files with the **Policy / Procedure** split from standard §3.2, even
if the Policy section starts empty — the shape is part of what this step
validates, and an empty Policy heading is an honest signal that nothing has been
traced to a policy yet.

Cut aggressively. Two short files that get read beat six thorough ones that do
not. This step also validates the format before the mining step produces volume.

---

## 3. Step 2 — mine the full PR history for standing rules

**Goal:** recover the decisions that shipped across the repo's history and were
never written anywhere durable. This is the bulk of the value and the only step
that cannot be done incrementally later.

### 3.1 Reuse the existing corpora

Do not re-fetch from scratch. Two corpora already exist, built for different
questions. Both are useful; neither is checked into this repo.

**Primary — the `pr-mining` corpus.** An owner-local working directory holding a
complete, distilled, cause-labelled analysis:

- **941 PRs (#249–1372), 100% distilled** — all PRs in range, merged or not.
  `raw/pr-NNNN.json` is the exported
  PR; `distilled/pr-NNNN.md` is a per-PR summary with YAML frontmatter
  (`claimed_type`, `actual_nature`, `epoch`, `upstream_causes`, `confidence`)
  plus prose sections for *What it actually did*, *Root cause*, *Upstream cause
  analysis*, and *Evidence*.
- `labels.tsv` — one row per PR with cause families and stages already joined.
- `cause-map.tsv` — open-coded phrase → family, so a taxonomy change is a pure
  join and needs no re-LLM pass.
- `scripts/` — the five-phase pipeline (fetch → split → distill → parse →
  label), every stage idempotent and resumable.
- `REPORT.md` — the synthesis; `README.md` — how to reproduce or continue.

This corpus is the right substrate because the distillation already answers the
question this sweep asks. Its `SPEC` stage *is* the "a rule was never written
down" bucket.

**Secondary — the in-repo `analysis/` branch.** Branch
`claude/github-issues-analysis-plan-31f6d4` (commit `0107a949`, unpushed) holds
`pr_facts.jsonl` for 952 PRs and an owner-reviewed 24-category classification
built to answer a different question (what fraction of features were real).
Useful as a cross-check on anything the primary sweep surfaces; not the driver.

**Coverage is current** through #1372; the corpus was topped up and re-labelled.

PRs **#1–248** are deliberately out of scope. They predate the corpus and are
not worth the fetch.

**Reachability — read this before planning around the corpus.** It is
**owner-local by decision** (§8), lives on one machine, and is not in any repo.
No other developer or agent can open it, and the `~/Software/Checkin/pr-mining/`
path in its own `README.md` is stale since the repos moved. The same applies to
the secondary `analysis/` branch, whose commit is unpushed.

That is deliberate: the corpus is a private **input**; the domain rules it
produces are the shared **output**. Nobody should be blocked waiting for access.
But it does mean **only the owner can execute step 2** — if this step needs to
move to someone else, publishing the corpus becomes a prerequisite, not a
detail. `git init` inside it is worth doing regardless, so a long sweep is
resumable and auditable.

### 3.2 Filter to rule-bearing PRs

Most PRs establish no rule. The distilled corpus makes the filter a query rather
than a judgement call — select on stage and family in `labels.tsv`:

| Stage | Family | PRs | Why it bears a rule |
|---|---|---|---|
| SPEC | `scope-miss` | 116 | a rule existed but was not considered |
| SPEC | `domain-knowledge-gap` | 82 | a rule nobody had written down |
| SPEC | `auth-unclear` | 31 | an access or approval rule left undecided |
| PROCESS | `data-model-misfit` | 34 | the model and the policy disagreed |

Families overlap, so do not add the column. The deduplicated set is **243 PRs**
of 941 — that is the sweep. Read each one's *Upstream cause analysis* section;
the rule is usually stated there in plain language already.

```bash
awk -F'\t' 'NR>1 && $5 ~ /scope-miss|domain-knowledge-gap|auth-unclear|data-model-misfit/{print $1}' labels.tsv | sort -un
```

Then check two secondary signals:

- **`half-wired-feature`** (263 PRs, the largest family) — mostly genuine build
  gaps, but a subset are a rule applied on one path and not its siblings. Sample
  rather than read all of them.
- **Churn clusters** — repeated work in one area usually means an unstated rule
  everyone kept guessing at. `REPORT.md` names the ones already found.

Deprioritise entirely: `missing-test-coverage` (238), `pattern-not-followed`
(205), `process-tooling-friction`, `test-infra-reliability`, `none-clean-work`.
These are process and craft findings — real, but they belong in a retrospective,
not in a rules register.

### 3.3 Extract, then discard the source

For each rule-bearing PR, write one candidate rule as a constraint in business
language. Then **drop the PR reference.** The output of this step is rules, not
provenance. Per the standard, no PR number, issue number, or date survives into
`docs/rules/`.

Keep the working extraction list (candidate rule + originating PR) in scratch
during the sweep so duplicates can be spotted — then throw it away. Do not check
it in.

### 3.4 Dedupe and cut

The raw extraction will be far larger than what should ship. Expect to discard
most of it:

- Collapse restatements of the same rule into one line.
- Drop anything that is mechanism, not policy.
- Drop anything a reader would derive from the code.
- Drop rules that are no longer true — verify against current `main`, not
  against the PR that introduced them.

**Judge by the §3.3 test in the standard, not by length:** keep a line only if a
later change could violate it. A sweep over hundreds of PRs will over-produce —
if a domain comes out with dozens of rules, it has almost certainly captured
mechanism rather than policy, so re-apply the test before accepting the volume.
Splitting the file is not the fix.

### 3.5 Classify each rule

Standard §3.2 gives every domain file three sections: **Policy**, then
**Assumptions**, then **Procedure**. Classify as you write, reading the policy
text alongside the mined rule rather than deferring every judgement to a later
pass. The corpus is available (§3.6), so the tier is answerable at the moment
the rule is drafted.

What still needs care:

- **Never promote to Policy without reading the article.** Search the corpus for
  the rule, not for the topic. Several candidates in the first sweep read as
  obviously policy-backed and turned out not to be — the college-age dependent
  rule among them, where the policy defines a term that sounds right and covers
  something narrower.
- **Cite by policy name and article or section.** Never a page, a path, or a
  URL. A citation should break when the policy is amended, which is exactly when
  it should be re-read.
- **A rule stricter than its policy says so.** The risk is a later reader
  relaxing it while believing they are aligning to policy.
- **Anything holding only because someone outside the app maintains it is an
  Assumption**, not a Procedure line and not a divergence.

**A rule can also be none of the three.** Where a candidate turns out to be the
app implementing a policy more loosely than the policy states, it is a
divergence: it goes in the domain file's closing section (standard §3.7) and is
also tracked as work. Recording it does not resolve it, and it is not a feature
request — what closes it is the policy.

### 3.6 The policy corpus

Canonical policies live on **Google Drive** (standard §3.5), and a complete
download of them is available locally to work from. That download is what makes
§3.5 possible in one pass rather than two.

- **Check the download's provenance once, at the start of a sweep.** It is sound
  while it is a current export; the failure it guards against is a copy taken
  before an amendment, which would enshrine a superseded rule behind a citation
  that reads as correct.
- **Citations stay verifiable.** Anyone with Drive access can check a policy-tier
  rule against the policy it names — unlike the PR corpus (§3.1), this input is
  not owner-only, so the tier carries real weight.
- **Read the surrounding article, not the matching line.** Definitions carry
  scope that a keyword match hides: a term may be defined more narrowly than its
  everyday sense, and a rule built on the everyday sense will cite an article
  that does not support it.

### 3.7 The second source — session transcripts

A PR diff cannot record a decision that produced no diff, and cannot show a road
deliberately not taken. Session transcripts can. Mining them as a second,
independent pass yields a different kind of rule: the rejected alternative, the
thing settled in conversation and never built, the reason behind a number.

Run it after the PR sweep, diffed against the drafts, so each finding arrives
attached to the line it bears on. Two properties of that output govern how it is
used:

- **A report describing a decision is more reliable than one describing a
  mechanism.** Decisions hold; mechanisms get settled after the conversation
  that discussed them. Several findings in the first pass asserted the opposite
  of what shipped, all of them mechanism.
- **"No counterpart in the draft" and "cut on purpose" are indistinguishable
  from outside.** Only whoever ran the earlier review can tell them apart, which
  is why this pass hands findings over rather than applying them.

**Verify every finding against the current tree before folding it.** Not the
schema alone — the enforcement path. A state can be derived rather than stored,
and a behaviour can live in a function rather than a column; searching for a
field name and concluding "not built" is the specific mistake to avoid. This
verification is worth its cost independently: the first pass surfaced two
defects the reports had not found, both while checking something else.

### 3.8 Owner review

The register states board and operations decisions. A rule inferred from a diff
or a transcript is a *candidate* until the owner confirms it. Present each
domain file for review before it merges — grouped by what you propose to do with
each finding, including the ones you propose to reject, since a silent rejection
is invisible to the person reviewing. Some candidates will turn out to be
accidents of implementation rather than decisions, and those must not be
enshrined as rules.

**Present, then wait.** Do not fold a domain while the answer is outstanding,
and do not read "go ahead" on one domain as approval of the next. The rule is
not ceremony: both times it was skipped during the first sweep, rules reached
the register that the owner then had to catch — including one describing a kind
of person the app does not have.

---

## 4. Step 3 — update AGENTS.md — **done**

- ~~Point the docs map at `docs/rules/` first~~ — a "Domain rules — read first"
  block now opens the map, carrying the escalation rule for Policy-tier lines.
- ~~Reference `DOCUMENTATION_STANDARD.md`~~ — cited in the same block, alongside
  `docs/conventions.md`. README's start-here list points at both.
- ~~Resolve the CUJS ambiguity~~ — **deleted `docs/designs/CUJS.md`**, nothing
  merged. It was a route table snapshot whose routes no longer exist (`/admin/*`
  predates the `*-ops` split), and every journey in it is covered per-step and
  state-tagged in `docs/backlog/CUJS.md`. AGENTS.md and README now point there.

One entry of the map is deliberately **not** yet rewritten: the
"Design & product (`docs/designs/`)" block. Step 4 empties that directory, so
the block is rewritten once, there — not twice.

---

## 5. Step 4 — empty out the `designs/` directories

Both `docs/designs/` and `checkin-app/docs/designs/` conflate three things with
different lifetimes. Every file goes to one of three places, and **the `designs/`
directories are then deleted** — which also avoids a `designs/` vs `in-design/`
name collision.

**→ `docs/in-design/`** — unbuilt proposals. These are working docs by another
name: `SHOPIFY_MEMBER_SEGMENT_PRICING.md`, `MEMBERSHIP_SYNC.md`,
`PROGRAM_INSTANCE_RESTRUCTURE.md`, `resilient-load-swr.md`, and the numbered set
(`167-`, `354-`, `975-`, `1224_`, `1256_`, `1333-`). They keep their normal
lifecycle from here: extract and delete when they land, delete outright when
abandoned.

`1149_` has already been through that lifecycle and is gone: its standing rule is
`docs/conventions.md`, "A day is not a moment", and the unbuilt remainder is
tracked as backlog PL17.

**→ `docs/ops/`** — operational reference that stays true and has no rules-file
home: `DEV_INSTANCE_DESIGN.md`, `DEV_DASHBOARD_DESIGN.md`,
`ZOHO_SIGN_DEV_MOCK.md`, `SHOPIFY_DEV_STORE_WEBHOOK.md`.

A doc that is mostly mechanism can still hold standing rules, and the ops bucket
is not a way to avoid looking: `docs/ops/lifecycle-machines.md` carries the
regeneration and drift-guard procedure, while the rules under it sit in
`docs/conventions.md` and the domain registers.

**→ extract, then delete** — shipped feature docs: `INDEX_PAGE_SCOPING.md`,
`ARCHITECT_IDEAS_o46.md`, `DESIGN.md`. Check each for standing rules first; most
will yield none.

**`PRODUCTION_PLAN.md` moves to `docs/ops/` — do not delete it.** Despite the
name it is the live "Production Launch Runbook" for ops.innovationtreehouse.org:
an ordered cutover checklist with open items (trust-policy verification,
release-gate roster, ECR/ECS task-definition names). Extraction yields no rules,
so the extract-and-delete bucket would destroy the only deploy/rollback runbook.
The ops-bucket definition already covers it.

**Unresolved, decide during the sweep:** `UNFINISHED.md` (a deferred-decision
ledger; arguably belongs in `in-design/`, arguably its own thing). `CUJS.md` is
settled — resolved in step 3, one copy left.

**Leave alone entirely:** `docs/security/`, `checkin-app/docs/generated/`,
`docs/backlog/`, and the deploy/migration docs under `checkin-app/docs/`.

**`checkin-app/docs/VOCABULARY.md` stays where it is, but three kinds of content
leave it.** It is the canonical dictionary and should remain one; it currently
also carries:

- **Build conventions** — that identifiers and prose use the canonical word, that
  a serialized wire key is a contract rather than a free rename, that age is
  always derived through the shared helper. These belong in `docs/conventions.md`.
- **A migration log** — the rename status section and the model-rename pattern
  note, which cites PR numbers and git history. That is a lesson from past work;
  per the standard it belongs in a design doc, not in a reference someone opens
  to look up a term.
- **Domain facts filed as "reference facts"** — the membership year, which is a
  policy fact; the single facility and the integration vendors, which are
  operating assumptions. Defined terms among them, such as *Treehouse Card*,
  stay.

Rules embedded in its tables move the same way — the per-tool versus global
certifier grant, age gates enforced outside the software, core volunteers'
authority being organisational.

**This is already duplicated, not hypothetical.** The rules register now states
the single facility and the certifier grant, both of which also remain in the
dictionary. Resolving that is part of this step, not a follow-up.

That covers content leaving the dictionary. Content flowing the other way —
terms whose definitions are also constraints — is open question 3 in §8, and is
not settled by this step.

### 5.1 Reference sweep — do this BEFORE any move or delete

Deleting or moving a doc that other files cite leaves dead pointers. There are
currently **63 references to `docs/designs/…`** across `checkin-app/src`,
`.github/`, `README.md`, and `AGENTS.md` — README front-page links and the
AGENTS.md instruction to read `DEV_INSTANCE_DESIGN.md` before touching auth/env
among them.

```bash
grep -rn "docs/designs/" checkin-app/src .github README.md AGENTS.md docs
```

Every hit is updated to the new path, or removed if its target is being deleted.
The sweep is part of the same change as the move — never a follow-up.

**A reference can be baked into a generated artifact.** `artifacts.ts` renders the
header of every file under `docs/generated/lifecycle/`, and `artifactsDrift.test.ts`
asserts byte-equality against the checked-in copies. Changing a path a renderer
emits therefore takes one commit carrying the renderer edit, a re-run of
`npm run generate:lifecycle-artifacts`, and the regenerated files.

Edit the string without regenerating and CI goes red on a confusing docs-path
diff; skip the edit and the drift-tested, "do not hand-edit" artifacts ship a
path that no longer exists — the one document class the standard calls
machine-verified would be provably wrong. Where the header does not need the
pointer, drop it rather than repoint it: a path that isn't emitted cannot rot.

---

## 6. Step 5 — fix the root-vs-app split

`docs/` at the repo root and `checkin-app/docs/` both hold app design docs, and
the line is violated in both directions (`MEMBERSHIP_SYNC.md` is app design at
the root; `PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md` is app mechanics under
`checkin-app/`).

Proposed rule: repo root holds product, policy, and cross-cutting process;
`checkin-app/docs/` holds app-implementation reference. Mechanical once agreed —
do it last, after the rules register exists, so nothing moves twice.

---

## 7. Done when

- `docs/rules/` holds the domain files, each owner-reviewed, every line a rule a
  change could violate.
- **Every domain file carries the Policy / Procedure split**, policy above
  procedure, and every policy-tier rule cites a policy by name and
  article/section — no page numbers, no filesystem paths.
- **Any contradiction found between code and policy has been raised with the
  owner**, not silently recorded as a rule.
- AGENTS.md points at the register and at `DOCUMENTATION_STANDARD.md`.
- No `Status: SHIPPED` feature docs remain outside `docs/ops/`.
- `docs/designs/` and `checkin-app/docs/designs/` no longer exist.
- **`grep -rn "docs/designs/" checkin-app/src .github README.md AGENTS.md docs`
  returns nothing.**
- **`npm run generate:lifecycle-artifacts` produces no diff**, and
  `artifactsDrift.test.ts` passes.
- **`PRODUCTION_PLAN.md` is in `docs/ops/`**, not deleted.
- Only one `CUJS.md`.
- This file is deleted.

---

## 8. Open questions

1. **Domain list.** Are the six in the standard the right cut, or do membership
   and finance-payments collapse into one?
2. **Who owns a rules file?** CODEOWNERS on `docs/rules/` would route rule
   changes to the board or owner automatically. Worth it, or too heavy?
3. **Where a definition is also a constraint.** Several terms are stated in both
   the vocabulary register and the rules register: two deep, tripod, member
   family, adult, youth, student, visitor, the tool levels and their age
   minimums. Some of these constrain behaviour — code counting bare adults
   violates what "two deep" means, which is a divergence the rules register
   already records — and some only fix a word.

   The tempting split is to leave the name in the dictionary and move the
   constraint to the rules. **That makes the dictionary worse**: someone looking
   up "member family" and getting the name without the two-adult cap has been
   given a partial answer, which is the one thing a dictionary must not do.

   So the duplication may be correct — each register complete for its own
   purpose, overlapping by design — and the real question is how the two stay in
   step rather than how to divide them. Needs a decision with the vocabulary
   owner present, not one taken during a sweep.

**Decided:**

- **Working docs live with the change, in its PR** — not in `docs/backlog/`,
  which is an inventory rather than a staging area. Recorded in the standard.
- **No epoch cutoff on the mine.** The epoch boundary (2026-07-03) marks the
  start of production, not a break in what is true. Rules established before it
  remain valid; only the *character* of PRs changed, from major-refactoring work
  to fixes found against a live app. Mine the whole corpus.
- **No #1–248 backfill.** Out of scope; the corpus starts at #249.
- **Corpus stays local.** `pr-mining` is an owner-local input; only the rules it
  produces are shared. Revisit only if a second sweep needs to reproduce this one.
