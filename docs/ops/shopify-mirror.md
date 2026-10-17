# Shopify mirror — diagnosing it

Two on-demand reports cover the Shopify mirror: one for the plumbing, one for the
data. Both are board/sysadmin, both run only when someone clicks them.

> Every read of the mirror wakes it and is billed. That is why neither of these
> runs on a timer, and why the always-on config indicator checks configuration
> only. See `docs/conventions.md`, "A check that costs money is not a health
> check".

---

## Diagnostics — is the plumbing working?

**Where:** System Status → *Shopify Mirror (s-read) Diagnostics* → **Run
diagnostics**.

**What it is for.** The sync status on the payments page sits at the end of a
long chain, and every break in it collapses into one of two symptoms that look
identical from the page: the status line silently doesn't render, or "sync
started but its status can't be read." The probe walks the chain and names the
**first broken link with its specific cause**, so "it's not working and I can't
tell why" becomes a named link.

**The chain.** Eight links to the status line —

1. env wiring resolves a mirror URL
2. the host is reachable
3. the credential is accepted
4. the database exists
5. the `sync_run` table exists
6. SELECT on it is granted
7. rows exist — the sync has actually run at least once
8. timestamps are sane

— plus the trigger side, which is separate wiring: the trigger function is
configured, and this app is permitted to invoke it.

**Reading the output.** Six rows, each **OK**, **FAIL**, or **Skipped**, with a
sentence and, where there is one, the driver's own error code.

- **The first FAIL is the answer.** Everything after it reads *Skipped* — not
  healthy, just not reached. Fix the first one and run again.
- **Links 2–7 are one row.** They are proved by a single read, and the error code
  on that row says which of the six broke. Reachability, credentials, a missing
  database, a missing table, a missing grant, and an empty mirror are each a
  distinct code with its own sentence.
- **A FAIL on the latest run is a real answer, not a broken probe.** It means the
  mirror is readable and the sync itself reported a failure; the row carries the
  sync's own error text.
- **The trigger rows fail independently of the mirror rows.** An environment can
  have either side wired without the other. The trigger check is a dry run — it
  proves permission and existence without starting a sync.

Sentences and codes are not listed here. The endpoint is the ground truth for
them, and a copy would drift.

---

## Match audit — is the money accounted for?

**Where:** Finance Ops → payments → **Run match audit**.

Read-only and bidirectional: every mirror order carrying a membership or program
item is traced to an activation, and every active membership and enrollment is
traced back to an order, a board certification, or reported as having no payment
basis. It reports; it raises nothing and changes nothing.

**Reading the output.**

- Orders carrying none of the app's items — donations, merchandise — are out of
  scope and never appear.
- Manual outcomes (board certification, approved scholarship) are listed with who
  signed off. That list is the "what here was decided by hand" view.
- **Check the variant-coverage figure before trusting a clean report.** Orders
  mirrored before the mirror carried item identity have none, and cannot be
  matched on it. Those rows need a backfill; re-running the sync will not fill
  them. The report states its own coverage rather than reporting clean.
