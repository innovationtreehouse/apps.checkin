import { navBadgeFor, tabBadgeFor, reviewBadges, settingsMisconfigBadge, programsMisconfigBadge, leadsAnyProgram, leadPendingCount, leadConflictCount } from '@/components/navBadges';
import type { TodoCounts } from '@/app/api/nav/todo-counts/route';

const base: TodoCounts = {
  member: { household: [], programs: [], programsAwaitingFinance: 0 },
  building: 0,
  buildingHousehold: 0,
  buildingReachable: true,
  activePrograms: 0,
};

const item = (id: number) => ({ key: `attendance-${id}`, label: `Confirm attendance for E${id}`, href: `/program-ops/sessions/${id}` });

// These tests only exercise pending-attendance counts; totalEnrolled/upcoming are filled to satisfy the type.
const prog = (id: number, name: string, pending: ReturnType<typeof item>[] = []) =>
  ({ id, name, pending, totalEnrolled: 0, upcoming: [] });

describe('staff My Programs nav gate', () => {
  it('hidden when there is no lead bucket', () => {
    expect(leadsAnyProgram(null)).toBe(false);
    expect(leadsAnyProgram(base)).toBe(false);
  });

  it('hidden when lead bucket has no programs', () => {
    expect(leadsAnyProgram({ ...base, lead: { programs: [] } })).toBe(false);
  });

  it('shown once the caller leads ≥1 program — even with zero pending items', () => {
    const counts: TodoCounts = { ...base, lead: { programs: [prog(1, 'A')] } };
    expect(leadsAnyProgram(counts)).toBe(true);
  });
});

describe('My Programs badge count', () => {
  it('sums pending attendance across all led programs', () => {
    const counts: TodoCounts = {
      ...base,
      lead: {
        programs: [
          prog(1, 'A', [item(10), item(11)]),
          prog(2, 'B', [item(20)]),
          prog(3, 'C'),
        ],
      },
    };
    expect(leadPendingCount(counts)).toBe(3);
    const badges = navBadgeFor('/my-programs', counts);
    expect(badges).toEqual([{ count: 3, color: 'treehouseGreen', label: '3 attendance items to confirm' }]);
  });

  it('renders no badge when nothing is pending (green is action-only)', () => {
    const counts: TodoCounts = { ...base, lead: { programs: [prog(1, 'A')] } };
    expect(navBadgeFor('/my-programs', counts)).toEqual([]);
  });

  it('singularizes the label for a single pending item', () => {
    const counts: TodoCounts = { ...base, lead: { programs: [prog(1, 'A', [item(10)])] } };
    expect(navBadgeFor('/my-programs', counts)[0].label).toBe('1 attendance item to confirm');
  });

  it('shows a red conflict badge left of the green pending badge', () => {
    const counts: TodoCounts = { ...base, lead: { programs: [prog(1, 'A', [item(10)])], conflicts: 2 } };
    expect(leadConflictCount(counts)).toBe(2);
    expect(navBadgeFor('/my-programs', counts)).toEqual([
      { count: 2, color: 'red', label: '2 attendance conflicts to resolve' },
      { count: 1, color: 'treehouseGreen', label: '1 attendance item to confirm' },
    ]);
  });

  it('shows only the red badge when there are conflicts but nothing pending', () => {
    const counts: TodoCounts = { ...base, lead: { programs: [prog(1, 'A')], conflicts: 1 } };
    expect(navBadgeFor('/my-programs', counts)).toEqual([
      { count: 1, color: 'red', label: '1 attendance conflict to resolve' },
    ]);
  });
});

describe('My Activities program-payment badges', () => {
  const todo = (id: number) => ({ key: `program-${id}`, label: `Complete enrollment for P${id}`, href: `/programs/${id}` });

  it('no badge when nothing is owed', () => {
    expect(navBadgeFor('/my-activities', base)).toEqual([]);
  });

  it('green for payments due, gray for plans awaiting finance', () => {
    const counts: TodoCounts = { ...base, member: { household: [], programs: [todo(1), todo(2)], programsAwaitingFinance: 3 } };
    expect(navBadgeFor('/my-activities', counts)).toEqual([
      { count: 2, color: 'treehouseGreen', label: '2 program payments due' },
      { count: 3, color: 'gray', label: '3 program payments awaiting finance approval' },
    ]);
  });

  it('singularizes each label and hides each half independently at 0', () => {
    expect(navBadgeFor('/my-activities', { ...base, member: { household: [], programs: [todo(1)], programsAwaitingFinance: 0 } }))
      .toEqual([{ count: 1, color: 'treehouseGreen', label: '1 program payment due' }]);
    expect(navBadgeFor('/my-activities', { ...base, member: { household: [], programs: [], programsAwaitingFinance: 1 } }))
      .toEqual([{ count: 1, color: 'gray', label: '1 program payment awaiting finance approval' }]);
  });
});

const admin = (over: Partial<NonNullable<TodoCounts['admin']>> = {}): TodoCounts => ({
  ...base,
  admin: {
    membership: 0,
    applicationsTotal: 0,
    paymentPlanPending: 0,
    membershipPaymentPlanPending: 0,
    trustedAdults: 0,
    householdsMissingContact: 0,
    unclaimedHouseholds: 0,
    brokenHouseholds: 0,
    brokenEmails: 0,
    settingsMisconfig: 0,
    programsMisconfig: 0,
    openPaymentExceptions: 0,
    ...over,
  },
});

describe('reviewBadges (Review tab + Membership Ops nav)', () => {
  it('no badges without a review block, or when both are zero', () => {
    expect(reviewBadges(base)).toEqual([]);
    expect(reviewBadges(null)).toEqual([]);
    expect(reviewBadges({ ...base, review: { canActOn: 0, approvedAwaitingSecond: 0 } })).toEqual([]);
  });

  it('green for can-act-on, gray for approved-awaiting-second', () => {
    const counts: TodoCounts = { ...base, review: { canActOn: 3, approvedAwaitingSecond: 2 } };
    expect(reviewBadges(counts)).toEqual([
      { count: 3, color: 'treehouseGreen', label: '3 background checks you can review now' },
      { count: 2, color: 'gray', label: '2 you approved, awaiting a second reviewer' },
    ]);
  });

  it('singularizes the green label; hides each half independently at 0', () => {
    expect(reviewBadges({ ...base, review: { canActOn: 1, approvedAwaitingSecond: 0 } })).toEqual([
      { count: 1, color: 'treehouseGreen', label: '1 background check you can review now' },
    ]);
    expect(reviewBadges({ ...base, review: { canActOn: 0, approvedAwaitingSecond: 4 } })).toEqual([
      { count: 4, color: 'gray', label: '4 you approved, awaiting a second reviewer' },
    ]);
  });

  it('folds board queue + can-act-on into ONE green pill on the Membership Ops nav item', () => {
    const counts: TodoCounts = { ...admin({ membership: 2 }), review: { canActOn: 1, approvedAwaitingSecond: 0 } };
    expect(navBadgeFor('/membership-ops', counts)).toEqual([
      { count: 3, color: 'treehouseGreen', label: '2 pending membership reviews; 1 background check you can review now' },
    ]);
  });

  it('collapses to exactly one green + one gray, each summing its two parts', () => {
    const counts: TodoCounts = {
      ...admin({ membership: 2, applicationsTotal: 40 }),
      review: { canActOn: 1, approvedAwaitingSecond: 3 },
    };
    expect(navBadgeFor('/membership-ops', counts)).toEqual([
      { count: 3, color: 'treehouseGreen', label: '2 pending membership reviews; 1 background check you can review now' },
      { count: 43, color: 'gray', label: '40 in-flight applications; 3 you approved awaiting a second reviewer' },
    ]);
  });

  it('hides each pill independently when its parts sum to zero', () => {
    // Only info counts present → green hidden, gray shown.
    expect(navBadgeFor('/membership-ops', { ...admin({ applicationsTotal: 40 }), review: { canActOn: 0, approvedAwaitingSecond: 3 } }))
      .toEqual([{ count: 43, color: 'gray', label: '40 in-flight applications; 3 you approved awaiting a second reviewer' }]);
    // Nothing anywhere → no badges.
    expect(navBadgeFor('/membership-ops', { ...admin(), review: { canActOn: 0, approvedAwaitingSecond: 0 } })).toEqual([]);
  });

  it('prepends a red broken-email pill (before green/gray) on the Membership Ops nav item', () => {
    expect(navBadgeFor('/membership-ops', admin({ brokenEmails: 2 }))).toEqual([
      { count: 2, color: 'red', label: '2 members with an undeliverable email' },
    ]);
    // Ordering: red first, then green, then gray.
    const counts: TodoCounts = {
      ...admin({ brokenEmails: 1, membership: 2, applicationsTotal: 40 }),
      review: { canActOn: 0, approvedAwaitingSecond: 0 },
    };
    expect(navBadgeFor('/membership-ops', counts).map((b) => b.color)).toEqual(['red', 'treehouseGreen', 'gray']);
    // Singularized, and hidden at 0.
    expect(navBadgeFor('/membership-ops', admin({ brokenEmails: 1 })))
      .toEqual([{ count: 1, color: 'red', label: '1 member with an undeliverable email' }]);
    expect(navBadgeFor('/membership-ops', admin({ brokenEmails: 0 }))).toEqual([]);
  });
});

describe('tabBadgeFor — Manage Memberships broken-email pill', () => {
  it('red count on the households tab, singularized, null at 0', () => {
    expect(tabBadgeFor('/membership-ops/households', admin({ brokenEmails: 3 })))
      .toEqual({ count: 3, color: 'red', label: '3 members with an undeliverable email' });
    expect(tabBadgeFor('/membership-ops/households', admin({ brokenEmails: 1 })))
      .toEqual({ count: 1, color: 'red', label: '1 member with an undeliverable email' });
    expect(tabBadgeFor('/membership-ops/households', admin({ brokenEmails: 0 }))).toBeNull();
  });
});

describe('settings misconfig red pill', () => {
  it('is null off the admin surface (non-board viewer)', () => {
    expect(settingsMisconfigBadge(base)).toBeNull();
    expect(settingsMisconfigBadge(null)).toBeNull();
    expect(navBadgeFor('/settings', base)).toEqual([]);
  });

  it('hidden when both settings are configured', () => {
    expect(settingsMisconfigBadge(admin({ settingsMisconfig: 0 }))).toBeNull();
    expect(navBadgeFor('/settings', admin({ settingsMisconfig: 0 }))).toEqual([]);
  });

  it('red pill with the unset count, singular label at 1', () => {
    expect(settingsMisconfigBadge(admin({ settingsMisconfig: 1 })))
      .toEqual({ count: 1, color: 'red', label: '1 required membership setting not configured' });
    expect(navBadgeFor('/settings', admin({ settingsMisconfig: 4 })))
      .toEqual([{ count: 4, color: 'red', label: '4 required membership settings not configured' }]);
  });
});

describe('programs misconfig red pill', () => {
  it('is null off the admin surface (non-board viewer)', () => {
    expect(programsMisconfigBadge(base)).toBeNull();
    expect(programsMisconfigBadge(null)).toBeNull();
  });

  it('hidden when no program is broken', () => {
    expect(programsMisconfigBadge(admin({ programsMisconfig: 0 }))).toBeNull();
  });

  it('red pill with the broken count, singular label at 1', () => {
    expect(programsMisconfigBadge(admin({ programsMisconfig: 1 })))
      .toEqual({ count: 1, color: 'red', label: '1 program with broken checkout' });
    expect(programsMisconfigBadge(admin({ programsMisconfig: 3 })))
      .toEqual({ count: 3, color: 'red', label: '3 programs with broken checkout' });
  });

  it('surfaces on the /program-ops left-nav item, empty off the admin surface', () => {
    expect(navBadgeFor('/program-ops', base)).toEqual([]);
    expect(navBadgeFor('/program-ops', admin({ programsMisconfig: 0 }))).toEqual([]);
    expect(navBadgeFor('/program-ops', admin({ programsMisconfig: 2 })))
      .toEqual([{ count: 2, color: 'red', label: '2 programs with broken checkout' }]);
  });
});

describe('tabBadgeFor', () => {
  it('returns null without an admin block (non-board viewer)', () => {
    expect(tabBadgeFor('/membership-ops/applications', base)).toBeNull();
    expect(tabBadgeFor('/safety/trusted-adults', null)).toBeNull();
  });

  it('applications tab shows every in-flight application (gray)', () => {
    expect(tabBadgeFor('/membership-ops/applications', admin({ applicationsTotal: 40 })))
      .toEqual({ count: 40, color: 'gray', label: '40 applications' });
  });

  it('broken-households tab is red (board action, blocking), the other audit tabs gray', () => {
    expect(tabBadgeFor('/membership-audit/broken', admin({ brokenHouseholds: 2 })))
      .toEqual({ count: 2, color: 'red', label: '2 households without a lead' });
    expect(tabBadgeFor('/membership-audit/emergency-contacts', admin({ householdsMissingContact: 1 })))
      .toEqual({ count: 1, color: 'gray', label: '1 household missing an emergency contact' });
    expect(tabBadgeFor('/membership-audit/unclaimed', admin({ unclaimedHouseholds: 3 })))
      .toEqual({ count: 3, color: 'gray', label: '3 unclaimed account households' });
  });

  it('trusted-adults tab matches the safety count (green)', () => {
    expect(tabBadgeFor('/safety/trusted-adults', admin({ trustedAdults: 5 })))
      .toEqual({ count: 5, color: 'treehouseGreen', label: '5 trusted-adult disclosures to review' });
  });

  it('hides action/gap tabs at zero', () => {
    expect(tabBadgeFor('/membership-ops/applications', admin())).toBeNull();
    expect(tabBadgeFor('/membership-audit/broken', admin())).toBeNull();
  });

  it('finance-ops tabs badge their own queue (green), hidden at zero', () => {
    expect(tabBadgeFor('/finance-ops/payment-plan', admin({ paymentPlanPending: 2 })))
      .toEqual({ count: 2, color: 'treehouseGreen', label: '2 program payment-plan approvals' });
    expect(tabBadgeFor('/finance-ops/membership-payment-plan', admin({ membershipPaymentPlanPending: 1 })))
      .toEqual({ count: 1, color: 'treehouseGreen', label: '1 membership payment-plan approval' });
    expect(tabBadgeFor('/finance-ops/payments', admin({ openPaymentExceptions: 4 })))
      .toEqual({ count: 4, color: 'treehouseGreen', label: '4 payment problems to review' });
    expect(tabBadgeFor('/finance-ops/payment-plan', admin())).toBeNull();
    expect(tabBadgeFor('/finance-ops/membership-payment-plan', admin())).toBeNull();
    expect(tabBadgeFor('/finance-ops/payments', admin())).toBeNull();
  });
});

describe('finance-ops nav ↔ tab agreement', () => {
  it('the section green pill sums both tab queues', () => {
    const counts = admin({ paymentPlanPending: 2, membershipPaymentPlanPending: 3 });
    expect(navBadgeFor('/finance-ops', counts))
      .toEqual([{ count: 5, color: 'treehouseGreen', label: 'Pending payment-plan approvals' }]);

    const program = tabBadgeFor('/finance-ops/payment-plan', counts)?.count ?? 0;
    const membership = tabBadgeFor('/finance-ops/membership-payment-plan', counts)?.count ?? 0;
    expect(navBadgeFor('/finance-ops', counts)[0].count).toBe(program + membership);
  });

  it('no section badge when both queues are empty', () => {
    expect(navBadgeFor('/finance-ops', admin())).toEqual([]);
  });
});

// The /membership-audit section badge is a roll-up of its tabs; keep them in lockstep.
// Red section total == broken tab; gray section total == emergency + unclaimed tabs.
describe('system-status infra-health badge', () => {
  it('no badge when the payload has no configHealth (non-admin) or zero issues', () => {
    expect(navBadgeFor('/system-status', base)).toEqual([]);
    expect(navBadgeFor('/system-status', { ...base, configHealth: { openIssues: 0, unhealthyCronJobs: 0 } })).toEqual([]);
  });

  it('red alert badge counting open config issues', () => {
    const badges = navBadgeFor('/system-status', { ...base, configHealth: { openIssues: 2, unhealthyCronJobs: 0 } });
    expect(badges).toEqual([{ count: 2, color: 'red', label: '2 config issues' }]);
  });

  it('singularizes the label at one issue', () => {
    const badges = navBadgeFor('/system-status', { ...base, configHealth: { openIssues: 1, unhealthyCronJobs: 0 } });
    expect(badges[0].label).toBe('1 config issue');
  });

  it('a stale cron job alone raises the red pill', () => {
    const badges = navBadgeFor('/system-status', { ...base, configHealth: { openIssues: 0, unhealthyCronJobs: 1 } });
    expect(badges).toEqual([{ count: 1, color: 'red', label: '1 cron job unhealthy' }]);
  });

  // One pill, not two: both halves are "infra broken" on the same page.
  it('folds stale cron jobs into the same count as config issues', () => {
    const badges = navBadgeFor('/system-status', { ...base, configHealth: { openIssues: 2, unhealthyCronJobs: 3 } });
    expect(badges).toEqual([{ count: 5, color: 'red', label: '2 config issues, 3 cron jobs unhealthy' }]);
  });
});

describe('membership-audit nav ↔ tab agreement', () => {
  it('section badges equal the sum of their tab badges', () => {
    const counts = admin({ brokenHouseholds: 2, householdsMissingContact: 3, unclaimedHouseholds: 4 });
    const nav = navBadgeFor('/membership-audit', counts);
    const navRed = nav.find((b) => b.color === 'red')?.count ?? 0;
    const navGray = nav.find((b) => b.color === 'gray')?.count ?? 0;

    const broken = tabBadgeFor('/membership-audit/broken', counts)?.count ?? 0;
    const emergency = tabBadgeFor('/membership-audit/emergency-contacts', counts)?.count ?? 0;
    const unclaimed = tabBadgeFor('/membership-audit/unclaimed', counts)?.count ?? 0;

    expect(navRed).toBe(broken);
    expect(navGray).toBe(emergency + unclaimed);
  });
});

describe('Attendance occupancy badges', () => {
  const occupied: TodoCounts = { ...base, building: 5, buildingHousehold: 2 };

  it('shows occupancy while the kiosk is reachable', () => {
    expect(navBadgeFor('/attendance', occupied).map(b => b.count)).toEqual([2, 5]);
  });

  it('shows nothing when the kiosk is unreachable — the count is unconfirmed', () => {
    expect(navBadgeFor('/attendance', { ...occupied, buildingReachable: false })).toEqual([]);
  });
});
