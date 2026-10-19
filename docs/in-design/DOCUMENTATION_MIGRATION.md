# Documentation migration: getting the corpus to the standard

This working doc plans the one-time move of the existing docs into the classes
`DOCUMENTATION_STANDARD.md` defines. It is deleted by the last PR in §4.

The rules register, the reorganised `AGENTS.md` map and most of the ops moves
are on `main`. What remains is to empty both `designs/` folders, split the
vocabulary, finish two domain files, and settle the questions in §7. Section 4
breaks that into PRs small enough to hand to one session each.

State in this doc was checked against `main` at `bf17f8610` on 2026-10-16.

---

## 1. Why

About one PR in four in the history up to #1372 traces to a rule nobody had
written down where a person or an agent would look. One doc per change made the
corpus grow with the PR count, with finished work next to live proposals and no
way to tell them apart without opening each file. The register fixes the first
problem; emptying `designs/` fixes the second.

---

## 2. What is already done

- **The rules register.** `docs/rules/` holds `principles.md` and nine domain
  files, mined from the PR history and session transcripts and checked against
  the tree. The capacity and scholarship rules from
  `docs/architecture/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md` are in `programs.md`.
- **`AGENTS.md`.** The docs map opens with the register and cites the standard.
  One `CUJS.md` remains, in `docs/backlog/`.
- **Ops moves.** `docs/ops/` holds the dev instance, the lifecycle machines, the
  background-check and contract-signing mocks, the Shopify mirror and live
  tests, and the legacy-cleanup ledger.
- **Earlier proposals.** `MEMBERSHIP_SYNC.md` is in `docs/in-design/`; the
  numbered docs `167-`, `354-`, `1149_` and `1224_` are retired.

---

## 3. Current state of what remains

Every file still in a `designs/` folder, plus the non-folder work, with the PR
in §4 that finishes it. "In flight" means another session or open PR owns it and
this plan does not.

Working docs already in `docs/in-design/` that other sessions own are out of
this plan's scope: `1265_`, `1272_`, `1280_`, `1283_`, `2180_`, `2182_`,
`TOMBSTONE_REMOVAL.md` and `PROGRAM_MEMBERSHIP_YEAR`. No PR here edits them;
where a move breaks one of their pointers, that doc's session gets the new path
(§5).

### 3.1 `docs/designs/`

| File | Action | Status |
|---|---|---|
| `ARCHITECT_IDEAS_o46.md` | Still-open items became backlog rows PL18–PL26; deleted | done, PR 2 |
| `COMPONENT_ARCHITECTURE.md` | Standing architecture reference; moves to `docs/architecture/` (Q4) | todo, PR 4 |
| `DESIGN.md` | Use cases checked against the register; three missing rules added to `attendance-checkin.md` and `people-households.md`; deleted | done, PR 2 |
| `PRODUCTION_PLAN.md` | The app is live, so only its deploy and rollback runbook moves, to `docs/ops/production-runbook.md`; unfinished follow-ups become issues; the launch checklist is dropped (Q7) | todo, PR 3 |
| `PROGRAM_INSTANCE_RESTRUCTURE.md` | Active working doc; leaves `docs/designs/` for `docs/in-design/` | in flight, its own session |

### 3.2 `checkin-app/docs/designs/`

| File | Action | Status |
|---|---|---|
| `1256_ATTENDANCE_CORRECTION_SURFACE.md` | Retire | in flight, #2275 |
| `975-LEGACY_VARIANT_CONTRACT.md` | Retire | in flight, sibling session |
| `1441_PROGRAM_DATES.md` | Retire | in flight, #2262 |
| `1333-EMAIL_TEMPLATES.md` | Not built; move to `docs/in-design/` | done, PR 1 |
| `SHOPIFY_DEV_STORE_WEBHOOK.md` | Ops reference; move to `docs/ops/shopify-dev-store.md`, keeping the §2, §4 and §6 numbering that code cites | done, PR 1 |
| `SHOPIFY_MEMBER_SEGMENT_PRICING.md` | Not built; move to `docs/in-design/` | done, PR 1 |
| `UNFINISHED.md` | Follow-up ledger behind issue #1322; each non-sensitive open item becomes an issue, then the file is deleted (Q5) | done, PR 5 |
| `resilient-load-swr.md` | Not built; move to `docs/in-design/` | done, PR 1 |
| `UNIFIED_SIGNUP.md` (not on `main`) | Open PR #1370 adds it here; if it goes ahead it belongs in `docs/in-design/` | open PR, its author's call |

### 3.3 Outside the folders

| Work | Action | Status |
|---|---|---|
| `VOCABULARY.md` | Build conventions to `docs/conventions.md`; drop the migration log; domain facts to the register or cut where already there (§3.4); then to `docs/VOCABULARY.md` (Q6) | done, PR 6 and the DM-6 PR |
| `docs/rules/expenses.md`, `inventory.md` | No Policy section yet; check the policy corpus and add one, even if empty | todo, PR 7, after #2224 |
| Pointers to docs already gone | Comments citing `BADGE_AUDIT.md`, `auth-first-registration.md` and `PROGRAM_PAYMENT_VISIBILITY.md` | backlog pointer done, PR 2; source comments todo, PR 8 |
| Root-vs-app split | Per Q6: `DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md` and `MIGRATION_COALESCE_FLOW.md` to `docs/ops/`, `VOCABULARY.md` to `docs/`, `PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md` to `docs/architecture/`, the lifecycle diagrams to `docs/generated/lifecycle/`; `UNFINISHED.md` stays until PR 5 deletes it, and `checkin-app/docs/` goes with it | done, the DM-6 PR |
| `AGENTS.md` "Design & product" block | Rewritten as an Operations block once its last entry moves | todo, PR 3 |

### 3.4 What the vocabulary split moves

`VOCABULARY.md` stays the dictionary. Three kinds of content leave it:

- **Build conventions.** The canonical word in identifiers and prose, a wire key
  as a contract, age derived through the shared helper. These go to
  `docs/conventions.md`.
- **The migration log.** The "Migration status" section and the model-rename
  pattern note. Git history keeps them; the two links to `UNFINISHED.md` become
  a pointer to issue #1322.
- **Domain facts.** The membership year is a policy fact for `membership.md`; the
  single facility is already in `attendance-checkin.md`; the integration vendors
  are operating assumptions. *Treehouse Card* is a defined term and stays.

Rules inside its tables leave the same way: the per-tool certifier grant (already
in `tools-certification.md`), age gates enforced outside the software, and core
volunteers' authority being organisational. Where the register already states a
rule, both keep a complete statement (Q3): the dictionary keeps the definition
with its constraint, and the register keeps the rule.

---

## 4. PR plan

Each PR below is one session. None touches a security boundary file: no
`docs/designs/` reference remains in `checkin-app/src/security/` or
`middleware.ts`, and #2263 owns the comment sweep there.

PRs 1, 2, 6 and 8 can start now and run in parallel. Where two PRs edit the same
file the table names it; the second one rebases, and since every edit is a
different line that rebase is mechanical.

| PR | What | Files | Reference sweep | Waits on |
|---|---|---|---|---|
| 1 | **Pure moves.** No content edits beyond paths | `git mv` of `SHOPIFY_MEMBER_SEGMENT_PRICING.md`, `1333-EMAIL_TEMPLATES.md`, `resilient-load-swr.md` to `docs/in-design/`; `SHOPIFY_DEV_STORE_WEBHOOK.md` to `docs/ops/shopify-dev-store.md` | `src/lib/shopify.ts`; `PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md` (two lines); `api/dev/shopify/orders-paid/route.ts` and its integration test; `app/dev/shopify/page.tsx`; `components/pageRegistry.ts` (the `/dev/shopify` row); `PRODUCTION_PLAN.md`; `1655_MEMBERSHIP_YEAR_DECLARED.md` and its `-migration.md`; links between the moved files | #2264 and the 975 session, which both edit `1655_MEMBERSHIP_YEAR_DECLARED.md`; the restructure doc's session, whose doc cites the segment-pricing path |
| 2 | **Retire shipped docs in `docs/designs/`.** Extraction | delete `ARCHITECT_IDEAS_o46.md` and `DESIGN.md`; edit `docs/conventions.md`, `docs/backlog/INDEX.md`, any `docs/rules/` file a use case adds to (not `expenses.md`) | `README.md` (the design-spec link); `AGENTS.md` (the `DESIGN.md` and `ARCHITECT_IDEAS` lines); the dead `PROGRAM_PAYMENT_VISIBILITY.md` pointer in `INDEX.md` | owner review of any rule added (§5) |
| 3 | **Production runbook to ops** | `git mv` to `docs/ops/production-runbook.md`, keeping only the deploy and rollback runbook; file each unfinished follow-up as an issue; drop the launch checklist (Q7) | `README.md` (the runbook link); `docs/ops/shopify-dev-store.md`; `AGENTS.md`, where this PR also replaces the "Design & product" heading with an Operations block listing `dev-instance.md`, the runbook and the dev store | PR 1, PR 2 |
| 4 | **Architecture reference** | move `COMPONENT_ARCHITECTURE.md` into `docs/architecture/` (Q4); the DM-6 PR created the folder and added its §2 row to the standard | `docs/rules/inventory.md`; `docs/backlog/INDEX.md`. Pointers in `1265_`, `1272_`, `1280_` and `1283_` (including the `RECEIPT.md` and `EXPENSE_QB.md` files `1265_` and `1272_` plan under `docs/designs/`, which now belong in `docs/architecture/`) belong to those docs' sessions | those sessions repointing or retiring their docs first |
| 5 | **Retire `UNFINISHED.md`** (Q5) | file each non-sensitive open item as a GitHub issue (the admin-role item maps to #1318); take any sensitive item to the owner instead; drop the dismissed list, which git keeps; delete the file | `docs/backlog/INDEX.md` (two rows); `docs/security/auth-consistency-analysis.md` | PR 6 (removes the vocabulary's links); the restructure doc's session (`UNFINISHED.md` links to its doc) |
| 6 | **Vocabulary split** (§3.4). Extraction | `VOCABULARY.md`; `docs/conventions.md`; `docs/rules/membership.md`, and any other register file a moved rule lands in; the standard, which gains the Q3 rule that a change to a term in either the dictionary or the register edits both in the same PR | none beyond the file's own links | owner review of any rule added; rebase on PR 2 for `conventions.md` |
| 7 | **Policy sections for `expenses.md` and `inventory.md`** | those two files | none | #2224; needs the policy corpus on Drive, so the owner or a session the owner gives access runs it |
| 8 | **Dead pointers in source** | `components/ui/CountBadge.tsx`; `api/household/intake/route.ts`; `lib/intake/profiles.ts`: drop the citation of a doc that no longer exists, or point at the rules file that now states it | n/a | nothing |
| 9 | **Close-out** | settle step 5 per Q6; add `inventory.md` to the standard's §3 table; remove the standard's pointer to this doc; delete this doc | run the §5 checks; confirm the sweeps by the sessions in §3 left nothing | every PR above, and every in-flight owner in §3 |

Q2 is with the Board. Once it answers, a one-line CODEOWNERS PR for
`docs/rules/` can land any time; it edits `.github/CODEOWNERS` only.

Every rules file also gets a fresh owner review before the close-out (Q8). That
is review, not a PR of its own; a change it asks for lands in whichever PR above
touches that file, or in a small one.

---

## 5. Rules every PR here follows

- **Sweep in the same change.** A move or delete updates every pointer to the
  file in the same PR, never in a follow-up. Search by name as well as path,
  because some pointers name the file without a folder.
- **Never edit an applied migration.** Four files under
  `checkin-app/prisma/migrations/` cite `docs/designs/`. Prisma checksums
  applied migrations, so those comments stay as they are and the checks below
  exclude that folder.
- **A pointer inside a doc another session owns is that session's to change.**
  The PR that moves the target tells the coordinator the new path and waits
  until the owning doc is repointed or retired.
- **Nothing new lands in a `designs/` folder.** A working doc that plans a
  reference file names its home under the standard (`docs/ops/` or
  `docs/architecture/`).
- **Extraction follows the register's rules.** Verify each candidate rule
  against the current tree, enforcement path included; write it as a
  constraint, with no PR or issue numbers; present the candidates to the owner,
  including those you propose to drop, and wait for an answer before merging.
  Extracting nothing is a normal outcome.
- **No tests run for a docs-only PR.** PR 8 edits comments only.

---

## 6. Done when

- `git grep -n "designs/" -- . ':!checkin-app/prisma/migrations'` returns only
  this doc's own lines, and nothing once this doc is deleted.
- `git grep -nE "ARCHITECT_IDEAS|PRODUCTION_PLAN|UNFINISHED\.md|COMPONENT_ARCHITECTURE"`
  returns only the new homes' own pointers.
- `docs/designs/` and `checkin-app/docs/designs/` do not exist.
- The production runbook is in `docs/ops/`.
- Every domain file has Policy, Assumptions and Procedure sections, in that
  order, and the owner has reviewed it (Q8).
- Any contradiction found between code and policy has gone to the owner rather
  than into the register as a rule.
- This file is deleted.

---

## 7. Open questions

IDs are stable; a resolved question keeps its number.

1. **Domain list.** Decided: keep the nine domain files as they are. PR 9 adds
   `inventory.md` to the standard's table.
2. **Who must approve a register change.** With the Board. The question as sent:
   who must approve a change to a `docs/rules/` file. The CODEOWNERS PR (§4)
   follows its answer.
3. **A definition that is also a constraint.** Decided: yes, the overlap is
   correct. Terms such as two deep, member family, youth and the tool levels
   stay complete in both the dictionary and the register, and the standard
   requires a change to either one to edit both in the same PR (PR 6).
4. **Where a standing architecture doc goes.** Decided: a new `docs/architecture/`
   folder, a long-lived class edited when the shape changes. It takes
   `COMPONENT_ARCHITECTURE.md` and the receipt and QuickBooks references two
   working docs plan (PR 4).
5. **What happens to `UNFINISHED.md`.** Decided: every non-sensitive open item
   becomes a GitHub issue, then the file is deleted (PR 5).
6. **Does `checkin-app/` keep a docs folder?** Decided (DM-6, 2026-10-18): no.
   The eventual plan makes `checkin-app` a thin shell, with check-in and
   membership as libraries the way inventory is. The libraries keep no docs of
   their own, so the proposal is that `checkin-app` keeps none either:
   `DEPLOY_MIGRATION_ORDER_OF_OPERATIONS.md` and `MIGRATION_COALESCE_FLOW.md` go
   to `docs/ops/`, `VOCABULARY.md` to the `docs/` top level after its split
   (PR 6), and `PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md` to `docs/architecture/`.
   The lifecycle diagrams go to `docs/generated/lifecycle/`, where the generator
   now writes them. The DM-6 PR carries the moves and
   their reference sweep.
7. **Is the production launch finished?** Decided: yes; the app is live, with
   membership in production. Only the deploy and rollback runbook moves to
   `docs/ops/`, unfinished follow-ups are filed as issues, and the launch
   checklist is dropped (PR 3).
8. **Has every domain file had its owner review?** Decided: no file can count an
   earlier review. All nine domain files in `docs/rules/` (counting
   `principles.md`), and its README, have changed since 2026-10-14;
   `expenses.md` is new, and `revenue.md` is `finance-payments.md` renamed and
   extended. Each gets a fresh owner review before the close-out.
