# Comment rules

`AGENTS.md` owns the comment policy and states it in five bullets. This file applies that
policy to the cases that recur here, so a reviewer can name one. Where the two disagree,
`AGENTS.md` wins.

Two neighbours own things this file does not. `DOCUMENTATION_STANDARD.md` decides where a fact
belongs once it leaves the source; `WRITING_STANDARD.md` governs prose, and §1 of it exempts
comment blocks from "take the space the idea requires", which is why nothing here invites a
comment to grow.

**Citing a rule:** each is `C<n>`, flat and stable; say "C5" in review. Numbers are never
reused or renumbered. A retired rule is struck through in place and a new one appended.

This file is rules. The arguments behind the ones that were contested are in
[comment-rules-rationale.md](comment-rules-rationale.md), keyed by the same numbers. Read that
to change a rule; read this to follow one.

---

## The test

> **Would a reader do the wrong thing without this comment?**

Yes, it stays. No, it goes.

---

# 1 · Delete

### C1 · Code archaeology

No play-by-play of what the code used to be. Git has it.

```ts
// BAD, the diff talking
// POST previously re-queried certifier status with no denied gate, then the…
// Volunteer roster per program, used to split RSVP tallies by role.
```

The residue is often a real rule. *"This PATCH previously had no denied check"* is archaeology;
*"a denied lead mentor cannot edit their own program"* is the rule. Delete the history and keep
the rule; C1b says where the rule goes.

Not archaeology: "used to" meaning "used in order to", and a test describing the state under
test.

### C1b · Where the extracted rule goes, and whether there is one

**First ask whether a rule survives the deletion.** Most archaeology reduces to nothing. "We
used to do X" usually means the code does Y now, and Y is visible in the code. Converting every
scrap of history into a dutiful "rule" is how a comment grows back after you trim it. A rule
keeps its place only if a change could violate it; if you cannot picture that change, there is
nothing to rehome, so delete it and move on.

When a rule does survive, route it:

| The rule is… | Where it goes | Comment left behind |
|---|---|---|
| Already impossible to violate, because a type, a Prisma or DB constraint, or `handler()` enforces it | Nowhere; the compiler won (C27) | None |
| A cross-file rule a guard could catch | A named guard test, same PR (C26) | One line naming the test (C21) |
| A choice inside this one file | Stays here | One line, present tense; a prohibition if someone might undo it (C14) |
| A standing **domain** rule, about who may do what or what the organisation decided | `docs/rules/<domain>.md` | One line stating the constraint, or none |
| **How we build**, carrying no domain content | `docs/conventions.md` | One line, or none |
| A wish nothing enforces, that puts no reader at risk | Nowhere (C26) | None |

**The register has its own rules; follow them rather than improvising.**
`DOCUMENTATION_STANDARD.md` §3 governs `docs/rules/`. A rule lands in **Procedure** unless you
can name the policy that adopted it, it is written so a reviewer recognises a violation from
the sentence alone, and it carries no PR number, no issue number, no date and no line-number
citation, which is also what a comment may not carry (see the Comments section of
`AGENTS.md`).

**What does not belong in this file.** A rule about the *code*, such as who may edit a program
or how a seat is released, is never a comment rule however it was found. This file grows a rule
only when the thing being constrained is a comment.

### C2 · Restating the code

Nothing recoverable from the signature and the body. No `// Fetch the household.` above a
`findUnique`, no `// Return 403 if not a lead.` above the 403. Numbered step narration is the
same fault at paragraph scale: a few section markers in a long route handler are structure,
but four in a row each describing the next three lines are not.

### C3 · Sibling lineage

Route handlers come in families, such as the finance-ops approve and refuse pairs, the
ops-section layouts, and the sibling `[id]/route.ts` files. One line pointing at the sibling
helps; a paragraph of comparative history does not.

### C4 · Claims that rot

"Today", "for now", "not yet", "a later PR will" and "currently only" are promises to come
back. State the timeless constraint or say nothing.

A test comment describing the *state under test*, such as `// BG consent not yet given → still
EXTERNAL`, is present-tense fact about a fixture and is fine.

### C5 · Enumerating a set the code or data owns

Never list members of a set owned by a Prisma enum, `src/security/registry.ts`,
`scopeBindings.ts`, `coreRoles`, the page registry or the seed. These decay silently, because
the change that invalidates the list never touches the file the list sits in.

```ts
// BAD   Staff (admin/board/lead/core-vol) or a member of an enrolled household see…
// GOOD  Anyone the route's registry entry grants a scope to, plus enrolled-household members.
//       Shopify identifiers are the one field a lead mentor's PATCH cannot reach.
```

State the shape, point at the owner, and name a member only when it is an **exception**, which
is the one thing a registry cannot carry.

### C6 · Rules that are false

Verify a comment that asserts a rule before believing it. The ones that recur here are **authz
claims**, such as "only the board reaches this" or "sysadmins are gated out", and a reader who
trusts a stale one writes a security bug. The route's registry entry and `handler()` gate are
the truth; the comment is a claim about them. If you cannot confirm it in one grep, delete it.
A false rule is worse than none, because it stops the next reader checking.

**One grep settles a claim about code, and not a claim about orderings.** A comment asserting
that two operations cannot interleave, that a state is unreachable, or that something always
eventually happens is neither confirmed nor refuted by reading the file, so applying the grep
rule to one deletes exactly the claims that are hardest to re-derive and most expensive to get
wrong. Several such properties in this app have been checked against formal models of the state
machines, and the findings arrived as behaviour changes rather than as comments.

So for an ordering, reachability or eventually claim: do not delete it because you could not
confirm it, and do not strengthen it because nobody could contradict it. Find out whether the
property was checked. If it was, the comment states the property and C27's ladder decides what
else holds it. If it was not, narrow the comment to the mechanism in front of you, which is
what the code plainly does, and leave the stronger claim unmade.

### C7 · Unsourced superlatives and PR narration

No "the only correct way", "this consolidates the drift", or "added in the review". If the
claim is true it is a rule (C18); otherwise it is the pull request talking, and the pull
request is not the source.

---

# 2 · Keep

### C8 · Measurements and derivations

Where a number came from, not that it exists: a rate-limit window, a page size, a retry cap, a
`maxDuration`, a poll ceiling. The payments page states that a sync still running at the watch
cap is not lost, only no longer watched; without that, someone raises the cap to fix a bug that
is not one.

### C9 · Deliberate divergences, and limits that were accepted

The comment that stops someone "fixing" a thing that is correct. Highest value per line. The
participant merge route explains why it leaves the row rather than inventing a `departedAt`,
when four sibling paths do the other thing; without the note a tidy-up unifies them and changes
the data model by accident.

**Where the absence is what was chosen, the register carries it and the comment stays thin.**
`DOCUMENTATION_STANDARD.md` §3.6 has a tag for this, `[Decision — deliberate limit]`, described
there as the one most likely to be "fixed" by someone helpful. If the limit has a domain
dimension, tag it there and keep the comment to one line.

**Say that the limit is intentional; never write the way in.** A comment on an accepted limit
states what the code does and that the absence is deliberate. It does not carry the sequence
that reaches the gap, how likely that is, or who would be harmed. Those are real and they are
written down, but not in the source tree and not in `docs/`, so do not cite them and do not
reconstruct them here. Finding yourself drafting the trigger sequence in a comment is the
signal to stop and ask the owner where it belongs.

This matters most where the limit touches safety, money, privacy, access or a written policy.
A source comment is readable by anyone who reads the repository, and a precise recipe is worth
more to someone attacking the gap than to the colleague you were trying to warn.

**C13 asks for the reason, and this is where it stops.** The two kinds of reason look identical
on the page. A design tradeoff, such as duplicating a helper to keep prisma out of a client
bundle, is safe stated in full and belongs in the comment. How a bad state becomes reachable is
not, and the sentence that leaks it is usually the reassuring one: "the nightly close normally
runs first" tells a reader there is a case where it does not. Reassurance about why a limit
rarely bites is C9's forbidden half wearing C13's clothes, so state the limit and skip the
comfort.

### C10 · Platform and API traps

The seams against Shopify, Zoho, QuickBooks and the other external applications hold the real
traps, as do the platform seams: NextAuth, Next.js server and client boundaries, and Prisma's
recursive `WhereInput` accepting a stale field name at compile time. Comment the trap a reader
cannot see from the types, such as a webhook field the remote system lets the customer control,
or a column typed `WITHOUT time zone` that holds UTC anyway.

Name the seam a reader is standing at rather than cataloguing the integrations; the set changes
and a comment listing it goes stale by C5. The one member worth naming is an exception: no test
tier exercises NextAuth's `PrismaAdapter`, which `AGENTS.md` explains, so the comment there is
the only warning a reader gets.

### C11 · Unit, timezone, and money

The most valuable keep-class here, because none of it is visible in the type.

- **Calendar date against instant.** A program date is a calendar date pinned to UTC midnight;
  an event time is wall-clock in the org timezone converted through `fromZonedTime`. Both are
  `DateTime`.
- **Money.** Integer cents stored, dollar string entered, dollars displayed.
- **Server against client parsing.** Send an instant so the server does not reparse it in its
  own timezone.

One of the few places a comment beats a name, since the name would have to be
`startAtCalendarDateUtcMidnight`.

### C12 · What `null`, empty or zero MEANS

Sentinel semantics are invisible in the type and this schema leans on them. `orgMembershipId`
is nullable because a `PERSON_BG` process has no membership; a missing `dateOfBirth` with
`isDeclaredAdult` set means "25 or over, no date recorded" rather than "unknown age". Each is a
decision encoded as an absence, and a reader who guesses wrong writes a bug that type-checks.

### C13 · Rejected alternatives, with the reason

Why we did not do the obvious thing is the hardest thing to recover later. The membership
settings page duplicates `nextBoundary()` rather than importing it, because importing it pulls
prisma into a client bundle. Write the rejection down or it gets re-attempted.

One exception, and it is the easy mistake to make while following this rule: where the thing
you did not do was prevent a bad state rather than pick between designs, C9 governs and the
reason stays out of the source.

### C14 · "Why we moved off X", reworded as a warning

The one case where C1 inverts. Same fact, aimed at the person about to make the mistake:

```ts
// BAD   This used to call console.error directly; the lint rule was added later.
// GOOD  Do NOT log the identifier bare here: the lint rule forbids it because the object
//       serializes to "[object Object]" in CloudWatch and the error is unrecoverable.
```

### C15 · Known defects, stated plainly

A defect you decided to ship is worth more written down than discovered later. The Shopify
webhook says that the code is appended to a public cart link, so entitlement is not proven;
that belongs in the source and not only in the issue.

Two cases, and they separate on harm. A defect that costs someone a retry, a manual fix or a
duplicate email can be stated plainly where it happens. A defect touching safety, money,
privacy, access or a written policy is an accepted limit, so C9's second half applies: state
the behaviour, say the limit is known, and leave out the sequence that reaches it.

### C16 · `ponytail:` markers

Tracked debt with a named ceiling and an upgrade path. Never delete one in a comment cleanup,
because it is a work item rather than prose (C24).

What must survive is the **debt**, not every marker. A marker copied away from the point of
action is C18 drift wearing a work-item badge. The test is whether the debt is still tracked
where someone would act on it, not whether the marker count is unchanged.

---

# 3 · Write it well

### C17 · Comment the surprise, not the sequence

If the code does the obvious thing, say nothing. Prefer a name over a comment, since a named
constant cannot drift from the code the way a sentence can.

### C18 · One canonical home per fact

Restating a fact at four call sites is the drift problem of duplicated code. Every kind of fact
already has a register: domain rules in `docs/rules/<domain>.md`, cross-cutting rules in
`docs/rules/principles.md`, how-we-build in `docs/conventions.md`, word meanings in
`docs/VOCABULARY.md`, deploy and migration ordering in `docs/ops/`. Source comments point at
those; they do not restate them. `DOCUMENTATION_STANDARD.md` §2 has the full class list, and §6
rule 15 puts the cost plainly: a rule restated in a second file is one that will be updated in
only one of them.

**The exception is real:** a single line at the *point of temptation*, repeated at each place
someone reaches for the wrong thing.

### C19 · Scope matches placement

A file header answers what this is and why it exists; a member's doc answers what this one
thing guarantees. A header that drifts into describing its **consumers** is how C5 staleness
starts, because that fact belongs with the consumers or nowhere.

### C20 · Proportion

If the comment is longer than the thing it describes, the explanation is doing something other
than explaining. A long block restating a design doc above a small component keeps one line of
intent and a pointer. Concurrency notes are the exception (C38).

### C21 · Point at the rule, or the test, not the location

Paths move and line numbers rot on the next edit; `DOCUMENTATION_STANDARD.md` §3.5 bans both in
the register for the same reason, and the reason holds in source. Name the exported function,
the type, or the guard test, which survive a move and which grep will find.

**Point at the test.** Several files already do this; `auth-options.ts` names
`auth-options-adapter.test.ts` as the only tier that reaches the code it guards. A test name
cannot drift from its assertion, and it tells the reader where to go to *change* the behaviour.
A comment asserting a rule with no test named beside it is the shape C26 asks you to look at
twice.

### C22 · Emphasis discipline

A capital marks a prohibition or an invariant, something a reader who skims it will get wrong
in code. **If the sentence reads the same in lower case, lower-case it.** Prefer restructuring
the sentence over shouting a word inside it. There is no per-file budget, and nothing is
retroactive; this applies at review time to new and changed comments.

**Prefer an existing marker to an inline capital**, since a marker is greppable and a shouted
word is not: `IMPORTANT:` (the CODEOWNERS-gated header on the security boundary files),
`ENV GATE: LOCAL ONLY`, `PUBLIC BY DESIGN`, `ORDER MATTERS`, `KNOWN LIMITATION`,
`Fails CLOSED`.

### C23 · In tests, name the test instead of commenting it

A comment explaining what a test asserts is usually a badly named test. Reserve test comments
for why the case is interesting: the regression it came from, the edge it pins.

Name the regression in a sentence, not by its number. "The keeper backfill used to copy the
loser's email over a surviving one" tells the next reader what this case defends against; an
issue number sends them to a tracker to find out, and `AGENTS.md` keeps those out of comments.

---

# 4 · Conventions

### C24 · One debt marker

`ponytail:` is the only one. It states a deliberate shortcut that works, its known ceiling, and
the upgrade path.

Nothing else is allowed. A bare `TODO` accretes: nobody owns one, nobody dates one, and none of
them fail a build. A `TODO` carrying an issue number is no better in the source, because
`AGENTS.md` keeps issue and PR numbers out of comments; tracked work belongs in the tracker, and
the comment says what the code does today. An unmarked "this is a bit hacky" is an apology
rather than debt tracking, so mark it properly or fix it.

### C25 · No `file.ts:123` citations, no commit SHAs

Both rot. `AGENTS.md` and the docs cite PRs and history deliberately, because they are history
documents. Source is not.

---

# 5 · Cross-file rules: promote, keep local, or delete

> **A rule with no failing test is not enforced.**

### C26 · Every asserted cross-file rule is one of three things

| | When | Where it goes |
|---|---|---|
| **Promote** | A real cross-file rule, a future change could violate it from elsewhere, and a guard could catch it | A named guard test, **in the same PR**, in the shape `routeAuthDrift.test.ts` and `pageRegistry.test.ts` already use |
| **Keep local** | It explains a choice within one file, and nothing outside could violate it | Stays as a comment, trimmed |
| **Delete** | It reads like a rule but is a wish; nothing enforces it, nothing could, and no reader is at risk | Cut |

**Bias to keep-local and delete.** Promoting an unguarded rule moves the wish somewhere more
important. The promotion target is a test and never a ledger document, because a rule written
into a ledger is still a rule enforced by hoping someone reads it.

### C27 · Enforced by construction beats a test; climb as far as the seam allows

C26 says promote, but not to what. Four rungs, weakest first:

| | Holds when | Cost of staying here |
|---|---|---|
| A comment | Someone reads it | Nothing enforces it (C29) |
| A test | CI runs the case it exercises | A case nobody imagined still passes |
| A schema that is both the type and the runtime check | Every real call, including ones no test imagined | Parsing where the compiler already guarantees it is ceremony |
| Impossible by construction | Always; the violation cannot be expressed | None, so say so and stop |

**The third rung is how a library API boundary is held here.** `packages/receipt-types`
declares a zod schema and derives the exported type from it with `z.infer`, so the type a
consumer compiles against and the check a payload passes through are the same declaration and
cannot drift apart. A comment asking callers to keep a shape in step is that rung done by hand,
and the schema replaces both the comment and the test that would have guarded it.

**Climb to the rung the seam requires, and no further.** The compiler reaches across in-process
calls inside one package, so a `parse` there adds a runtime cost and a second place to edit. It
does not reach across a package boundary, over the wire, out of a database row or in from an
external application, and at those seams a type alone is an assumption wearing a type's
clothing.

**Across a language boundary the instrument changes and the rung does not.** The kiosk signing
contract is pinned by a shared vector that the TypeScript implementation, its Node test, the
Python client and a Python test all read, with CI running both tiers whenever the vector
changes. No comment asks the two implementations to agree, because the fixture is the agreement
and either side failing it is a red build.

Where the violation is architectural rather than a value, the same escalation applies with a
different instrument again: which package may depend on what is held by
`scripts/check-library-boundaries.mjs`, not by a note in a README.

### C28 · A guard nobody trusts is worse than the comment

A guard needing an exemption list that could outgrow its findings is not worth writing.
Register the rule, defer the guard deliberately, and say that you did.

### C29 · A trap comment with no guard is a finding, not a style problem

When a comment carries a real prohibition and nothing enforces it, decide which kind it is.
Some are wishes about one file and want trimming: the page-container padding relationship to
the app shell and the "single source of truth" claim on the tool-level colours are both
unverified by any test, and a guard for either would need an exemption list outgrowing its
findings, so C28 applies.

Others are a rule the codebase depends on with a comment as its only defence. Those are a work
item, so open an issue rather than thickening the comment, and pick the instrument from C27's
ladder. One such rule had already caused a production outage; the first response was more
comments, and the one that held was a lint rule. Writing the guard is the response, and the
comment then names it (C21).

---

# 6 · Mechanical hazards: comments are not inert here

**Some comments in this repo are executable.**

### C30 · `/// @sensitivity:` in `schema.prisma` is code, not prose

The schema sets a generator whose provider is `scripts/security-generator.js`. It parses the
`/// @sensitivity:<tier>` doc comments into the generated classifications that the response
stripper enforces at runtime.

- Editing one is a **data-policy change** rather than a comment change. Per
  `docs/security/`, re-tiering an existing field ships in its own PR, enforced by the
  security-boundary-isolation workflow.
- Deleting one downgrades a field silently.
- Never hand-edit the generated classifications; run `prisma generate`.
- A comment sweep **excludes schema doc comments** unless that is the sweep's stated purpose.

### C31 · `eslint-disable` is a comment that turns off a guard

**Do not add one.** `AGENTS.md` bans `eslint-disable`, `@ts-expect-error` and `@ts-ignore`
outright: fix what the tool points at, not the fact that it is pointing. This rule is about the
ones already in the tree, which a comment sweep will meet and must not treat as prose.

Three things follow. A surviving disable needs its reason in eslint's own `--` syntax, attached
to the rule it suppresses rather than floating above it:

```ts
// GOOD
/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */

// BAD
// eslint-disable-next-line react-hooks/set-state-in-effect
```

A disable with no reason is C7 in a costume, asserting "this is fine" with nothing behind it, so
supply the reason or remove the disable. And when you touch code under one, check whether it is
still needed: a stale disable is a stale rule (C4) that also weakens the lint for every later
reader. Removing one is the preferred outcome of meeting it.

### C32 · Generated-file headers must survive

The generated files open with "GENERATED by … do not edit by hand". That line is all that
stands between a reader and a change overwritten on the next `prisma generate`. Never trim it
as boilerplate.

### C33 · Migrations are immutable, and their comments are history correctly

`prisma/migrations/**` is an applied ledger, so C1 does not apply there: a SQL comment saying
what a migration backfills, and why, is the record. Never edit an applied migration's SQL or
its comments to tidy them.

### C34 · Source-scanning tests read comment text

Several guard tests read source files as text and match on strings, among them the lifecycle
status literal allowlist, the live-person drift guard, the branding regression, the authz
registry, the scope validators and the route auth drift test. A comment containing a banned
literal, a brand string or a status name **can trip them**, and deleting a comment can make one
pass when it should fail.

When a comment edit flips one, the matcher is too loose. **Fix the matcher, and never restore
filler prose to satisfy a test.**

### C35 · A comment is not a security control

An authz claim in a comment (C6) is the highest-risk false rule here, because it reads as a
gate. The gate is `handler()`, the registry entry and the `select`. If a comment is the only
thing describing who can reach a route, that route needs a test.

---

# 7 · Web-app candidates, lower confidence

Real hazards for a web app, but less tested than C1 to C35, since none came out of an audit.
Cut any that reads as ceremony.

### C36 · Say which side of the server and client boundary a fact belongs to

`'use client'` marks the file; nothing marks a *fact*. Why a value is deliberately absent from
a response, or why a helper is duplicated instead of imported (C13), matters precisely because
the boundary is invisible at the call. State server-only constraints, such as secrets, prisma
and `process.env`, at the point of temptation (C18).

### C37 · Query-shape comments: state the constraint, not the SQL

A narrow `select` is often a security decision rather than a performance one, and the next
person widening it needs to know which: "select stays narrow, this response is public-tier".
An `include` that exists to avoid an N+1 should say so, or it reads as over-fetching.

### C38 · Race and transaction comments take the space they need

The attendance and scan routes carry the best comments here, such as the note that a racing
keyholder check-in is either fully committed or not yet seen. Concurrency invariants are
unreadable from the code and expensive to test, so they are exempt from C20.

### C39 · Do not restate user-visible copy in a comment

Copy changes with brand and vocabulary rules, and a quoted string may also trip the branding
regression test (C34). Comment the constraint, such as "brand-sourced, do not hardcode",
rather than the words.

### C40 · Comments in `flow-tests/` should name the seed assumption

Flow tests depend on a freshly seeded database and specific personas by email. When a test
relies on one, say so. It is a cross-file coupling with no type behind it, and the most common
way a flow test breaks confusingly.

### C41 · Rate limits and retries: state the window and what happens at the cap

C8 covers where the number came from; this adds what a caller sees when it trips. A 401 that
really means "limiter not yet tripped, reached HMAC and failed it" is a distinction only a
comment carries.

### C42 · Accessibility intent needs one line

A `role`, an `aria-label`, a focus trap or a deliberately non-semantic element reads as an
accident. One line saying which behaviour it buys stops the next refactor removing it. Never
delete one in a comment sweep.

---

# 8 · Checklist

For a comment sweep, or any PR that adds comments.

- [ ] No "used to", "previously", "no longer" or "before this", unless reworded per C14 or a
      test naming its regression (C23); any surviving rule routed per C1b, and dropped when no
      change could violate it
- [ ] No claim that rots: "today", "for now", "not yet", "a later PR will" (C4)
- [ ] No comment enumerates roles, statuses or routes owned by an enum, a registry or
      `scopeBindings`; shape and owner only, with a member named as an exception (C5)
- [ ] Every authz claim re-verified against the route's registry entry and `handler()` gate, or
      deleted (C6, C35)
- [ ] An ordering, reachability or eventually claim neither deleted for being unconfirmable by
      grep nor strengthened for being uncontradictable; narrowed to the mechanism unless the
      property was checked (C6)
- [ ] Every asserted cross-file rule verified true, then promoted, kept or deleted (C26)
- [ ] Nothing promoted without a guard in the same PR (C26), at the rung the seam requires: a
      schema rather than a comment at a library, wire, database or external-application
      boundary (C27); a trap with no guard raised as an issue rather than thickened (C29)
- [ ] Units, timezones, money, sentinels, deliberate divergences and external-API traps
      survived (C8 to C13)
- [ ] An accepted limit states behaviour and intent only, with no trigger sequence, likelihood
      or harm assessment (C9, C15)
- [ ] Every `ponytail:` marker survived, and no `TODO`, `FIXME`, `HACK` or `XXX` introduced
      (C16, C24)
- [ ] Schema `/// @sensitivity:` comments untouched, or, if that is the change, it is its own
      PR (C30)
- [ ] Every `eslint-disable` carries a `--` reason, and stale ones are removed (C31)
- [ ] Generated-file "do not edit" headers intact (C32)
- [ ] `prisma/migrations/**` not touched (C33)
- [ ] Comment length proportionate to what it explains, with concurrency notes excepted
      (C20, C38)
- [ ] Pointers name a rule, a function or a guard test, never a file path or line number
      (C21, C25)
- [ ] Every new or changed capital marks a real prohibition or invariant; habit shouting
      lower-cased, and an existing marker preferred to an inline capital (C22)
- [ ] `npm run test:ci` run once, and any tripped source-scan guard fixed at the **matcher**
      rather than by restoring prose (C34)
