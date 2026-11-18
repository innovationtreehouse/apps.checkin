# Documentation standard

How documentation in this repo is organised, written, and retired. Read this
before writing or moving any doc.

---

## 1. Why this exists

Documentation organised by *what change produced it* tells you whether a change
landed. It does not tell you **what is true now** — so a rule only gets written
down if it happened to be large enough to warrant its own doc, and a doc
describing a shipped change silently decays into a wrong statement of current
behaviour.

This standard gives each kind of doc a home and a lifetime, and gives working
docs a short one.

---

## 2. Document classes

| Where | What | Lifetime |
|---|---|---|
| `docs/conventions.md` | How we build, independent of any domain | Long-lived |
| `docs/comment-rules.md` | Which comments to keep and which to delete, applying the `AGENTS.md` policy to the cases that recur here | Long-lived |
| `docs/comment-rules-rationale.md` | Why the contested comment rules read as they do; the one class that keeps superseded evidence on purpose | Long-lived |
| `docs/ops/` | How to run, deploy, test, and mock things; and states left by a data load, each with an exit condition | Long-lived; cleanup entries deleted as they close |
| `docs/security/` | Security policy and boundary rules | Long-lived |
| `docs/architecture/` | Standing architecture references: how a part of the system is shaped | Long-lived; edited when the shape changes |
| `docs/generated/` | Machine-derived artifacts, drift-tested | Regenerated, never hand-edited |
| `docs/backlog/` | Journey inventory and gap tracking | Long-lived |
| `docs/in-design/` | Proposals and designs being worked right now | **Deleted at merge** |

Most of these are edited over time — ops docs follow the tooling, security
policy evolves, the backlog is maintained continuously. A doc changes when **the
thing it describes** changes: new mock, new deploy step, new gap found. That is
ordinary upkeep, and it falls on whoever touches that thing.

### 2.1 Where some standing statements go

**How we build** goes in `docs/conventions.md`. The server recomputing anything
that affects price or access, the interface gating on the same rule the server
enforces — true, load-bearing, and containing no domain content. A reviewer
checking a membership change should not read past them.

**A term's meaning** goes in `docs/VOCABULARY.md`, the dictionary.

**States left by a data load** go in `docs/ops/legacy-cleanup.md`: imported rows
missing fields the app now requires, a superseded model still carried by old
records. These are expected to reach zero, so **every entry names how it is
surfaced and what "done" is**, and the entry is deleted when it closes. Without
an exit condition "temporary" becomes permanent and the file becomes a second
register nobody prunes.

---

## 3. Working docs — `docs/in-design/`

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

**At merge, delete the working doc.**

If a working doc turns out to be operational reference rather than feature
design — how to run a mock, how an environment behaves — move it to `docs/ops/`
instead of deleting it. It stays true.

A doc describing finished work that has nothing durable to say is sprawl. Delete
it.

### 3.1 How it opens

A working doc is read by someone who does not yet know the problem. Order it so
they learn it first:

1. **Problem** — in plain English. What goes wrong, and for whom.
2. **Objective** — what is true once this is done.
3. **Executive summary** — the outcome: what changes for each affected group,
   what deliberately does not change, what it costs.
4. **Then** mechanism, detailed design, migration, tests.

**The problem statement must be readable by someone who has never opened the
code.** No symbol names, no file paths, no line numbers. If the opening needs
any of them, it is describing the symptom in the source rather than the problem.

**Provenance goes last.** Issue decomposition, related-issue lists, and backlog
cross-references belong in an appendix; alternatives considered belong below the
design they were rejected in favour of. Both justify the design to a reviewer;
neither explains it to a reader, and above the problem they displace it. A doc
that opens with a decomposition table has not stated its problem — a reader
hits rejected options before learning what is being solved.

### 3.2 Keep the permanent text apart from the migration to it

A working doc whose text outlives the change carries two things with different
lifetimes: **the permanent text**, and **the one-time cutover** — current
counts, by-hand steps, where in-flight work lands, what has to be decided first.
The second expires the day the change runs.

Written as one document they interleave, and two things follow. The permanent
text gets stated twice — once as the design, again as the block to paste into
its real home — so a later edit lands in one copy and not the other. And landing
it stops being a file move and becomes a judgement call over every paragraph,
made by whoever merges, months after the reasoning.

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

## 4. Guidance for agents

1. **A working doc is fine while building — put it in `docs/in-design/`.** No
   `Status:` header ceremony; the folder carries that meaning. If it also
   carries a one-time cutover, that goes in a second file (§3.2) — never mixed
   into the text destined to become permanent.
2. **Never cite a doc in `docs/in-design/` as ground truth**, or one scheduled
   to be deleted. It describes something that is not yet true, or will not exist.
3. **At merge, delete the working doc.**
4. **Prefer cutting to adding.** Say it once — a fact restated in a second file
   is one that will be updated in only one of them.
5. **Open a working doc with the problem in plain English** — then objective,
   then outcome. Provenance and alternatives go below the design, never above
   the problem (§3.1).
