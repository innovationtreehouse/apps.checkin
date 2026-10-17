# Page index: plan to retire this doc

## Problem

The page index shipped: a signed-in person can open one page that lists every
page they are allowed to reach, and search it by name. This doc was the design
for it. It still sits among the standing design documents, where a reader takes
it as current guidance, and its "deferred" list reads as planned work when
nobody has asked for any of it.

## Objective

The doc is gone. It carries no standing rule to extract, and the nice-to-haves
end up either in the backlog or dropped (owner question IPS-2).

## Executive summary

- **For people using the app:** nothing changes. The index page stays as it is.
- **For developers:** nothing new to follow. The rules the index relies on are
  already written down (below).
- **Not planned here:** a command palette, rebuilding the navigation from the
  page list, badges, favourites. None has a requester.
- **Cost:** two docs-only PRs (this one and the retirement). A code cleanup
  found while checking goes to its own issue, filed when the retirement lands.

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
is the arrangement the existing convention forbids. The owner wants it filed as
an issue (IPS-3), separate from retiring this doc.

## The deferred extras

| Extra | What it is | What it would take | Recommendation |
|---|---|---|---|
| **Command palette** | A keyboard shortcut (Cmd-K) that opens a search box over any page, jumping straight to a result. | One client component over the existing registry, mounted in the app frame. Small. No new route, and no security surface, since it filters on the same gates the index does. | **Leave parked** as backlog PL10 (issue #1309), where it already sits with keyboard navigation. No requester. Nothing in this doc is needed to build it later; the registry is the whole design. |
| **Detail pages in results** | Search that finds a specific person, program or tool, not only named pages. | A new server search route across several models. That route needs its registry entry PR first, based on main, not stacked; it must not answer differently for records the viewer cannot see (*Principle: no existence oracle*). Medium, security-heavy. | **Leave parked** with PL10. Not worth a design until someone asks; people search already exists where it is needed. |
| **Navigation built from the registry** | Generate the top navigation from the page list, so there is one list instead of two. | A rewrite of `NAV_ITEMS` in `AppFrame.tsx`. The two lists have different shapes: the nav carries icons, landing redirects, tab sets and dev-only entries the registry has no use for. Medium, touches every signed-in page. | **Drop.** The drift it guards against is already covered by the test and by the gate modules. The narrower fix for the copies that do exist is IPS-3. |
| **Badges on index rows** | A to-do count next to each page, like the nav shows. | The index already fetches the counts; roughly twenty lines. | **Drop.** The nav already shows the counts; nobody has asked to see them twice. |
| **Recently visited / favourites** | Sort the index by what the viewer uses. | Browser storage (small) or a stored preference (schema plus route). | **Drop.** No requester. |

## PR plan to retirement

One chip per PR. Docs-only PRs run no tests.

1. **This PR**: move the doc to `docs/in-design/` and write this plan, and
   point the code comment in `pageRegistry.ts` at the principle it relies on.
2. **Retire** (docs only, after IPS-2 is answered):
   - Act on IPS-2. "Drop" changes nothing in the backlog, since PL10 stays.
     "Park" adds a backlog line for each kept extra.
   - Delete `docs/in-design/INDEX_PAGE_SCOPING.md`.
   - Update the INDEX_PAGE_SCOPING row in
     `docs/in-design/DOCUMENTATION_MIGRATION.md` if that doc still exists.
   - Check that `grep -rn INDEX_PAGE_SCOPING` returns nothing.
   - Once it lands, file the IPS-3 issue: the Shop Ops nav entry should call
     `shopRoles()` from `lib/shopNav.ts`, and that part can be built now. The
     three "sysadmin or board" gates wait on the open decision about what
     "admin" means. A fix touches `AppFrame.tsx`, `pageRegistry.ts` and the
     section layouts, adds no route, and changes no boundary file.

## Owner questions

- **IPS-1 — Extract the section-gate rule?** *Answered: no.* It is a technical
  detail, not a rule the Board cares about. Nothing is extracted, and the
  conventions file stays as written.
- **IPS-2 — Drop the unbuilt extras not already in the backlog?** *Open.*
  Building the navigation from the registry, badges on index rows, and
  favourites would go away for good. The command palette and detail search stay
  parked as PL10, unchanged. *Recommendation: drop. See the table above for
  what each extra is and what it would take.*
- **IPS-3 — File an issue to remove the restated nav gates?** *Answered: yes*,
  filed when the retirement PR lands. The Shop Ops gate can be fixed now; the
  three "sysadmin or board" gates wait on the decision about what "admin" means.
