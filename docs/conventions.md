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
  an address left on a merged record still resolves somewhere, and somewhere is
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

## A library's pages share one client kit

- **Package UIs take their fetch helpers, `LoadError`, `Pager` and paging from
  `@checkin/component-ui`, and format money with `@checkin/money`.** Each
  package binds its route base once with `createClient`.
- **A package page learns who is looking from `useViewer()`, never from the
  host's session.** The host maps its session onto `Viewer` once, in
  `checkin-app/src/components/AuthProvider.tsx`. A new role a package needs is
  a new `Viewer` field.

---

## A paged list keeps its place in the URL

- **A paged list keeps its page in the URL query (`page`), with the filters,
  view tabs and sort that decide its rows.** A reload, the back button and a
  shared link land on the same rows, and each page is its own page view in the
  finance view log.
- **Typed search text stays out of the URL.** It lives in the screen's state,
  and a change starts again on page 1. Selects, date pickers and toggles go in
  the URL.
- **Paging pushes a history entry; a filter, view or sort change replaces the
  entry and drops `page`.** Back steps through pages, not filter states.
- **A bad or out-of-range `page` never shows an error.** A missing,
  non-numeric, zero or negative `page` is page 1. A list that knows its total
  shows its last page for a page past the end; a list without one shows the
  empty page with its pager.
- **`limit` stays out of the URL** while no screen lets anyone pick a page size.
- **Read and write it with `@checkin/component-ui`'s `useUrlPage`,
  `useUrlFilter`, `useUrlChoice` and `useSetUrlFilters`**, never `useState`
  for the page or a filter.

---

## A shared helper has one home

- **Before writing a small helper, look in the package that owns its kind, and
  add a new one there rather than copying it.**
  - `@checkin/component-kit`: a library's errors, route parsing (`parseId`,
    `readJson`, `parseBody`) and runtime (`defineRuntime`, which gives `getOrgId`).
  - `@checkin/pg-kit`: the advisory lock, unique-race retries and the lazy Prisma
    client. `monitoring-db` and `s-ingest-core` wrap the lock only to bind their
    own database.
  - `@checkin/quickbooks`: moving a day for a books window (`shiftDate`).
  - `@checkin/money` and `@checkin/component-ui`: as the section above says.

---

## One process, one implementation

- **A step that happens in two places is one piece of code both call.** When
  the same decision, check or sequence of steps is needed by two libraries, two
  kinds of record or two routes, it is written once and both call it. A copy, a
  near-copy or a second implementation "for our side" is a fork: the two drift,
  and each fix lands in only one of them.
- **A record crosses into another library only to change owner.** Handing a
  record to the library that takes the next step is fine when nothing flows
  back and the hand-over is audited and either atomic or retried. Copying it so
  another library can run the same steps on its own copy is the fork above.
- **Where the domain says two things are treated the same, they run the same
  code.** "The same rule" kept true by two implementations is a rule waiting to
  diverge.

The failure is slow. Each copy is correct the day it is written; the defect is
the later fix that reaches one of them.

---

## A simple machine with a known risk beats a complete one nobody can read

- **Whether a step can be undone depends on what undoing it costs, and where.**
  - **A bad state that lives entirely in the app, the app must give a way out
    of.** Nobody can repair it by hand without editing the database, so the
    software owes a path back: an undo, or a reset that returns the record to a
    known starting point and has it go through again.
  - **A decision whose effects are outside the app may be declared
    irreversible.** Once it has reached the books, a physical label or another
    party, unwinding it in the app would mean modelling every outside effect
    to keep them in step. Past that point the app says the decision is final,
    and a mistake is cleaned up by hand. That costs a person some work, and it
    keeps the machine readable. The point is chosen, stated and the same
    everywhere the decision is taken.
- **Take a decision as late as it can be taken, after the things that could
  reverse it.** A decision taken before its record settles needs machinery to
  unwind it when the record moves; one taken after needs none.
- **An edge case the design does not handle is an accepted, written-down risk,
  not a branch.** Record how it could happen, what it costs when it does, and
  how it is cleaned up by hand. Do not add a state, flag or route whose only
  purpose is a case that rarely or never happens.
- **A state nothing can reach is removed.** Code for an unreachable case is not
  insurance; it is a second account of the system that every reader has to
  disprove.

The failure is unreadability. A machine that covers everything is one nobody
can hold in their head, and the bugs live in the transitions nobody traced.

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
  A `ServiceError` may also carry a `code`, for a UI that branches on it; the host
  sends it as `{ error, code }`. `ReviewError`, `PaymentError`, `ExternalError`,
  `RenewalError` and `TrustedAdultError` extend `ServiceError` and read their
  status from `lib/domainErrorResponse.ts`.

- **A library's runtime fails closed.** Each library
  builds its runtime with the kit's `defineRuntime`. Until the host configures
  it, an accessor that needs the configuration throws. `configured()` and
  `getOrgEventConsumers` return nothing instead, for reads that must not throw,
  such as one after a commit. A missing principal, or one without an integer id,
  is a 401. An unbound push or write port throws rather than report success,
  usually `NotWiredError`. Expense's outbound gateway and the add-person port in
  expense and receipt throw a plain `Error`.
  Donations' capital review is the exception that does nothing when unbound, since
  no line then goes to review. An unbound read port falls back to an inert adapter
  that returns an empty result, or throws where it has no answer to give: expense's
  QuickBooks reader throws `QuickBooksNotConnectedError`, and every library's
  catalog reader and catalog event source throw `NotWiredError`, so an unbound
  catalog never reads as "no match" or "no events". A route that reads an
  unbound catalog answers 503 "No catalog is connected"; a missing catalog database
  answers 503 naming who fixes it; an outage stays 502. A route or matcher reads only
  `NotWiredError` as "not connected", never another `settings` failure, and tests
  for it with the kit's branded `isNotWired`; the kit's `catalogSettingsMessage`
  holds both 503 wordings. The catch-up sweep records an unbound event source as
  `notConnected` and raises no alert; any other failure to read, a missing catalog
  database included, is an unreadable catalog and alerts. A callee that takes an `orgId`
  from its caller checks it with `assertOrg` first.

- **At a crossing, a callee's 4xx means refused for good.** When one library
  calls another, a `ServiceError` or http error in the 4xx range, or a
  validation error (400), means the item will never pass: the caller stops
  retrying and shows a person. A 401, a 403 and a 429 are not refusals: a 401
  or 403 is a bug in our wiring or the system actor's permissions, a 429 a
  passing overload. Anything else means try again. A
  callee never throws a 4xx for something that could pass later, nor a plain
  error for an item it will never take. "Already done" is a return value, never
  a throw. The kit's `kindOf` reads errors this way, at system-actor crossings;
  a 403 for a person's own permission is shown to that person as a refusal and
  is not read through `kindOf`.

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

---

## A person is told what happened in one way

This is the rule for new code, in the host and in every library. Existing pages
move to it in later changes.

- **An action that worked says so in a floating message that goes away by
  itself.**

- **An action that failed says so in a message that stays in the lower right
  until the person dismisses it, or until a retry replaces it or a later success
  clears it.** It survives moving to another page, because a person who clicked
  away may not have read it. This holds while a modal is open; the modal stays
  open. A display nobody attends is the exception, under its own rule below.

- **A page that could not load says so in place of its content, with a retry.**
  An empty space must never read as an empty list.

- **A broken input is highlighted on the input.** A refusal from the server that
  concerns one field names that field in its words, or sends the field name so
  the form can highlight it. Sending the field name is the long-term aim.

- **A condition that is true now is shown inline for as long as it is true.** A
  failing supervision check, a missing emergency contact and a broken checkout
  are conditions, so a dismissal must not be able to clear them. If the app can
  still show it after a reload, it is a condition. Anything else a save leaves
  the person to read stays in the lower right in yellow until dismissed.

- **A display nobody attends raises no message that waits to be dismissed.** A
  kiosk screen shows its state inline, because nobody is there to clear it. This
  overrides the rule that an action that failed keeps a message in the lower
  right.

- **A message that stays on screen carries the server's chosen words or fixed
  text, never exception text.** It holds no personal detail the current page
  would not show, because anyone walking past can read it.

The failure is a message nobody sees: a red line above the fold while the person
is looking at the Save button at the bottom, or a blank list that looks like an
all-clear.

---

## The dictionary's word is the code's word

- **Identifiers, comments and prose use the canonical term** from
  `docs/VOCABULARY.md`. No `minor`, no loose `dependent`, no bare
  `member`, in identifiers or in comments. `child` is allowed: it names a
  relationship (offspring), and `youth` names the under-18 age.

- **A serialized API key is a contract, not a free rename.** A request or
  response key changes only in the change that owns that contract, with every
  consumer moved together. Surrounding variables rename freely; the key waits.

- **Age is derived from `dateOfBirth` through `isYouth`**, never by an inline
  age check.
