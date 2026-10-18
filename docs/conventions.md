# Engineering conventions

How we build, as distinct from what the domain requires. Nothing here is a
statement about membership, programs, or people — those live in `docs/rules/`,
and a reviewer checking a domain change does not need this file.

A convention earns a place here the same way a rule does: a change could violate
it, and you can picture the change that does.

---

## The server decides, the client mirrors

- **Anything affecting price, access, or eligibility is computed on the server.**
  A value the client asserts about itself — a membership tier, a role, a
  discount — is an input to be re-derived, never a fact to act on.

- **Where the interface hides or disables a control, it does so on the same rule
  the server enforces.** The two are written against one source so they cannot
  drift, and the client's version is a convenience, never the gate. A control
  that is merely hidden is not protected.

The failure is a gate that exists only in the interface. It looks correct in
every screenshot and every manual test, because the button is not there — and
the endpoint behind it answers anyone who asks.

---

## We do not write addresses at domains we do not own

- **Any address the app generates uses a domain the organisation controls, or a
  reserved non-routable one.** This holds for addresses nobody will ever read —
  a tombstone on a merged record still resolves somewhere, and somewhere is
  someone else's mail server.

A domain choice is invisible in review. A plausible-looking name is registrable
by anyone, and the mistake is only visible to whoever owns it.

---

## An invariant everyone must remember is not an invariant

- **Where something must never be read, make it impossible to read rather than
  everyone's job to exclude.** A rule held by convention holds until the first
  person who has not read the convention writes a query.

- **A filter every caller must remember, a guard that hunts for the ones who
  forgot, and a list of justified exceptions are one smell, not three.** That
  arrangement is how a design announces it needs the invariant moved into the
  data rather than reasserted at each site.

The failure is silent by construction. Forgetting produces no error, no failed
test and no wrong-looking code — just a row that should not have been there,
counted, rendered, or accepted as proof of who someone is. It is found when
someone notices the number is wrong, which is not a mechanism.

---

## A state machine describes the database, it does not drive it

- **Where an entity's states are written down, that definition is a source of
  truth and a validator, never an engine.** What enforces a transition is the
  database — a compare-and-set update, a row lock, a partial unique index. Move
  the enforcing into the definition and there are two authorities to keep in
  step, which is the drift writing it down was meant to end.

- **Every transition is a single atomic write.** Split across two commits, a
  transition has an interval in which the row holds a combination no legal state
  describes — and a crash inside that interval persists it. The row is then wrong
  and stays wrong.

- **An invariant is encoded once.** Restating one as a database constraint
  alongside the code that already checks it doubles the maintenance and
  reintroduces exactly the divergence a single definition prevents.

- **Redelivery is not repair where the downstream call adjusts by a delta.** A
  retry queue in front of a relative, non-idempotent API re-applies the change it
  was sent to fix. Recover by comparing against observed state instead, and
  repair from that.

The failure is invisible in review, because every write in the sequence is
correct on its own. It appears as a row nobody can explain — a place granted and
a seat still held against it — long after the process that produced it exited.

---

## We name the role, not the vendor

- **A rule that governs agents says "agent", never a product name.** More than
  one works in this repo: `AGENTS.md` is the shared contract, and `CLAUDE.md`,
  `GEMINI.md` and `.jules/sentinel.md` carry what is specific to each. A
  convention written against one product binds that product alone — every other
  agent is exempt from it while appearing to be covered.

- **Where an artifact records which agent produced it, the agent supplies its
  own name.** The rule fixes the field, not the answer. "Ends with a line naming
  the agent" is a rule; "ends with `Posted by <product>`" is that product's
  configuration written into everyone's rulebook.

- **Product-specific detail belongs in that product's own instruction file** —
  where a reader already looks for it, and where it can be deleted along with
  the tool.

This does not reach *records* of work already done. A comment that says which
agent wrote it is a fact about that comment and stays true; the convention
governs the rule, not the audit trail it produced.

The failure is a rule that looks universal and is not. It reads as satisfied,
because the named product does obey it and reviewers watch it obey — while the
same work done by any other agent is silently unbound. It surfaces when the
lineup changes, and the convention turns out to have described a vendor rather
than a practice.

---

## A check that costs money is not a health check

- **A dependency billed per wake is read when a person asks for it, never on a
  schedule and never on a render.** The store mirror sleeps when idle and is
  charged for waking; that is why its catch-up runs on a cadence rather than
  continuously, and why its diagnostics and audit reports sit behind a button.

- **An always-on indicator reports whether something is configured, never
  whether it answers.** Turning a presence check into a live one puts a paid
  call behind every page load, and the badge that polls it makes that per
  visitor per minute.

The change that breaks this reads as an improvement. "The dashboard only says
the integration is configured — let's make it actually check" is better by every
measure a reviewer can see in the diff. Nothing fails, no test bills, and the
cost arrives a month later attached to no particular change.

---

## A tool that writes for real never points at production

- **Automation that creates, changes or deletes objects in a real external
  system — a contract test, a sweeper, a one-off script — runs against a
  non-production instance and refuses the production one outright.** The refusal
  lives in the code that does the writing, not in the configuration handed to it.
  — *Principle: fail closed*

- **Aiming one somewhere new takes two deliberate edits in two places, never a
  single setting.** One variable is the whole distance between a scratch
  environment and the live one, and it is a distance a typo covers.

The failure is not a broken tool. It is a tool working exactly as written against
whatever it was told to point at: nothing in the run looks wrong, because nothing
was wrong except the target, and by the time anyone reads the output the objects
are already gone.

---

## A day is not a moment

- **Every temporal field is one kind or the other, and the column type says
  which.** A moment is a point on the timeline: a visit arrival, an event's
  start, an audit stamp. A day has no time and no zone: a date of birth, a
  program's start and end, a membership's start, a background-check day, the
  membership-year boundary. Days are stored as a database `date`, so the
  classification survives a writer who has never read this file.

- **A day is read, rendered and aged without a zone.** Putting a wall-clock zone
  on one yields the day before for every reader west of it, and an age taken from
  its local fields flips on the person's own birthday.

- **A moment is displayed in the zone the organisation configured**, never one
  compiled in. The exception is a native local-time input, which is local to
  whoever is typing in it by definition.
  — *Principle: this codebase is not this organisation*

- **A day is never taken from a moment.** Keeping the date part of "now" answers
  in whatever zone the process happens to be running in; a day comes from a day.
  When "today" genuinely is the question — an age as of now — name the zone that
  decides it: `orgCalendarDay()` in `lib/time.ts` is the one seam that turns an
  instant into a day, and every caller downstream of it works in days.

Nothing in the type system separates the two: both are a date object in the code,
and in a UTC test environment both are right. The failure appears later as a
birthday rendered a day early, an age gate that turns someone away on the morning
they qualify, or a second record for a person because a lookup by exact date
missed a row stored at a different time of day.

---

## A library names its failures; the host renders them

- **Every expected failure in a hosted library leaves it as an HTTP status, never
  a 500.** Its services throw `ServiceError(status)` from `@checkin/component-kit`
  and its route factories throw the kit's `httpError(status, message)`: 400 for
  validation, 403 for forbidden, 404 for not found, 409 for a conflict or a
  duplicate. A zod parse that fails anywhere in the call is a 400 with the first
  issue's message. The host's `componentRoute()` (`lib/components/route.ts`)
  renders all three as checkin's API error; anything else is rethrown and the host
  answers an opaque 500. The kit's tests and the host wrapper's test pin this.

- **A duplicate the service expects is caught by the service.** A unique-key race
  it can tolerate is caught where it happens and re-read or thrown as
  `ServiceError(409)`. A P2002 that escapes uncaught is a bug and stays a 500,
  logged with enough to find the missing handler: `handler()` logs the route's
  endpoint and the error itself, whose `meta` names the colliding constraint.
  Nothing on the way may swallow or rewrap it into a bare message.

- **A Prisma error is recognised by its `code`, never by `instanceof`.** Clients
  are memoized on `globalThis`, and the instrumentation chunk that configures a
  library and each route chunk can load separate copies of the generated client,
  so the class identity differs. The library's `isUniqueConstraintError` and
  checkin's `isPrismaError` (`lib/prismaUniqueViolation.ts`) read the code. For
  the same reason the kit's own errors are recognised by a `Symbol.for` brand,
  not by class.

The failure shows only in a built app. In unit tests every module is loaded once,
so `instanceof` holds; in the server, the same 409 arrives as an error from
another copy of the class and the caller sees a 500.
