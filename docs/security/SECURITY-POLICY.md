# Security Policy Layer

## Why this exists

Three production bugs leaked PII through API responses (#129, #127, #122). The pattern was the same each time: a route handler returned more fields than it should have, no automated check caught it, and a contributor PR sailed through review.

This layer makes that class of bug unmergeable without maintainer review.

## How it works

```
prisma/schema.prisma          ← /// @sensitivity:<tier> on every field
        │ prisma generate
        ▼
src/security/generated/       ← classifications.ts (don't edit by hand)
        │ imported by
        ▼
src/security/registry.ts      ← role × token-grant matrix per endpoint
        │ enforced by
        ▼
src/security/handler.ts       ← every route wraps its logic in handler()
                                — only legal way to ship a response
```

Plus:

- **`scripts/check-route-coverage.ts`** (CI lint) — fails the build on unregistered routes, direct `NextResponse.json` in migrated routes, or third-party `fetch` outside the gateway.
- **`tests/security/policy.contract.test.ts`** — for every (route, role) pair, sends a real request and asserts the response only exposes fields whose tier the view grants.
- **`.github/CODEOWNERS`** — every file above requires maintainer approval to change.

## The token model

Schema annotations classify *data*. Registry views grant *access* in the form of permission tokens.

**Tier** (intrinsic to the field — pure data classification):

| Tier | Meaning |
|---|---|
| `public` | Anyone can see it (Participant.name, Program prices, public roles) |
| `pii` | Personally identifying (email, phone, dob, googleId) |
| `personal` | Private but not identifying (Household.address, emergency contacts) |
| `internal` | Role/audit metadata (sysadmin flag, lastBackgroundCheck, audit logs) |
| `secret` | Cryptographic — never returned to any client (oauth tokens) |

**Scope** (per-row, computed by the handler for each row in the response):

| Scope | Reads as |
|---|---|
| `everyones` | "everyone's …" — no relationship check (broad grant) |
| `their_own` | "their own …" — row owner is the caller |
| `their_households` | "their households' …" — caller and row owner share a household |
| `led_households` | "their led households' …" — caller is a **lead** of the row owner's household. Strictly narrower than `their_households`: a non-lead member of the same household does not hold it. Use it where acting for another member is the capability, not merely sharing a home |
| `their_program_participants` | "their program participants' …" — caller leads/coreVols a program containing the row owner |
| `all_current_visitors` | "all current visitors' …" — keyholder view of people currently in the building |

**Token grammar:**
- `'public'` — bare. Public-tier fields, no row gate.
- `'<scope>:<tier>'` — `tier ∈ {pii, personal, internal}`. Grant applies on rows where the caller holds `<scope>`.
- `'secret'` — never appears in any view (type error at registration).

**Field visibility per row:** a field is exposed iff one of:
1. `field.tier === 'public'` AND view contains `'public'`.
2. View contains `'everyones:<field.tier>'` (unconditional).
3. View contains `'<scope>:<field.tier>'` for some `<scope>` the caller holds on this row.

## Contributor cheatsheet

### Adding a new route

1. Create `src/app/api/your-route/route.ts`:

    ```ts
    import { handler, notFound } from '@/security/handler';
    import prisma from '@/lib/prisma';

    export const GET = handler('GET /api/your-route', async ({ auth }) => {
        const data = await prisma.someModel.findMany();
        return { SomeModel: data };
    });
    ```

2. Register it in `src/security/registry.ts` (this PR will trip CODEOWNERS — that's expected):

    ```ts
    defineRoute({
        endpoint: 'GET /api/your-route',
        authorize: 'authenticated',
        envelope: 'data',
        orderedView: [
            ['sysadmin',      ['everyones:pii', 'everyones:personal', 'everyones:internal', 'public']],
            ['authenticated', ['their_own:pii', 'their_own:personal', 'public']],
            ['anyone',        ['public']],
        ],
    });
    ```

3. Add the endpoint key to `scripts/migrated-routes.txt`.

4. Open the PR. CI will:
    - Run `prisma generate` and assert no diff in `src/security/generated/`.
    - Run the route-coverage lint.
    - Run the contract test against every (endpoint, role) pair.
    - Run the existing suite.

### Adding a new field to a model

1. Add the field in `prisma/schema.prisma` with a `/// @sensitivity:<tier>` comment above it.
2. Run `npx prisma generate` and commit the regenerated `src/security/generated/classifications.ts`.
3. If the field should be exposed: nothing else to do unless its tier isn't already covered. Every existing view that grants `*:<that-tier>` will now expose it automatically. A schema tier change is the policy change; maintainer reviews under CODEOWNERS.

### Sending data to a third party

Use `outboundCall` from `@/security/outbound`:

```ts
// src/lib/shopify.ts
import { outboundCall } from '@/security/outbound';
export async function createShopifyOrder(participant, program) {
    return outboundCall('shopify.order.create',
        { Participant: participant, Program: program },
        async (stripped) => fetch(...));
}
```

Register the surface in `src/security/registry.ts` with the tier list you actually need on the wire — anything else (and `secret` regardless) is stripped before `fetch` ever sees it.

```ts
defineOutbound({
    surface: 'shopify.order.create',
    tiers: ['public'], // Only public fields leave to Shopify.
});
```

A library in `packages/*` cannot call `outboundCall`, so its surface is registered and its caller is confined instead: add the `defineOutbound` entry (comment names the file, the host and what data leaves), and add the file to `ALLOWED_PACKAGE_EGRESS_FILES` in `scripts/check-route-coverage.ts`. The lint fails on any third-party host or API SDK reference in package source outside those files (tests and fixtures excluded). A new host or SDK goes into `THIRD_PARTY_HOST_RE` / `THIRD_PARTY_SDK_RE` in the same PR as its surface.

### Serving a stored file

Files are not JSON. A stored file (a receipt image, a PDF) leaves only through a **file route**: `defineFileRoute` in the registry plus `fileHandler` in the route, never `handler()`.

```ts
// registry/<lib>.ts
defineFileRoute({
    endpoint: 'GET /api/things/[id]/file',
    authorize: 'authenticated',             // never 'public' or 'kiosk'
    orderedView: [['authenticated', ['their_own:pii']]],
    file: { model: 'Thing', field: 'fileBlob' },
});

// src/app/api/things/[id]/file/route.ts
export const GET = fileHandler('GET /api/things/[id]/file', async ({ params }) => {
    const row = await prisma.thing.findUnique({
        where: { id: Number(params.id) },
        select: { fileBlob: true, mimeType: true, personId: true }, // + the row's scope keys
    });
    if (!row) throw notFound();
    return { row, contentType: row.mimeType as FileContentType, filename: 'receipt.pdf' };
});
```

- **Same gates as `handler()`.** Authenticate, `authorize`, pick the first matching `orderedView` role, then a per-row check: the view must cover the served field's tier on this row (`fieldVisible` + `scopesHeld`), else 404. The row must carry the fields its scope bindings read.
- **Identified callers only.** Unauthenticated, kiosk, and id-less sessions (no integer `user.id`) get 401.
- **File-only.** A field named by a file route is dropped by the JSON stripper on every route; `src/security/__tests__/file-route.test.ts` sweeps every registered JSON route's views to prove it. A `secret` field cannot be served at all.
- **Headers are fixed per content type** (owner-approved allowlist; any other type is a 500). Every response carries `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`.

| Content type | `Content-Disposition` | `Content-Security-Policy` |
|---|---|---|
| `image/jpeg`, `image/png`, `image/gif`, `image/webp` | `inline` | `sandbox` |
| `application/pdf` | `inline` | none (Chrome's PDF viewer refuses a sandboxed document) |
| `text/plain` (sent as `; charset=utf-8`) | `attachment` | none |

The file route is registered and migrated like any route: the route-coverage lint counts `defineFileRoute` entries, and the endpoint goes in `scripts/migrated-routes.txt`. The handler does not audit, check magic bytes, or stream from storage; those are the route's job (see `docs/in-design/1265_RECEIPT_INTEGRATION.md` §3).

## What this layer does NOT cover (yet)

- **Error responses & logs.** The handler returns opaque `Internal Server Error` 500s, but a richer per-route policy (`errorDetail: 'admin-only'`) is future work.
- **AuditLog content.** `oldData`/`newData` JSON blobs can carry any field — they're written before this layer sees them.
- **Server Components.** All pages are currently `"use client"` and hit `/api/`, so the registry covers everything. A future Server Component reading Prisma directly needs to register too.
- **Per-row scope correctness in the generic contract test.** The generic contract asserts every visible field has a grantable tier, but doesn't verify per-row scope-holding (that would require route-specific personas). Route-specific tests (e.g. `programsIdAPI.test.ts`) cover those.
- **Inbound webhook signature verification.** Already handled at `src/app/api/webhooks/shopify/route.ts`.

## What to do if you hit a wall

You found a case the policy doesn't fit cleanly. Don't disable it — open an issue or message a maintainer. The cost of refining the framework is small; the cost of routing around it is the next #129.
