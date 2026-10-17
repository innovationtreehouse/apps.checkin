# The dev instance

How the app behaves off production: the environment flag, the org-login gate on
the shared cloud dev instance, impersonation, and the dev dashboard's macros,
reset, and ledger.

Read this before adding anything that must not exist in production. The rule it
has to satisfy is
`docs/rules/principles.md` — *a non-production capability is absent in
production*; what follows is how this app satisfies it.

---

## The environment flag

`CHECKIN_ENV` is the single environment-personality switch: `prod`, `dev`, or
`local`. Anything unset, blank, or unrecognised reads as `prod`.

It is deliberately **not** `NEXT_PUBLIC_`, so it is never inlined into the client
bundle — the same image ships everywhere and production simply never sets it.
Read it through the predicates in `checkin-app/src/lib/config.ts` —
`checkinEnv`, `isProd`, `isDevInstance`, `isLocal`, `devToolsActive` — never by
hand. Client components read the environment through `EnvProvider`.

| Value | Where | What it turns on |
|---|---|---|
| `prod` | production | nothing below |
| `dev` | the shared cloud dev instance | whole site behind org login; persona-mint; the dev dashboard; the Zoho and background-check mocks; the real *dev* Shopify store |
| `local` | a developer laptop | all of the above, plus offline sign-in, the Shopify mock, and the keyless kiosk |

**`NODE_ENV` is `production` on every deployed instance, cloud-dev included** —
the standalone server is a production build artifact, so `NODE_ENV` cannot tell
deployments apart. No environment branch may read it: `eslint.config.mjs` bans
`process.env.NODE_ENV` in `src`, exempting only `src/lib/prisma.ts` (test-harness
plumbing — pool sizing, adapter disposal) and tests.

**`stg` is deliberately not one of the three values.** ops-stg deploys with
`CHECKIN_ENV=stg`, which collapses to `prod` — keeping every mock off and
persona-mint unregistered, which is what an environment holding a copy of
production data needs. It is detected by a separate predicate (`isStaging`) that
reads the raw variable, corroborated by the host in `NEXTAUTH_URL`.

**Only `local` treats an unsigned, cookieless request as a kiosk**, and only when
no kiosk public key is configured, so check-in flows can be exercised without
provisioning keys. Cloud-dev does not: it is publicly reachable and requires a
real kiosk key exactly like production.

---

## Running the cloud dev instance

On `CHECKIN_ENV=dev`, middleware requires of every page route a session whose
Google hosted-domain (`hd`) claim is the org domain and whose email is verified.
Anonymous visitors are bounced to `/signin` and can read nothing else. One rule
delivers both "reachable by any org member" and "not world-readable".

The gate is inert on `prod`, and inert on `local` — offline work needs no Google.

Exempt from the matcher: `/api` (routes self-enforce, and a keyed kiosk must
still reach `/api/scan`), `/signin` itself, framework internals, and any path
with a file extension. Static assets must stay reachable — `next/image`
optimises by fetching its source over HTTP, so a gated image source returns a
400 rather than a picture.

---

## Signing in on a laptop

`CHECKIN_ENV=local` has no Google identity: credentials are dummy and the only
working sign-in is persona-mint, through `DevLoginPicker`.

**A bare `signIn("google")` on a logged-out call to action dead-ends every local
test of that flow.** Route logged-out CTAs to `/signin` — the one screen that
branches on the local flag and offers the persona picker in place of the Google
button.

Nothing enforces this. The home page renders the Google button and the persona
picker together, and the app header's "Sign In To Dashboard" is still a bare
Google sign-in with no local escape beside it. A new logged-out CTA reaches
`/signin` by choice, not by a guard.

---

## Impersonation

Picking a persona **mints a real session as that persona** — you become them.
Authorisation sees only the persona and stays impersonation-unaware, which is
what gives exact test fidelity. The alternative — keeping your identity and
threading an effective person through authorisation — forces every authorisation
layer to become impersonation-aware, and one missed layer silently diverges
impersonated behaviour from real behaviour, which defeats the point.

The minted session carries an inert `impersonatedBy` claim, for display and the
ledger only. **No authorisation path reads it, middleware included** — a static
test asserts the resolvers and auth entry points never so much as name it.
— *Principle: identity is not authorisation*

The policy is `evaluateMint` in `checkin-app/src/lib/impersonation.ts`: pure, no
I/O, exhaustively unit-tested. The `persona-mint` provider in `auth-options.ts`
wires it to the caller's decoded session and the target lookup. Three modes —
become a persona, return to the real human, and mint a *guest* session carrying
no participant, so an org member can preview the signed-out UX on the gated dev
instance without dropping their Google session. On `dev` a minted session also
carries the org gate claims, since the middleware must not be taught to read
`impersonatedBy`.

**Any persona is a legitimate target, including sysadmin and board.** The data is
fake and exercising admin flows is a primary goal, so there is deliberately no
persona-role restriction. Adding one would remove the capability, not close a
hole.

---

## The dev fence

Minting can forge any session, so the gate is re-run **in the body** of every
surface that can drive it — the mint provider, the persona lister
(`/api/auth/dev-personas`), and each dev server action — through one shared
predicate, `assertDevActor` in `checkin-app/src/lib/dev/guard.ts`:

- `prod` → `notFound()`, always.
- `dev` → the caller's *current real* session must be a verified org member.
- `local` → relaxed; there is no Google identity on a laptop.

It returns 404 rather than 403, so the surface stays invisible. One extracted
definition means the bar, the mint route, and the server actions cannot drift
apart.

Impersonation targets are additionally restricted to seeded `@example.com`
personas — a caller can never mint a real person, even one present in the dev
database. The persona lister applies the same filter.

`assertDevActor` also returns the real human behind the request
(`impersonatedBy` if impersonating, else the signed-in email) for ledger
attribution.

---

## Data isolation

The dev deployment's `DATABASE_URL` is a `checkin_dev` role scoped to the
`checkin_dev` database, and no production connection string is present in dev
secrets. A forged session, a buggy macro, or the reset button therefore cannot
reach production data — enforced by the database, not by app logic. Every fence
above is defence in depth on top of that, not the primary control.

---

## The dev dashboard

A slide-up drawer, collapsed to a small button by default so it never obscures
the app. It renders only when the instance is non-production **and** someone is
signed in. Server-only config never crosses to the client.

There is **one shared dev instance**, not a sandbox per person. The ledger and
the reset are the whole coordination model.

### Macros

Additive scenario seeders — a family, a program, an event, a set of check-ins.
They never truncate, so testers can stack scenarios; the reset is the only
destructive path.

**Entity creation has one definition.**
`checkin-app/src/lib/dev/seed-helpers.ts` exports the parameterised creators plus
`seedBaseline`, and both the CLI seed (`prisma/seed.ts`) and the macros call
them. A macro that creates entities its own way reintroduces the copy-paste drift
this consolidated.

### Reset

Truncates every application table, then reseeds the baseline. The table list is
read from the catalog at runtime, so a new model is picked up automatically and
nobody maintains a list.

Two tables survive: `_prisma_migrations`, so the schema stays migrated and the
reset takes seconds rather than minutes, and `DevLedger`, because the
coordination history has to outlive it. The confirm dialog shows recent ledger
activity before anything is destroyed.

Deliberately not `prisma migrate reset`: this runs from a live server action on
an always-on shared instance without dropping and rebuilding the schema. Schema
drift is caught by the migration pipeline, not by this button.

### The ledger

`DevLedger` records the last login, impersonation, macro, and reset, **attributed
to the real human** — never to a persona. It is the cross-tester memory: who
touched the shared instance last, and what they did. That is why the reset
excludes it from truncation.

A ledger write is best-effort: it is logged and swallowed on failure, never
allowed to fail the login or reset it accompanies. The dashboard's last-activity
line and the reset confirm dialog read it.
