import { readdirSync } from 'fs';
import { join } from 'path';
import { PAGES, REGISTRY_EXCLUDED } from '@/components/pageRegistry';
import { FACILITY_NAV_LINKS } from '@/lib/facilityNav';

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

  it.each(FACILITY_NAV_LINKS)('$href is listed to operations iff its page admits them', ({ href, roles }) => {
    expect(entryFor(href).visible(ops, true, null)).toBe(roles.includes('isOperations'));
  });

  it('lists the /facility-ops index to operations (it redirects into their first visible tab)', () => {
    expect(entryFor('/facility-ops').visible(ops, true, null)).toBe(true);
  });

  it('still shows every Facility Ops entry to a board member', () => {
    const board = { isBoardMember: true };
    for (const p of PAGES.filter((p) => p.section === 'Facility Ops')) {
      expect(p.visible(board, true, null)).toBe(true);
    }
  });

  // Q15: keyholders review unsynced scans; operations stay at aggregate only.
  it('lists /system-status/unsynced-scans to keyholders and not to operations', () => {
    const entry = entryFor('/system-status/unsynced-scans');
    expect(entry.visible({ isKeyholder: true }, true, null)).toBe(true);
    expect(entry.visible({ isOperations: true }, true, null)).toBe(false);
  });
});

// #1569: the two divergences this change closed. Each row must match the section
// gate it reads from, not the section's coarse "board" default.
describe('Membership Ops directory agrees with the section gates', () => {
  const entryFor = (href: string) => PAGES.find((p) => p.href === href)!;
  const reviewer = { isBackgroundCheckReviewer: true };
  const ops = { isOperations: true };

  it('lists Review to a background-check reviewer', () => {
    expect(entryFor('/membership-ops/review').visible(reviewer, true, null)).toBe(true);
  });

  it('does not list the admin-only tabs to a reviewer', () => {
    for (const href of ['/membership-ops/applications', '/membership-ops/roles', '/membership-ops/households']) {
      expect(entryFor(href).visible(reviewer, true, null)).toBe(false);
    }
  });

  it('lists Participants (only) to operations', () => {
    expect(entryFor('/membership-ops/participants').visible(ops, true, null)).toBe(true);
    expect(entryFor('/membership-ops/review').visible(ops, true, null)).toBe(false);
    expect(entryFor('/membership-ops/roles').visible(ops, true, null)).toBe(false);
  });
});

describe('Shop Ops directory agrees with the section gates', () => {
  const entryFor = (href: string) => PAGES.find((p) => p.href === href)!;
  const certifier = { toolStatuses: [{ level: 'MAY_CERTIFY_OTHERS' }] };

  it('hides Create from a certifier who is neither sysadmin nor board (gate is admin)', () => {
    expect(entryFor('/shop-ops/create').visible(certifier, true, null)).toBe(false);
    expect(entryFor('/shop-ops/create').visible({ isBoardMember: true }, true, null)).toBe(true);
  });

  it('still lists Manage and the hub to a certifier', () => {
    expect(entryFor('/shop-ops/manage').visible(certifier, true, null)).toBe(true);
    expect(entryFor('/shop-ops').visible(certifier, true, null)).toBe(true);
  });
});
