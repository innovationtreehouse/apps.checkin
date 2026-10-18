# Presence-record identity tiering: inconsistency report

_Investigation, 2026-07-02. Read from code, not comments. `auth-consistency-analysis.md`
is treated as stale per `checkin-app/src/security/scopeBindings.ts`._

## TL;DR

The same concept — _which person a presence record belongs to_ — is tiered three ways:

- `Visit.participantId` = **public**
- `RawBadgeLog.participantId` = **internal**
- and on `Visit` the _timestamps_ (`arrivedAt`/`departedAt` = **personal**) are protected
  while the _identity_ on the same row is **public** — backwards.

**Real leak today: none via truly-anonymous routes.** But `public` here means "low harm,"
not "intended for the public," so `Visit.participantId` has zero protection the instant any
public surface returns a Visit. And a tier change is **inert** for nearly all Visit
consumers: only 2 of them route through the stripper.

---

## 1. Ground-truth: every read surface returning these fields

### Visit (`checkin-app/prisma/schema.prisma:759`)

| # | Consumer | Auth gate | Through `handler()`? | Fields on wire | Reachable by |
|---|---|---|---|---|---|
| 1 | `GET /api/profile` (`registry.ts:14`) | `self` | **Yes — stripped** | nested visits | the participant themselves |
| 2 | `GET /api/events/[id]` (`registry.ts:68`) | `authenticated` + inline event→program staff gate | **Yes — stripped** | nested visits | this event's lead/core-vol, board, sysadmin |
| 3 | **`GET /api/attendance`** (`attendance/route.ts:52,57`) | kiosk-tolerant; `getOptionalSessionUser` + kiosk-sig | **No — hand-rolled** | **full `attendance[]` → all Visit scalars incl `participantId`, `arrivedVia/departedVia`, `associatedEventId`, `arrivedAt/departedAt`** | **kiosk device** (signed; or cookieless in `CHECKIN_ENV=local`) and any `isAdmin`; plain member gets `access:limited` = self + household visits (still full scalars) |
| 4 | `GET /api/facility/visits` (`facility/visits/route.ts:9`) | `isSysadmin`/`isBoardMember` | No — hand-rolled | full Visit rows (take 50) | board, sysadmin |
| 5 | `GET /api/household/visits` (`household/visits/route.ts:39`) | `{}` + inline `auth.type==='session'` | No — hand-rolled | full Visit scalars, own household only | any authenticated member (own household) |
| 6 | `GET /api/profile/visits` (`profile/visits/route.ts:30`) | session, `participantId=userId` | No — hand-rolled | `select` limited — **no `participantId`** | self only |
| 7 | `GET /api/facility/trends` (`facility/trends/route.ts:104`) | `isSysadmin`/`isBoardMember` | No — hand-rolled | aggregated hours; `participantId` used internally, **not** in response | board, sysadmin |
| 8 | `GET /api/nav/todo-counts` (`route.ts:205`) | authenticated | No | `count()` only | n/a |
| 9 | `getFullAttendance()` (`lib/getFullAttendance.ts:5`) — spreads `...v` (all scalars) | — | No (lib) | feeds #3 only | via #3 |

**Claim check — "NO public/anonymous route returns Visit rows":** ✅ **true for genuinely
anonymous callers on prod/dev** (they get 401 at `/api/attendance` when a kiosk key is
configured). ⚠️ **but a KIOSK device gets the full facility roster incl. `participantId`**
(#3), and a kiosk holds no session and no per-row scopes. In `CHECKIN_ENV=local` a cookieless
caller is _treated_ as kiosk (`attendance/route.ts:42-47`) — anonymous-equivalent locally,
gated off on cloud.

### RawBadgeLog (`checkin-app/prisma/schema.prisma:744`)

| Consumer | Auth | `handler()`? | Reachable by |
|---|---|---|---|
| `GET /api/facility/badges` (`facility/badges/route.ts:9`) | `isSysadmin`/`isBoardMember` | No — hand-rolled | board, sysadmin only. Ships `participantId`(internal) + `timestamp` + `location` |
| `…/merge/analyze` (`route.ts:31`) | board | No | `count()` only |

**RawBadgeLog never passes through `handler()`.** Its `internal` tier is inert; board sees
everything anyway. No member/kiosk/anon reaches it.

### TrustedAdultReview `.householdId` / `.kind` (public)

Returned only by 3 **stripped** registry routes: `trusted-adults/mine` (household member),
`trusted-adults/operational` (keyholder/program-lead, row-scoped), `safety/trusted-adults`
(board). All authenticated + row-scoped (`scopeBindings.ts:117`). Other hits
(`lib/trusted-adult/service.ts`) are internal service logic / email builders — not HTTP field
surfaces. **No public/anon consumer → latent only.**

### Membership `.status` / `.isVolunteerFamily` (public)

No route ships raw `Membership` rows to anon; consumers are internal payment/renewal/review
libs + board `membership-ops`. **Latent only.**

---

## 2. Real vs latent risk

- **Leaks today:** none to anonymous public. The widest _actual_ audience for
  `Visit.participantId` is the **kiosk presence board** (#3) — a signed device, plus every
  authenticated member for their own household. That's a deliberate product surface, not an
  accident.
- **Latent risk (the real concern):** `public` is doing the job of "low harm if seen," not
  "meant for the public." `Visit.participantId` + `associatedEventId` carry **no gate at
  all** — the moment someone adds a public/kiosk route returning a Visit (easy: the
  attendance board is _already_ the pattern), the full who's-here-and-at-which-event
  association ships with zero stripping. Same shape for `TrustedAdultReview.householdId/kind`
  and `Membership.status/isVolunteerFamily`: safe only because no public route reaches the model
  yet.
- **The inversion:** on one Visit row, `arrivedAt`/`departedAt` = `personal` but
  `participantId` = `public`. Knowing _when_ someone was present is gated; knowing _who_ is
  not. Backwards — identity is the more sensitive half.

---

## 3. Recommended tiering

**Primary (option a + c hybrid):**

| Field | Now | Target | Why |
|---|---|---|---|
| `Visit.participantId` | public | **`personal`** | Same identity concept as `RawBadgeLog.participantId`; align the _identity_ with the _timestamps already on the same row_ (`arrivedAt`/`departedAt` = personal). Kills the inversion. Already scope-bound: `their_own` (participantId=selfId) + `all_current_visitors` (`scopeBindings.ts:95-100`) — so `personal` is enforceable per-row, no new plumbing. |
| `Visit.associatedEventId` | public | **`personal`** | "who attends which event" is the same association; move it with participantId. |
| `Visit.arrivedVia` / `departedVia` | public | **stay public** | Enum `SCANNER`/`WEB`/`SYSTEM` — genuinely non-identifying. Option (c): coherent to leave. |
| `Visit.id` | public | stay public | Surrogate key, meaningless alone. |
| `RawBadgeLog.participantId` | internal | **keep internal, or relax to `personal` to exactly match Visit** | Defensible to keep stricter (raw scanner audit, board-only). If you want _one_ tier for "presence identity," drop to `personal`. **Pick one and document the split** — the gap itself is the current smell. |

**Not recommending `member`** for `Visit.participantId`: kiosk holds only `public` (never
`member`, per `core.ts:8-10`), so `member` would hide participantId from the kiosk board — a
`personal` + `all_current_visitors` scope keeps the board working (see §4).

**Option (b) — the one real "keep it visible" consumer:** the **kiosk attendance board**
(`/api/attendance` full, #3). It legitimately needs `participantId` to key rows and link
presence to people. This is the named product need. It's covered _without_ keeping the field
`public`: `Visit` already binds `all_current_visitors` (keyholder + `departedAt IS NULL`), so
a stripped kiosk view can grant `all_current_visitors:personal` and see present visitors'
identity while `personal` still gates everyone else.

---

## 4. Migration-safety / enforcement caveat

**A tier change alone changes nothing at runtime for 7 of the 9 Visit consumers.** Only
`/api/profile` and `/api/events/[id]` route through `handler()` and would honor a retier
immediately (both already show identity to their audiences, so no visible change there
either).

To give the retier teeth, these must migrate to `handler()` (or get a manual `select` trim):

| Consumer | What must change | Behavior change if `participantId`→`personal` under the stripper |
|---|---|---|
| **`/api/attendance` (kiosk board, #3)** | migrate to handler; give kiosk view an `all_current_visitors:personal` grant | **This is the one that would break** if migrated naively — kiosk holds only `public`, so participantId vanishes unless the scope is granted. Name it explicitly in any migration. |
| `/api/household/visits` (#5) | migrate; member needs `their_households:personal` (Visit isn't `their_households`-bound today — only `their_own`/`all_current_visitors`) | member would lose household-mates' participantId unless a new binding/scope added |
| `/api/facility/visits` (#4) | migrate; board holds `everyones:personal` → no change | none (board already sees all) |
| `/api/facility/trends` (#7) | already omits participantId from response | none |
| `/api/facility/badges` (RawBadgeLog) | migrate if you want the internal tier enforced | none today (board-only) |

**Bottom line for the decision:** the coherent fix is small in the schema (4 tag edits) and
already supported by existing scope bindings — but it's **cosmetic until the hand-rolled
routes move to `handler()`**. The retier's _value_ is making the policy machine-readable so
the _next_ route to return a Visit fails safe. If you only touch tags and not routes, document
that it's a latent-risk fix, not a runtime one. Do **not** touch `/api/attendance`'s kiosk
grant without treating the presence board as a first-class consumer.
