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
  `checkin-app/docs/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md` are in `programs.md`.
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
| `ARCHITECT_IDEAS_o46.md` | Still-open items (#15 no error boundary, #17 no Zod, and any others still true) become backlog rows; delete | todo, PR 2 |
| `COMPONENT_ARCHITECTURE.md` | Standing architecture reference; moves to the home Q4 decides | todo, PR 4, blocked on Q4 |
| `DESIGN.md` | Check each use case against the register; add any missing rule; delete | todo, PR 2 |
| `INDEX_PAGE_SCOPING.md` | Extract and delete | in flight, its own planning session |
| `PRODUCTION_PLAN.md` | Move to `docs/ops/production-runbook.md` with a freshness pass; never delete | todo, PR 3, see Q7 |
| `PROGRAM_INSTANCE_RESTRUCTURE.md` | Active working doc; leaves `docs/designs/` for `docs/in-design/` | in flight, its own session |

### 3.2 `checkin-app/docs/designs/`

| File | Action | Status |
|---|---|---|
| `1256_ATTENDANCE_CORRECTION_SURFACE.md` | Retire | in flight, sibling session (#2261 also edits it) |
| `975-LEGACY_VARIANT_CONTRACT.md` | Retire | in flight, sibling session |
| `1441_PROGRAM_DATES.md` | Retire | in flight, #2262 |
| `1333-EMAIL_TEMPLATES.md` | Not built; move to `docs/in-design/` | todo, PR 1 |
| `SHOPIFY_DEV_STORE_WEBHOOK.md` | Ops reference; move to `docs/ops/shopify-dev-store.md`, keeping the §2, §4 and §6 numbering that code cites | todo, PR 1 |
| `SHOPIFY_MEMBER_SEGMENT_PRICING.md` | Not built; move to `docs/in-design/` | todo, PR 1 |
| `UNFINISHED.md` | Follow-up ledger behind issue #1322; fate per Q5 | todo, PR 5, blocked on Q5 |
| `resilient-load-swr.md` | Not built; move to `docs/in-design/` | todo, PR 1 |
| `UNIFIED_SIGNUP.md` (not on `main`) | Open PR #1370 adds it here; if it goes ahead it belongs in `docs/in-design/` | open PR, its author's call |

### 3.3 Outside the folders

| Work | Action | Status |
|---|---|---|
| `checkin-app/docs/VOCABULARY.md` | Build conventions to `docs/conventions.md`; drop the migration log; domain facts to the register or cut where already there (§3.4) | todo, PR 6 |
| `docs/rules/expenses.md`, `inventory.md` | No Policy section yet; check the policy corpus and add one, even if empty | todo, PR 7, after #2224 |
| Pointers to docs already gone | Comments citing `BADGE_AUDIT.md`, `auth-first-registration.md` and `PROGRAM_PAYMENT_VISIBILITY.md` | todo, PR 2 and PR 8 |
| Root-vs-app split | Per Q6 | todo, PR 9 |
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
rule, the dictionary keeps the definition and drops the constraint only if Q3
allows it; otherwise both stay and the PR says so.

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
| 3 | **Production runbook to ops** | `git mv` to `docs/ops/production-runbook.md`; freshness pass per Q7 | `README.md` (the runbook link); `docs/ops/shopify-dev-store.md`; `AGENTS.md`, where this PR also replaces the "Design & product" heading with an Operations block listing `dev-instance.md`, the runbook and the dev store | PR 1, PR 2, Q7 |
| 4 | **Architecture reference** | move `COMPONENT_ARCHITECTURE.md` per Q4; add the new class to the standard's §2 table | `docs/rules/inventory.md`; `docs/backlog/INDEX.md`. Pointers in `1265_`, `1272_`, `1280_` and `1283_` (including the `RECEIPT.md` and `EXPENSE_QB.md` files `1265_` and `1272_` plan under `docs/designs/`) belong to those docs' sessions | Q4; those sessions repointing or retiring their docs first |
| 5 | **Retire `UNFINISHED.md`** per Q5 | delete it; file or fold its open items as Q5 decides | `docs/backlog/INDEX.md` (two rows); `docs/security/auth-consistency-analysis.md` | Q5; PR 6 (removes the vocabulary's links); the restructure doc's session (`UNFINISHED.md` links to its doc) |
| 6 | **Vocabulary split** (§3.4). Extraction | `VOCABULARY.md`; `docs/conventions.md`; `docs/rules/membership.md`, and any other register file a moved rule lands in | none beyond the file's own links | owner review of any rule added; rebase on PR 2 for `conventions.md` |
| 7 | **Policy sections for `expenses.md` and `inventory.md`** | those two files | none | #2224; needs the policy corpus on Drive, so the owner or a session the owner gives access runs it |
| 8 | **Dead pointers in source** | `components/ui/CountBadge.tsx`; `api/household/intake/route.ts`; `lib/intake/profiles.ts`: drop the citation of a doc that no longer exists, or point at the rules file that now states it | n/a | nothing |
| 9 | **Close-out** | settle step 5 per Q6; add `inventory.md` to the standard's §3 table; remove the standard's pointer to this doc; delete this doc | run the §5 checks; confirm the sweeps by the sessions in §3 left nothing | every PR above, and every in-flight owner in §3 |

If Q2 is answered yes, a one-line CODEOWNERS PR for `docs/rules/` can land any
time; it edits `.github/CODEOWNERS` only.

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
  reference file names its home under the standard (`docs/ops/`, or Q4's answer).
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
- `git grep -nE "ARCHITECT_IDEAS|INDEX_PAGE_SCOPING|PRODUCTION_PLAN|UNFINISHED\.md|COMPONENT_ARCHITECTURE"`
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

1. **Domain list.** The register has nine domain files, two more than the
   standard's table. Keep the nine as they are? *Recommendation: yes, and PR 9
   adds `inventory.md` to the standard's table.*
2. **Who owns a rules file.** Should CODEOWNERS route changes under
   `docs/rules/` to the owner automatically? *Recommendation: yes, the owner
   only. Owner confirmation of each new rule is already required, and this makes
   the review request automatic instead of remembered.*
3. **A definition that is also a constraint.** Terms such as two deep, member
   family, youth and the tool levels appear in both the dictionary and the
   register. Moving the constraint out leaves the dictionary entry incomplete,
   so the overlap may be correct. Is it? *Recommendation: keep both complete,
   and have the standard require a change to either one to edit both in the same
   PR. Needs the vocabulary owner present.*
4. **Where a standing architecture doc goes.** `COMPONENT_ARCHITECTURE.md`
   describes how the component libraries are built and is current. It is not a
   rule, not an ops runbook and not a working doc, so no class in the standard
   fits it, and two working docs already plan more files like it (receipt and
   QuickBooks references). Where should it go? *Recommendation: add a
   `docs/architecture/` class to the standard, long-lived and edited when the
   shape changes, and put all three there.*
5. **What happens to `UNFINISHED.md`.** It is the body of issue #1322: open
   rename decisions, mechanical fixes, and a list of things checked and
   dismissed. The standard has no class for a ledger. *Recommendation: move each
   still-open item into the tracker (one issue per decision, or the body of
   #1322; the admin-role item maps to #1551), drop the dismissed list, which git
   keeps, and delete the file.*
6. **Is step 5 still needed?** The plan was to split root docs from app docs.
   The standard's class table now places every class, and what remains under
   `checkin-app/docs/` is app reference: the deploy and migration docs, the
   dictionary, the generated artifacts, and the capacity and scholarship
   mechanics, whose rules are already in `programs.md`. *Recommendation: close
   step 5 with no moves.*
7. **Is the production launch finished?** `PRODUCTION_PLAN.md` is a launch
   checklist last verified on 2026-07-13, with open items. If the launch is
   done, its sequence is history. *Recommendation: if done, keep only the
   release, rollback and still-open follow-ups in `docs/ops/production-runbook.md`;
   if not, move it whole and mark each step's state.*
8. **Has every domain file had its owner review?** The done list needs it.
   *Recommendation: confirm per file; `expenses.md` and `inventory.md` get theirs
   with PR 7.*
