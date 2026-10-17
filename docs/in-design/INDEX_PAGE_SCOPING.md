# Page index: plan to retire this doc

## Problem

The page index shipped: a signed-in person can open one page that lists every
page they are allowed to reach, and search it by name. This doc was the design
for it. It still sits among the standing design documents, where a reader takes
it as current guidance, and its "deferred" list reads as planned work when
nobody has asked for any of it.

## Objective

The doc is gone. It carries no standing rule to extract. The one extra the
owner wants built, a navigation menu driven by the page list, lives in its own
GitHub issue, and the other extras are parked or dropped.

## Executive summary

- **For people using the app:** nothing changes. The index page stays as it is.
- **For developers:** nothing new to follow. The rules the index relies on are
  already written down (below).
- **Will be built, tracked outside this doc:** the navigation decides which
  sections to show from the page list, so the two can no longer disagree. That
  work also removes the restated gates found while checking.
- **Not built:** the command palette and detail search stay parked in the
  backlog. Index badges are logged as a low-priority issue. Favourites are
  dropped.
- **Cost:** two docs-only PRs (this one and the retirement), plus one code PR
  tracked in its own issue that doesn't hold up retirement.

## Rules this relies on

The doc carries no standing rule of its own. Its two "decisions worth keeping"
are already covered:

- "The index grants nothing": `docs/rules/principles.md`, "Reachability is not
  permission". A listing grants nothing and every page enforces its own gate.
- "Reuse the section gates": a technical detail of how the registry is built,
  not a rule the Board cares about (owner, IPS-1). The general form is already
  in `docs/conventions.md`, "The server decides, the client mirrors", and stays
  as written.

## What is on main (checked 2026-10-16)

| The doc says | Main has |
|---|---|
| `/index` lists every page the viewer may reach, with a search box | Yes. `checkin-app/src/app/index/page.tsx` filters the registry by each entry's gate and by the search text. |
| One flat registry of pages, plus a list of deliberate exclusions | Yes. `PAGES` and `REGISTRY_EXCLUDED` in `checkin-app/src/components/pageRegistry.ts`. |
| A test keeps the registry in step with the page files | Yes. `checkin-app/src/__tests__/pageRegistry.test.ts` fails when a page file is neither listed nor excluded, when an entry points at a page that no longer exists, or on a duplicate. It also pins several sections' gates (Facility Ops, Membership Ops, Shop Ops, Inventory, the receipt mail queue). |
| The nav item sits below Settings, visible to every signed-in person | Yes, in `NAV_ITEMS` in `checkin-app/src/components/AppFrame.tsx`. |
| The registry reads each section's gate from the module that owns it | Mostly. Sections with a gate module (Safety, Finance, Shop, Membership Ops, Facility, Settings, Inventory, libraries) are imported. Three board-or-sysadmin sections have no gate module and spell the role pair inline. |
| Deferred extras | None built. |

**Found in passing.** The navigation restates gates the registry imports. The
Shop Ops entry spells out the certifier test that `shopRoles()` in
`lib/shopNav.ts` already owns. Membership Audit, Program Ops and System Status
each inline "sysadmin or board" in the nav, the registry, and their section
layout, three copies with no shared definition. Nothing has drifted yet, but it
is the arrangement the existing convention forbids. The owner wants it fixed
(IPS-3). Driving the navigation from the page list removes the nav's copies,
so it rides in that issue rather than one of its own.

## The deferred extras

| Extra | What it is | What it would take | Recommendation |
|---|---|---|---|
| **Command palette** | A keyboard shortcut (Cmd-K) that opens a search box over any page, jumping straight to a result. | One client component over the existing registry, mounted in the app frame. Small. No new route, and no security surface, since it filters on the same gates the index does. | **Leave parked** as backlog PL10 (issue #1309), where it already sits with keyboard navigation. No requester. Nothing in this doc is needed to build it later; the registry is the whole design. |
| **Detail pages in results** | Search that finds a specific person, program or tool, not only named pages. | A new server search route across several models. That route needs its registry entry PR first, based on main, not stacked; it must not answer differently for records the viewer cannot see (*Principle: no existence oracle*). Medium, security-heavy. | **Leave parked** with PL10. Not worth a design until someone asks; people search already exists where it is needed. |
| **Navigation built from the registry** | The top navigation decides which sections to show from the page list, so a section appears exactly when the viewer can reach at least one page in it. | See "Navigation from the registry" below. Small to medium; touches every signed-in page. | **Build** (owner, IPS-2), tracked in its own issue. |
| **Badges on index rows** | A to-do count next to each page, like the nav shows. | The index already fetches the counts; roughly twenty lines. | **Logged** as low-priority issue #2278, then dropped from this plan (owner, IPS-2). |
| **Recently visited / favourites** | Sort the index by what the viewer uses. | Browser storage (small) or a stored preference (schema plus route). | **Drop** (owner, IPS-2). |

### Navigation from the registry

**Simplest path:** keep `NAV_ITEMS` for what only the menu needs: order,
icons, landing redirects, tab sets and the dev-only flag. Replace each entry's
hand-written `visible` with one shared test: show the entry when some page in
the registry under that entry's path, or in its tab set, is visible to the
viewer. Folding the two lists into one data structure is the larger version.
It buys nothing extra, because the visibility is the only part that can drift.

- **Files:** `checkin-app/src/components/AppFrame.tsx` (each `visible`
  becomes the shared test, and the inline role imports go);
  `checkin-app/src/components/pageRegistry.ts` (export a "section reachable"
  helper); `AppFrame.test.tsx` and `AppFrame.libraryNav.test.tsx`. No new
  route, no boundary file, no schema change.
- **Size:** roughly 40–80 lines changed, most of them deletions in
  `NAV_ITEMS`.
- **Where it changes behaviour:** today the nav and the registry disagree on
  several hubs. The nav shows Membership Ops to every role in its section,
  while the registry lists the hub page itself only to admins. The nav shows
  Revenue Ops when any tab is visible, while the registry's hub entry is
  board-only. Facility Ops uses a different role list on each side. The
  shared test settles each case by the section's other pages. For example, a
  background-check reviewer still sees Membership Ops because the Review page
  is visible to them. The paths that don't nest also need care: "My Programs"
  pages are listed under Personal, and the Inventory entry covers both
  `/catalog` and `/inventory/org-items`.
- **Test tier:** unit tests (`npm run test:ci`), so it queues for a heavy slot.
  Before the change, a throwaway comparison test on a local proof branch, not
  in the PR, records which entries each seeded persona sees. The PR must
  reproduce that matrix, and every difference becomes an owner decision before
  merge.
- **Risk:** cosmetic, not security. A wrong result hides or shows a menu entry,
  and every page still enforces its own gate (*Principle: reachability is not
  permission*). But every signed-in person sees the menu, so a mistake is
  visible to everyone at once. That is why the persona matrix is the gate.
- **The admin question:** the three "sysadmin or board" sections stop being
  spelled out in the nav, but the registry and the layouts still spell them.
  Those copies wait on the open decision about what "admin" means, and this
  PR doesn't touch them.

## PR plan to retirement

One chip per PR. Docs-only PRs run no tests.

1. **This PR**: move the doc to `docs/in-design/` and write this plan, and
   point the code comment in `pageRegistry.ts` at the principle it relies on.
2. **Retire** (docs only, no longer waiting on anything):
   - File the navigation issue, with the "Navigation from the registry" section
     above as its body. It also covers the Shop Ops gate from IPS-3. The
     building happens there, so retirement doesn't wait for it.
   - Delete `docs/in-design/INDEX_PAGE_SCOPING.md`.
   - Update the INDEX_PAGE_SCOPING row in
     `docs/in-design/DOCUMENTATION_MIGRATION.md` if that doc still exists.
   - Check that `grep -rn INDEX_PAGE_SCOPING` returns nothing.
3. **Navigation from the registry** (code, from its issue, its own chip) —
   needs a heavy slot for unit tests. Not part of retiring this doc.

Splitting the build out is the simpler path. The issue holds the full brief,
so nothing is lost when the doc goes, and a medium refactor that waits in the
heavy queue no longer holds a finished doc open.

## Owner questions

- **IPS-1 — Extract the section-gate rule?** *Answered: no.* It is a technical
  detail, not a rule the Board cares about. Nothing is extracted, and the
  conventions file stays as written.
- **IPS-2 — What happens to the unbuilt extras?** *Answered.* Build the
  navigation from the registry, tracked in its own issue. Log badges as
  low-priority issue #2278. Drop favourites. The command palette and detail
  search stay parked as PL10.
- **IPS-3 — Remove the restated nav gates?** *Answered: yes.* Folded into the
  navigation issue, which removes every nav copy. The three "sysadmin or board"
  copies left in the registry and layouts wait on the decision about what
  "admin" means.
