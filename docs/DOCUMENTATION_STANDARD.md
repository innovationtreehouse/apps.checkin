# Documentation standard

How documentation in this repo is organised, written, and retired. Read this
before writing or moving any doc. This is the standard in force; the one-time
move of the existing corpus into it runs in `docs/in-design/DOCUMENTATION_MIGRATION.md`.

---

## 1. Why this exists

Documentation organised by *what change produced it* tells you whether a change
landed. It does not tell you **what is true now** — so a rule only gets written
down if it happened to be large enough to warrant its own doc, and a doc
describing a shipped change silently decays into a wrong statement of current
behaviour.

This standard adds one register that is maintained rather than frozen — the
domain rules — and gives everything else a shorter life.

---

## 2. Document classes

| Where | What | Lifetime |
|---|---|---|
| `docs/rules/` | Board and operations decisions; invariants new work must not violate | **Permanent, edited by later changes** |
| `docs/conventions.md` | How we build, independent of any domain | Long-lived |
| `docs/ops/` | How to run, deploy, test, and mock things; and states left by a data load, each with an exit condition | Long-lived; cleanup entries deleted as they close |
| `docs/security/` | Security policy and boundary rules | Long-lived |
| `checkin-app/docs/generated/` | Machine-derived artifacts, drift-tested | Regenerated, never hand-edited |
| `docs/backlog/` | Journey inventory and gap tracking | Long-lived |
| `docs/in-design/` | Proposals and designs being worked right now | **Deleted at merge** |

Most of these are edited over time — ops docs follow the tooling, security
policy evolves, the backlog is maintained continuously. What sets `docs/rules/`
apart is *what triggers* the edit.

A doc in any other class changes when **the thing it describes** changes: new
mock, new deploy step, new gap found. That is ordinary upkeep, and it falls on
whoever touches that thing.

`docs/rules/` changes when **any work in its domain** establishes, alters, or
retires a rule — even work that has nothing to do with documentation. That makes
it the one class carrying an obligation outward onto unrelated changes, which is
why the extract step in §4 exists at all.

---

## 3. `docs/rules/` — the domain register

One file per domain, named for the domain and not for any feature:

| File | Covers |
|---|---|
| `membership.md` | org membership: application, review, dues, renewal, lapse |
| `programs.md` | programs and enrollment: eligibility, capacity, pricing, scholarships |
| `people-households.md` | households, leads, guardianship, youth/adult status |
| `revenue.md` | payment, refunds, exceptions, reconciliation obligations |
| `expenses.md` | receipts, expenses, budget buckets, spending sign-off |
| `attendance-checkin.md` | check-in, kiosk, visits, hours |
| `tools-certification.md` | tool levels, certification, shop access |

Alongside them, `principles.md` — rules that hold across every domain. It is not
a seventh domain; see §3.3.

Add a file when a domain genuinely accumulates standing rules. Do not create
empty ones in advance.

### 3.1 What belongs

Decisions the board or operations have made about how things work, and
invariants that later work must not violate.

**Not:** implementation mechanism, state-machine structure (already generated and
drift-tested under `checkin-app/docs/generated/`), rollout sequencing, or
anything a reader could derive by reading the code.

### 3.2 Three sections, in this order

Not every rule has the same authority, and a reviewer needs to know which kind
they are looking at. Each domain file runs **Policy, then Assumptions, then
Procedure** — highest authority first, so the constraints that cannot be
renegotiated in a PR are read before the ones that can.

**Policy** — the rule exists because the board or the organisation adopted a
policy. The code implements it; it does not define it. **Cite the governing
policy.** A change that violates one of these is not a design disagreement to be
settled in review: the policy has to change first, which is a board action. A
reviewer's correct response is to stop and escalate, not to weigh trade-offs.

**Assumptions** — things the app takes as true because they are handled outside
it. The board appoints keyholders in writing; the flag in the database
represents that act.

These are not deficiencies, and they are not written as though the software
ought to be doing the job. An assumption states what is assumed and the
condition that keeps it true — nothing more. What makes it worth recording is
that a change can invalidate one: make a role easier to acquire, and the act it
stood for is no longer behind it.

**Procedure** — everything else. Working agreements about how this system
behaves: operational choices, invariants the team settled on because something
had to be decided. Real rules that later work must not casually violate, but
they can be renegotiated by the people doing the work, in a PR, without going to
the board.

### 3.3 Cross-cutting rules — `principles.md`

Some rules hold in every domain — least privilege, for one. Writing them into
six files means writing them six times, so they live in
`docs/rules/principles.md` and the domain files cite them.

They sit **between** the two authority levels. No policy names them, so they
cannot be Policy; but they are not a PR-level trade either. A change that
violates one escalates to the owner — not to the board, and not to whoever is
reviewing that morning.

A principle earns its place by being **cross-cutting** and by passing the same
test as any rule: a change could violate it, and you can picture the change that
does. If it only ever bites in one domain, state it in that domain. Before
accepting that no policy names it, check the corpus — a principle that turns out
to be policy-backed is a Policy line, which carries more weight.

### 3.4 What does not belong in the register at all

Three classes look like rules and are not:

**How we build** goes in `docs/conventions.md`. The server recomputing anything
that affects price or access, the interface gating on the same rule the server
enforces — true, load-bearing, and containing no domain content. A reviewer
checking a membership change should not read past them.

**A term's meaning** goes in `checkin-app/docs/VOCABULARY.md`, the dictionary.
Where a term is also a constraint (two deep, member family, youth, the tool
levels), both the dictionary and the register keep a complete statement: the
dictionary the definition with its constraint, the register the rule. **A change
to such a term in either one edits both in the same PR.**

**States left by a data load** go in `docs/ops/legacy-cleanup.md`: imported rows
missing fields the app now requires, a superseded model still carried by old
records. These are expected to reach zero, so **every entry names how it is
surfaced and what "done" is**, and the entry is deleted when it closes. Without
an exit condition "temporary" becomes permanent and the file becomes a second
register nobody prunes.

### 3.5 Citing

**Policy.** Name the policy and its **structural location** — article, section,
subsection, clause, whichever that policy actually uses. `Background Check
Policy §2`, `Bylaws Art. IV §3(b)`, `Financial Controls Policy §5.2`.

**Never cite a page number.** A page is an artifact of rendering: it moves when
the document is reformatted, differs between PDF and print, and does not exist
at all in some formats. The structural reference is part of the policy's own
text and survives everything except an actual amendment — at which point the
citation *should* break, because the rule may have changed.

**Never cite a filesystem path.** The policy corpus lives outside this repo (see
§3.10), so a path dangles for everyone but its owner and rots the way line numbers
do. The policy's name plus its section is what survives a reorganisation.

If a policy has no internal numbering to cite, say so explicitly ("*Volunteer
Policy* — unnumbered") rather than inventing a locator or falling back to a
page. That gap is worth surfacing: it usually means the policy needs structure.

**Do not promote a rule to the policy tier to give it weight.** If you cannot
name the policy it comes from, it is procedure. A rule that merely *feels*
official is the same defect as an unratified policy written as settled.

**A principle** is cited the same shape: `— *Principle: fail closed*`.

**Never cite a doc that is scheduled to be deleted.** A pointer into a folder
the migration empties rots on a date already agreed. A bare source-file path is
the most a "where this bites" hint should carry, and most rules need none.

### 3.6 Tagging a procedure line

A Procedure line carries a tag naming what kind of statement it is. The tag
answers "what do I do about this?", so two kinds that lead to the same answer
share one tag.

| Tag | Means |
|---|---|
| `[Decision]` | A choice we made. Renegotiable in review. |
| `[Decision — *Policy: …*]` | The app's specific expression of a policy stated generally above — a threshold picked, a proxy chosen, need-to-know made concrete for one field. Sometimes **stricter** than the policy requires, in which case say so: the risk is someone relaxing it while believing they are aligning to policy. |
| `[Decision — *Principle: …*]` | The domain's application of a cross-cutting rule. States only what the domain adds. |
| `[Decision — deliberate limit]` | The **absence** is chosen. The one most likely to be "fixed" by someone helpful. |
| `[Short of policy — *Policy: …*]` | The app models this and models it **weaker** than the cited policy. Not renegotiable in review and not a target to build toward casually: what closes it is the policy. Tracked as work as well as stated (§3.7). |
| `[Unsettled — …]` | Genuinely not agreed. **Do not cite as precedent.** |

`[Decision — deliberate limit]` and `[Short of policy — …]` are the pair most
easily confused, and they demand opposite actions. A deliberate limit says *do
not fix this* — the absence was chosen, and closing it would undo something. A
shortfall says *do fix this, but not casually* — the board has already decided
and the app has not caught up. Reading one as the other is how a deliberate limit
gets "closed" by a helpful change, or a real shortfall gets defended as
intentional.

### 3.7 Recording a divergence

A divergence is a board rule the app implements more loosely than the policy
states. Four things are **not** divergences, and calling one a divergence is the
failure mode this section exists to prevent:

- **A policy value held in configuration.** The app is built to be configurable;
  keeping a setting aligned to policy is operational work.
- **A rule the data model already guarantees.** One price column rather than a
  per-person amount means "the same for everyone" needs no assertion. The
  absence of a check is not the absence of the constraint.
- **Anything handled outside the app.** That is an assumption (§3.2), and the
  distinction is the whole test: an assumption says the job is being done
  somewhere else, a divergence says the job is not being done. Writing a
  deficiency as an assumption — "we assume leads check this" — is the easiest way
  to make a gap read as settled, and it is more tempting now that there is no
  section to collect gaps in. If nothing outside the app actually does the job,
  it is not an assumption.
- **A deliberate balance.** Choosing not to block someone at the door for an
  obligation better chased in conversation is a decision, and belongs in
  Procedure as a deliberate limit.

What survives is where the app **does** model something and models it weaker
than the policy — a supervision check counting bare adults where policy requires
two unrelated non-student volunteers. Before recording one, read the enforcement
path, not just the write path that creates the value.

**Where it goes: at the rule it qualifies, never in a list of its own.** State it
on the Procedure line a reader would otherwise take as enforced — one sentence
saying what the app actually does and how that falls short — tagged
`[Short of policy — *Policy: …*]` per §3.6. A reader who finds
their answer stops reading, so a rule stated in one place and qualified in
another is read as unqualified.

Domain files used to end with a section collecting these. That section is gone,
and it is not to be reintroduced: it sat a hundred lines from the rules it
contradicted, and every entry in it was eventually found to be one of four things
— shipped and stale, never a divergence at all, a gap the tracker should own, or
a question nobody had answered. None of those needed a list.

**Recording it is not the end of it.** A divergence is tracked as work as well as
stated. It is not a feature request: what closes it is the policy, not a
judgement about what is worth building, and the app meanwhile reports as
acceptable something the board has said is not. Two consequences worth stating,
because both have already bitten:

- **The work that closes a divergence updates the rule in the same change.** An
  implementation PR that fixes the behaviour and leaves the register describing
  the old one has moved the error rather than fixed it.
- **A gap the app does not model at all is not a divergence** — there is no rule
  to qualify. It belongs to the tracker alone, with enough detail on the issue to
  say which register file gains rules when it is built.

### 3.8 Format

Grouped under short headings, one rule per bullet, written in business language
so a reviewer can judge a diff against it without opening code:

```markdown
## Policy

- Membership activates only after background-check clearance. Payment arriving
  first does not activate; clearance arriving first does not activate.
  — *Background Check Policy §2*

## Procedure

- An application needs a fresh background check before it can activate. A
  household whose lead already holds a still-valid clearance is exempt: the
  requirement is cleared at submission and only the signature is left.
```

Note what the second rule spends a whole clause on: the **exemption**. An earlier
draft of this document stated it without the clearance carve-out, which would
have marked shipped, correct code as a violation. State the guards and carve-outs
the code actually has, or the register does damage rather than none.

(The tier split above is illustrative. Which of these is actually
policy-backed is settled during the migration, against the real policy corpus.)

**Write rules as constraints, not descriptions.** If the sentence does not let a
reviewer tell whether a change violates it, rewrite the sentence.
"Membership does not activate until two reviewers have cleared the check" is
checkable. "The intake system supports notes" is not.

**No PR numbers, issue numbers, or dates.** These files say what is true, not
how it came to be. Change history lives in git and in the PR record, where it is
linked to a diff and stays accurate on its own.

**No line-number citations.** They rot within weeks and pull the register toward
implementation when what a reviewer needs is the rule. A bare file path is the
most a "where this bites" pointer should carry, and most rules need none.

**Never state an over-broad rule.** A rule that claims more than the code does is
worse than no rule: it marks correct behaviour as a violation, and the likely
response is someone "fixing" working code to comply. When in doubt, state the
narrower version, or leave it out and raise it.

**An unratified policy is a candidate, not a rule.** Code sometimes carries a
decision that was never actually decided — a `POLICY (flag for veto)` comment, a
choice made to unblock a PR and never confirmed. Writing it here converts an open
question into a stated invariant nobody agreed to. Take it to the owner or the
board first; record it only once it is answered.

### 3.9 How much belongs

Enough but not too much. A domain has however many rules it has — some will be
genuinely denser than others, and an arbitrary page count would either be
ignored or cut real rules to meet it.

Test each line, not the file:

- **Could a change violate it?** If you cannot picture the PR that gets this
  wrong, it is background, not a rule. Cut it.
- **Would a reader derive it from the code anyway?** Then it is mechanism. Cut it.
- **Does it duplicate a line already here?** Merge them.

Test the file by whether it still gets read. If reviewers start skimming it, the
register has stopped working — and the cause is nearly always mechanism that
crept in, not a domain that genuinely has too many rules. Look for that first.
Splitting the file hides the symptom without fixing it.

### 3.10 Where the policies live

**The governing policies live on Google Drive.** That is the canonical source —
what the board adopts and amends, and what a citation ultimately refers to.
Anyone with Drive access can verify a policy-tier rule against the policy it
names, which is what makes this tier meaningful rather than decorative.

This is why §3.5 cites by policy name and article rather than by any locator. The
name and section are the one identifier stable across Drive and whatever format
a policy is rendered in. A Drive URL is no better than a filesystem path: it rots
on reorganisation and is permission-gated. Name the policy and its article; a
reader with access can find it in seconds.

Verify against Drive, not against any local or cached copy of a policy — a copy
predating an amendment would enshrine a superseded rule behind a citation that
still looks correct.

---

## 4. Working docs — `docs/in-design/`

A doc written while designing or building something is welcome and useful. Edit
it freely and skip the status ceremony — the folder it sits in already says it
is unfinished.

**Where it lives:** `docs/in-design/<name>.md`. One folder, so anyone can see
what is currently being worked at a glance, and so nothing unfinished is mistaken
for settled.

Not `docs/backlog/` — that is an inventory of what exists and what does not,
maintained over time; mixing disposable per-change docs into it defeats both
purposes. Not the `docs/` root — that is for settled, permanent material.

Anything sitting in `docs/in-design/` is by definition not yet true. Do not cite
it as ground truth in another design, and do not implement against it without
checking whether it landed.

At merge:

```
extract   whatever standing rules the work established, into docs/rules/<domain>.md
delete    the working doc
```

How many is however many there are — often none, sometimes one, occasionally
several. Ask of each candidate the §3.9 question: *could a later change violate
this?* If yes it is a rule and it goes in, however many that turns out to be. If
no, leave it out, even if that empties the list.

The failure to avoid is treating this as a quota — hunting for rules to justify
the step, or stopping once a couple are written while a real one goes unrecorded.

**Extracting nothing is a normal outcome.** Most changes do not establish new
rules. Delete the working doc and add nothing.

If a working doc turns out to be operational reference rather than feature
design — how to run a mock, how an environment behaves — move it to `docs/ops/`
instead of deleting it. It stays true and has no home in the rules register.

A doc describing finished work that has nothing durable to say is sprawl. Delete
it.

### 4.1 How it opens

A working doc is read by someone who does not yet know the problem. Order it so
they learn it first:

1. **Problem** — in plain English. What goes wrong, and for whom.
2. **Objective** — what is true once this is done.
3. **Executive summary** — the outcome: what changes for each affected group,
   what deliberately does not change, what it costs.
4. **Then** the rules the work relies on or intends to change (§5), mechanism,
   detailed design, migration, tests.

**The problem statement must be readable by someone who has never opened the
code.** No symbol names, no file paths, no line numbers. If the opening needs
any of them, it is describing the symptom in the source rather than the problem.

**Provenance goes last.** Issue decomposition, related-issue lists, and backlog
cross-references belong in an appendix; alternatives considered belong below the
design they were rejected in favour of. Both justify the design to a reviewer;
neither explains it to a reader, and above the problem they displace it. A doc
that opens with a decomposition table has not stated its problem — a reader
hits rejected options before learning what is being solved.

### 4.2 Keep the permanent text apart from the migration to it

A working doc that changes a standing rule carries two things with different
lifetimes: **the rule, which outlives the change**, and **the one-time cutover**
— current counts, by-hand steps, where in-flight work lands, what has to be
decided first. The second expires the day the change runs.

Written as one document they interleave, and two things follow. The permanent
text gets stated twice — once as the design, again as the block to paste into
its real home — so a later edit lands in one copy and not the other. And the
extract step below stops being a file move and becomes a judgement call over
every paragraph, made by whoever merges, months after the reasoning.

**Split them while writing, not at merge.** Two files:

- `<name>.md` — the permanent text and nothing else. Not where it is going, not
  how it gets there, not what it replaces: those expire, and a file that has to
  be edited before it lands is a file that will land wrong. Landing it should be
  a copy.
- `<name>-migration.md` — everything that stops being true once the change runs,
  including the destination itself. Its last step is "apply the other file,
  delete both".

Naming the destination inside the permanent file is the easy version of this
mistake to make, and the one that survives review: it reads like a helpful
header rather than what it is.

Most changes have no cutover and need no second file. The test is not whether
the doc is long enough to split, but whether any of it **expires on a date you
can name**.

---

## 5. Enforcement

**PR review, not tests.** A reviewer reads the domain rules for the area a
change touches and catches a violation before it merges.

To give reviewers something concrete to check, a working doc or design should
name the domain rules it relies on or intends to change. A change that alters a
rule says so explicitly rather than leaving the reviewer to notice.

**Known limitation.** Nothing catches an *omitted* rule. A change that
establishes a new invariant without writing it down leaves no trace a test or
lint could find. The mitigation is that `docs/rules/` stays worth reading during
review — see §3.9. This standard does not claim to close that gap mechanically,
and no test should be built to pretend otherwise.

---

## 6. Guidance for agents

1. **Before changing behaviour in a domain, read `docs/rules/<domain>.md`.** If
   your change contradicts a rule there, that is a decision for the board or the
   owner — raise it, do not quietly proceed. A **Policy**-tier rule is not
   negotiable in a PR at all: stop and escalate.
2. **Never promote a rule to the Policy tier without naming the policy**, and
   never cite one by page number or filesystem path — name plus article,
   section, or subsection only.
3. **Before writing a rule, read the enforcement path, not just the write path.**
   The code that sets a value is not the code that corrects it.
4. **State the narrower version.** A rule claiming more than the code does marks
   correct behaviour as a violation, and the likely response is someone
   "fixing" working code to comply.
5. **Handled outside the app is an assumption, not a gap.** Record what is
   assumed and what keeps it true. Do not editorialise about the software not
   verifying it — that is what the word means.
6. **A choice not to do something is a deliberate limit, not a gap.** Say so, so
   nobody closes it as an oversight.
7. **A working doc is fine while building — put it in `docs/in-design/`.** No
   `Status:` header ceremony; the folder carries that meaning. If it also
   carries a one-time cutover, that goes in a second file (§4.2) — never mixed
   into the text destined to become permanent.
8. **Never cite a doc in `docs/in-design/` as ground truth**, or one scheduled
   to be deleted. It describes something that is not yet true, or will not exist.
9. **At merge, extract and delete.** Move the standing rules into the domain
   doc; delete the working doc. Extracting nothing is normal.
10. **Never put PR numbers, issue numbers, or dates in `docs/rules/`.**
11. **Never put line-number citations in `docs/rules/`.**
12. **Write rules as constraints.** A reviewer must be able to recognise a
    violation from the sentence alone.
13. **Do not add mechanism to a rules file.** Structure belongs in the generated
    artifacts; how the code achieves something belongs in the code.
14. **Do not create empty domain files** in anticipation of future rules.
15. **Prefer cutting to adding.** Every line should be a rule a change could
    violate; anything else dilutes the ones that matter. Say it once — a rule
    restated in a second file is one that will be updated in only one of them.
16. **Open a working doc with the problem in plain English** — then objective,
    then outcome. Provenance and alternatives go below the design, never above
    the problem (§4.1).
