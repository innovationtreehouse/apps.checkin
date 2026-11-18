# Comment rules: rationale

Why the contested rules in [comment-rules.md](comment-rules.md) say what they say, keyed by the
same `C<n>` numbers. Read this to change a rule; read that one to follow one.

Nothing here is normative. Where this file and the rules disagree, the rules win and this one
is stale.

**Past evidence is deliberate here.** This file records why a rule reads as it does, so a path
that no longer exists, a name since changed, and a draft that turned out wrong are the
substance rather than rot. C1, C4 and C21 govern source comments and the public register; they
do not apply to this page, and a sweep should leave its dead references alone. The rules file
is where nothing is allowed to go stale.

**Methodology only, and that is a limit on what may be argued here.** This page explains why a
rule reads as it does. If an entry needs a trigger sequence, a reachability argument or an
account of who gets hurt in order to be convincing, the content has changed class: it is an
accepted limit rather than rationale, C9 governs it, and the reasoning belongs where such
decisions are recorded and not in this repository. Do not import that material to win an
argument about a comment rule.

**No counts.** An earlier draft argued several rules from measured figures: comment-line ratios,
marker totals, per-file emphasis densities. Every one of them was true when measured and would
have been wrong within a release, which is C4 applied to a document instead of a comment. The
arguments that survive are the structural ones, so the numbers are gone and the words are
"frequently", "most" and "several". Anyone who wants a figure can measure it, and will get a
current one.

---

## C1 · Why the issue-number exception was dropped

An earlier draft carried a rule, C1a, splitting `#NNN` citations by tense: keep one pointing at
open work or at the regression a test pins, delete one justifying shipped code. It was written
because a great many comments cited an issue, and because a few of those were the best comments
in their file.

**Measured again against the current tree, they are gone.** Comments citing an issue number have
been swept out of the app, and the only matches left are a hex colour, a Shopify order name and
an example inside prose. The exception existed to accommodate a population that no longer
exists, so it was deleted rather than kept: a rule whose entire evidence base disappeared is C4
with a table.

`AGENTS.md` bans issue and PR numbers in comments outright, and the source now agrees with it.
C1 therefore has no carve-out, and C23 asks a test to name the regression in a sentence rather
than by number. The useful half of the old rule survives as C1b: history deletes, and whatever
rule was buried in it gets routed.

## C1b · The destination was wrong twice

The first draft of C1b routed a surviving rule to `docs/designs/`. That was written against a
checkout a long way behind `main`, in which the docs tree had since been reorganised:
`docs/designs/` and `checkin-app/docs/` no longer exist, which I missed because the `AGENTS.md`
docs map I was reading was equally stale.

The correction is worth recording, because the failure is the one C21 warns about. A document
telling people not to cite locations that rot was itself built on rotted locations, and the
examples survived the move while every path and every count did not.

**Provenance does not travel.** A rule moving out of a comment sheds its provenance at the
boundary, by design, and the PR that moves it is where that history lives.

**Why C1b restates C26 anyway.** C1b's routing table is C26's three-way split with two rows
added, for enforced-by-construction and for how-we-build conventions. That duplication is
C18's point-of-temptation exception used deliberately: C1 is where someone holds a piece of
history wondering what to do with it, and C26 sits several sections away under a heading about
cross-file rules, which an archaeology residue frequently is not. Do not collapse C1b into a
pointer; the answer belongs where the question gets asked.

**The first paragraph of C1b matters more than its table.** The original C1 said the residue "is
usually a real rule", which licensed the wrong reflex: treat every deleted scrap of history as a
rule needing a home, and the comment you were trimming grows back while the rules file grows an
entry. The test is whether a change could violate it.

---

---

## C6 · Why verification is a duty, and where grep stops

**The false claims were the audit's best yield.** Reading the shouted lines rather than counting
them turned up several comments carrying a stale, duplicated or false claim, which is why C6 is
written as a duty rather than a default. Three were provably false against the code at the time:
a claim that the scope validators were not wired as gates when a test arms both, a claim that a
route spec type lacked a field it has, and a phase label on the background-check triggers left
over from before that queue went live. Alongside them, a role-flag count restated in several
places where one map owns it, and post-rename references to a model that no longer carries that
name.

One shout turned out to be enforcing something already impossible to break: a comment asking
two callers to share a predicate that both already import from one exported constant, left over
from before the extraction (C27).

Those were found against an older tree and the drafted fixes were never merged. Treat them as a
shape to look for rather than a list to cite, because the references have already moved once.

**Why the carve-out for ordering claims.** C6's default is to delete a rule you cannot confirm
in one grep, which is right for a claim about code and wrong for a claim about orderings. A
comment asserting that two operations cannot interleave, that a state is unreachable, or that
something always eventually happens is not settled by reading the file, so the default would
delete precisely the claims that are hardest to re-derive and most costly to get wrong.

This is not hypothetical here. Formal models of several state machines have been checked against
the app, and the findings arrived as behaviour changes: a seat change and its stock delta moved
into one transaction, a refunded order stopped activating a place, parked stock writes made to
settle on reopen. Those are ordering and reachability properties, and no grep of the files they
touch would have confirmed or refuted a comment above them.

Hence the two-sided instruction. Do not delete such a claim for being unconfirmable, and do not
strengthen it for being uncontradictable; an unfalsifiable claim is where prose inflates,
because no reviewer can push back on it.

---

## C9 and C15 · Why an accepted limit is described and never explained

Some limits in this app are known and were accepted rather than fixed. A reader meeting one
needs to know it is intentional, or they will "fix" it, and §3.6 of the documentation standard
names that risk exactly: `[Decision — deliberate limit]` is the tag it calls the one most
likely to be fixed by someone helpful.

What a reader does **not** need in the source is the sequence that reaches the limit, how
likely it is, or who it would hurt. Three reasons, in order of weight:

1. **A source comment is readable by anyone who reads the repository.** A precise recipe is
   worth more to someone attacking the gap than to the colleague being warned. The warning
   survives without the recipe; the recipe does not survive being public.
2. **Reasoning and likelihood are recorded where such decisions are recorded, which is not the
   source tree and not `docs/`.** Writing them in a comment makes a second copy that drifts
   from the first, and the first is the one with a date and a named decision-maker attached.
   This is C18 with a confidentiality edge.
3. **The judgment is not the comment author's to make.** Whether a limit is acceptable is an
   owner or board matter. A comment that argues the risk is small has taken that decision on
   their behalf and frozen it where nobody will revisit it.

Hence the shape in C9: say what the code does, say the absence is deliberate, stop. Drafting a
trigger sequence in a comment is the signal to stop and ask the owner where it belongs.

**C15 splits on harm for the same reason.** A defect costing someone a retry, a manual fix or a
duplicate email has no confidentiality dimension, so state it plainly where it happens; the
Shopify webhook's unproven entitlement is in the source for exactly this reason. A defect
touching safety, money, privacy, access or a written policy is an accepted limit, and C9's
second half governs it.

---

## C20 · Why there is no density ceiling

The repo's comment density is healthy, so a pinned ceiling would be a guard with nothing to
catch, and the figure that showed it healthy is the kind this document no longer keeps. The
principle holds and is worth stating: high comment density in a file that is already pure and
unit-tested usually means comments are carrying explanation the tests should carry.

---

## C21 · Why "point at the test" spreads an existing pattern

A first pass reported that no comment named a guard test. That was a bad grep; the filter
excluding test files also excluded the matching lines. Several files do it, and do it well,
which is why C21 is phrased as spreading a practice rather than introducing one. "Invent this"
and "do what these files already do" are different instructions, and only one of them is true.

---

## C22 · Why there is no per-file emphasis budget, and no guard

The draft rule reserved capitals for a real trap "roughly one per file". An audit classified
every emphasis span in the app against it and found the instinct right and the budget wrong:
most shouting is habit that reads identically in lower case, a quarter marks a real contrast,
and only a small fraction marks a genuine trap.

Every mechanical cap still fails, for four reasons that do not depend on the counts:

- **Typical files already exceed one span**, so a one-per-file cap is a repo-wide sweep on the
  day it lands.
- **The cap is anti-correlated with risk.** The densest file in the app is the environment
  config, and it is dense because its whole purpose is spelling out the environment fuses. A
  cap would delete most of the traps in the one file where the shouting is doing real work.
- **A directory-scoped variant fails too.** "Capitals only in the security, api, middleware and
  auth paths" misses a substantial share of the real traps, which turn up in connection-pool
  reaping, lock ordering, an externally-mandated colour set and a trademark note.
- **Density does not separate the populations.** Two of the densest files in the app contain no
  traps at all, several of the densest are test files, and even inside the security surface most
  of the shouting is habit.

**And no guard.** A "more than N shouted words per file" scan is the obvious guard and the
wrong one. It fails a large set of files immediately, needing a grandfather list bigger than the
trap population it is protecting. Separating genuine spans from acronyms, enum values, SQL
keywords and error codes took a long exclusion list plus hand curation, and every new schema
enum value becomes a false positive the day it lands. Worst of all it measures the wrong thing:
a file with one shouted word carrying a false claim passes any cap. This is C28 in its natural
habitat, and a checklist line is the right mechanism.

The marker vocabulary C22 recommends was verified against the tree rather than invented. The
CODEOWNERS-gated header is consistent across the security boundary files, and the others appear
with identical grammar wherever they appear. One candidate was dropped from the list because it
only ever occurs in lower case.

---

## C24 · Why one debt marker, after trying two

An earlier draft allowed `ponytail:` and `TODO(#NNN)` together. The argument was that a `TODO`
carrying an open issue number answers the usual objection to `TODO`, since it points into the
tracker rather than nowhere, and that the few in the app all carried one.

They do not exist any more. The app now carries no `TODO`, `FIXME`, `HACK` or `XXX` of any kind,
and `ponytail:` is in wide use, so the second marker had neither a population to protect nor a
rule to lean on. It also contradicted `AGENTS.md`, which keeps issue numbers out of comments,
and this file's own precedence clause would have nullified it on merge.

One marker, then. The objection to a bare `TODO` stands on its own: nobody owns one, nobody
dates one, and none of them fail a build.

## C26 · Why there is no invariants ledger

The strong form of C26 routes every cross-file rule into a single invariants document, each
entry backed by a named guard test. This repo has the guards and has no such document, and two
passes looking for unguarded invariant claims settled the question against adding one.

Everything promotable already has a guard, and the comment already names it, so a
ledger would have nothing to add. Most trap comments are already covered by the source-scan
guard tests and the custom ESLint rules, which exist precisely so a comment is not the last line
of defence. The unguarded remainder divides into wishes that want trimming and rules that want a
test, and a ledger entry helps neither: a rule written into a ledger is still a rule enforced by
hoping someone reads it.

Revisit only if unguarded promotable claims start accumulating faster than guards do.

---

## C29 · Five findings, five guards already in place

The emphasis audit's most useful output was not about emphasis. Asking whether the shouted
rules are enforced, rather than whether the shouting is guardable, produced five rules it
reported as having a comment for their only defence.

**Re-derived against the current tree, all five are guarded, and that is the finding.** Each had
already been escalated, and the instruments differ, which makes them a worked catalogue of
C27's ladder rather than a list of faults:

| The rule | What holds it |
|---|---|
| Environment branches gate on the app's own variable, never `NODE_ENV` | A lint selector on the member expression, with the test-harness exemption named |
| Client-safe modules take only types from the generated Prisma client | A lint import rule matching the module path, whose message explains the bundle cost |
| The app's connection pool keeps no idle minimum, so the cluster can pause | A unit test asserting the minimum and the idle ceiling |
| A JS predicate and a Prisma `WHERE` express one condition twice | A test evaluating the `WHERE` in memory across the full matrix and asserting equality with the predicate |
| The kiosk signing contract spans TypeScript and Python | A shared signing vector both sides read, and a CI rule running both tiers when it changes |

The report described a tree a long way behind `main`, and it had also claimed the kiosk
directory skipped its tests, which was a misreading of a filter that skips the Node application
tier for a kiosk-only change while running the Python tests through their own job.

**So the evidence supports C29 by inversion.** This codebase does convert a trap comment into a
guard; the audit found the comments and not the gaps. What C29 asks for is therefore the house
habit rather than a new demand, and the useful part of the exercise was the catalogue above: for
a rule about *what the code may say*, a lint selector; about *what a module may import*, a lint
import rule; about *a value*, a unit test; about *two representations of one condition*, an
equivalence test; about *a contract across languages*, a shared fixture plus the CI tiers that
read it.

Against those, the wishes that remain: a padding relationship between two components with no
test referencing either, and a "single source of truth" colour claim nothing prevents copying.
Both are interface work and C28 governs them. A third, a "sole editor" claim on the roles
modal, has since been removed and that component now has a test, so the example is gone.

**The method lesson outlived the findings.** Four of the five entries, and the sixth claim about
CI, reached this file from a report and were written down without being re-derived. That is C6
committed by the document that bans it. A claim about enforcement is exactly as perishable as a
claim in a comment, and a report is not a verification.

