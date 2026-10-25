import { readdirSync } from 'fs';
import { join } from 'path';
import { PAGES, REGISTRY_EXCLUDED } from '@/components/pageRegistry';
import { FACILITY_OPS } from '@/lib/nav/sections/facilityOps';
import { linkGate } from '@/lib/nav/gates';
import { LIBRARY_KEYS } from '@/lib/libraryRelease';

// Walk src/app for every page.tsx and turn it into its route path, skipping
// dynamic segments ([id]) which the directory deliberately omits.
function routeOf(file: string): string | null {
  const rel = file.replace(/.*\/src\/app/, '').replace(/\/page\.tsx$/, '');
  if (rel.includes('[')) return null; // dynamic route — not directory-listable
  return rel === '' ? '/' : rel;
}

function findPages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findPages(full));
    else if (entry.name === 'page.tsx') out.push(full);
  }
  return out;
}

describe('pageRegistry drift guard', () => {
  const appDir = join(__dirname, '..', 'app');
  const routes = findPages(appDir).map(routeOf).filter((r): r is string => r !== null);
  const known = new Set([...PAGES.map((p) => p.href), ...REGISTRY_EXCLUDED]);

  it('lists or explicitly excludes every static route', () => {
    const missing = routes.filter((r) => !known.has(r));
    expect(missing).toEqual([]);
  });

  it('has no registry/exclude entries pointing at routes that no longer exist', () => {
    const live = new Set(routes);
    const stale = [...PAGES.map((p) => p.href), ...REGISTRY_EXCLUDED].filter((r) => !live.has(r));
    expect(stale).toEqual([]);
  });

  it('has no duplicate hrefs in the registry', () => {
    const hrefs = PAGES.map((p) => p.href);
    expect(hrefs.length).toBe(new Set(hrefs).size);
  });
});

// Operations reaches Facility Ops in aggregate only (#1633): Print ID Badges and
// Participation Trends. Each directory row must agree with the tab's own gate, or
// the directory advertises a page that ejects the viewer — the same fork #1569 is
// about, so the expectation is read off FACILITY_NAV_LINKS rather than retyped.
describe('Facility Ops directory agrees with the section gates', () => {
  const ops = { isOperations: true };
  const entryFor = (href: string) => PAGES.find((p) => p.href === href)!;

  it.each(FACILITY_OPS.links)('$href is listed to operations iff its tab admits them', ({ href }) => {
    expect(entryFor(href).visible(ops, null)).toBe(linkGate(FACILITY_OPS, href)(ops, null));
  });

  it('lists the /facility-ops index to operations (it redirects into their first visible tab)', () => {
    expect(entryFor('/facility-ops').visible(ops, null)).toBe(true);
  });

  it('still shows every Facility Ops entry to a board member', () => {
    const board = { isBoardMember: true };
    for (const p of PAGES.filter((p) => p.section === 'Facility Ops')) {
      expect(p.visible(board, null)).toBe(true);
    }
  });

  // Q15: keyholders review unsynced scans; operations stay at aggregate only.
  it('lists /system-status/unsynced-scans to keyholders and not to operations', () => {
    const entry = entryFor('/system-status/unsynced-scans');
    expect(entry.visible({ isKeyholder: true }, null)).toBe(true);
    expect(entry.visible({ isOperations: true }, null)).toBe(false);
  });
});

// #1569: the two divergences this change closed. Each row must match the section
// gate it reads from, not the section's coarse "board" default.
describe('Membership Ops directory agrees with the section gates', () => {
  const entryFor = (href: string) => PAGES.find((p) => p.href === href)!;
  const reviewer = { isBackgroundCheckReviewer: true };
  const ops = { isOperations: true };

  it('lists Review to a background-check reviewer', () => {
    expect(entryFor('/membership-ops/review').visible(reviewer, null)).toBe(true);
  });

  it('does not list the admin-only tabs to a reviewer', () => {
    for (const href of ['/membership-ops/applications', '/membership-ops/roles', '/membership-ops/households']) {
      expect(entryFor(href).visible(reviewer, null)).toBe(false);
    }
  });

  it('lists Participants (only) to operations', () => {
    expect(entryFor('/membership-ops/participants').visible(ops, null)).toBe(true);
    expect(entryFor('/membership-ops/review').visible(ops, null)).toBe(false);
    expect(entryFor('/membership-ops/roles').visible(ops, null)).toBe(false);
  });
});

describe('Shop Ops directory agrees with the section gates', () => {
  const entryFor = (href: string) => PAGES.find((p) => p.href === href)!;
  const certifier = { toolStatuses: [{ level: 'MAY_CERTIFY_OTHERS' }] };

  it('hides Create from a certifier who is neither sysadmin nor board (gate is admin)', () => {
    expect(entryFor('/shop-ops/create').visible(certifier, null)).toBe(false);
    expect(entryFor('/shop-ops/create').visible({ isBoardMember: true }, null)).toBe(true);
  });

  it('still lists Manage and the hub to a certifier', () => {
    expect(entryFor('/shop-ops/manage').visible(certifier, null)).toBe(true);
    expect(entryFor('/shop-ops').visible(certifier, null)).toBe(true);
  });
});

describe('Inventory directory agrees with the catalog-viewer gate', () => {
  const inventoryEntries = PAGES.filter((p) => p.section === 'Inventory' && /^\/(catalog|inventory\/org-items)/.test(p.href));
  const counts = {
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 0,
    buildingHousehold: 0,
    buildingReachable: true,
    activePrograms: 0,
    releasedLibraries: [...LIBRARY_KEYS],
  };

  it('lists no Inventory entries to an adult with no role or volunteer input', () => {
    expect(inventoryEntries.length).toBeGreaterThan(0);
    for (const entry of inventoryEntries) expect(entry.visible({ ageBand: 'adult' }, counts)).toBe(false);
  });

  it('lists the Inventory entries to an active youth program volunteer', () => {
    const youthVolunteer = { ageBand: 'youth' as const, isProgramVolunteer: true, isActiveOrgMember: true };
    for (const entry of inventoryEntries) expect(entry.visible(youthVolunteer, counts)).toBe(true);
  });
});

// The mail queue shows sender addresses, which FINANCE alone reads; BOARD reads the rest of the review side.
describe('Receipt mail queue is listed to FINANCE only', () => {
  const entryFor = (href: string) => PAGES.find((p) => p.href === href)!;
  const counts = {
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 0,
    buildingHousehold: 0,
    buildingReachable: true,
    activePrograms: 0,
    releasedLibraries: [...LIBRARY_KEYS],
  };

  it('lists /receipts/mail to finance and not to board or sysadmin', () => {
    const entry = entryFor('/receipts/mail');
    expect(entry.visible({ isFinance: true }, counts)).toBe(true);
    expect(entry.visible({ isBoardMember: true }, counts)).toBe(false);
    expect(entry.visible({ isSysadmin: true }, counts)).toBe(false);
    expect(entryFor('/finance/review').visible({ isBoardMember: true }, counts)).toBe(true);
  });
});

describe('Directory rows agree with the gates of the pages they open', () => {
  const entryFor = (href: string) => PAGES.find((p) => p.href === href)!;

  it('lists the certification grid to the roles its API admits, and not to a plain member or FINANCE', () => {
    const grid = entryFor('/attendance/certifications');
    expect(grid.visible({ isKeyholder: true }, null)).toBe(true);
    expect(grid.visible({ isBoardMember: true }, null)).toBe(true);
    expect(grid.visible({ isSysadmin: true }, null)).toBe(true);
    expect(grid.visible({}, null)).toBe(false);
    expect(grid.visible({ isFinance: true, isInventoryManager: true }, null)).toBe(false);
  });

  it('lists Safety Trusted Adults to the board and not to a keyholder', () => {
    const trusted = entryFor('/safety/trusted-adults');
    expect(trusted.visible({ isBoardMember: true }, null)).toBe(true);
    expect(trusted.visible({ isKeyholder: true }, null)).toBe(false);
  });
});
