// Pure nav-badge derivation, split out of AppFrame so it can be unit-tested
// without pulling in React/Mantine. AppFrame imports navBadgeFor for rendering
// and leadsAnyProgram for the staff "My Programs" visibility gate.
import type { TodoCounts } from '@/app/api/nav/todo-counts/route';
import type { LibraryKey, NavTab } from '@/lib/libraryNav';

export type NavBadge = { count: number; color: string; label: string };

/** One count a library's provider reported (0 when absent: not visible, failed, or unregistered). */
export function libraryCount(counts: TodoCounts | null, lib: LibraryKey, key: string): number {
  return counts?.libraries?.[lib]?.[key] ?? 0;
}

/**
 * Folds badges to at most one per color (counts summed, labels joined), so a
 * sidebar entry never shows two same-color pills side by side.
 */
export function foldBadges(badges: NavBadge[]): NavBadge[] {
  const byColor = new Map<string, NavBadge>();
  for (const b of badges) {
    const prev = byColor.get(b.color);
    byColor.set(b.color, prev ? { count: prev.count + b.count, color: b.color, label: `${prev.label}; ${b.label}` } : b);
  }
  return [...byColor.values()];
}

/** A sidebar entry's pills: its own navBadgeFor pills plus its tabs' pills, folded. */
export function sectionBadges(href: string, tabs: readonly NavTab[], counts: TodoCounts | null): NavBadge[] {
  const tabBadges = tabs.flatMap((t) => {
    const b = t.badge?.(counts);
    return b ? [b] : [];
  });
  return foldBadges([...navBadgeFor(href, counts), ...tabBadges]);
}

/** A section tab's pill: the shared tabBadgeFor, else the tab's own badge function. */
export function sectionTabBadge(tabs: readonly NavTab[], href: string, counts: TodoCounts | null): NavBadge | null {
  return tabBadgeFor(href, counts) ?? tabs.find((t) => t.href === href)?.badge?.(counts) ?? null;
}

/** True when the caller leads ≥1 program — gates the staff "My Programs" nav item. */
export function leadsAnyProgram(counts: TodoCounts | null): boolean {
  return !!counts?.lead && counts.lead.programs.length > 0;
}

/** Total pending attendance items across the caller's led programs (green badge count). */
export function leadPendingCount(counts: TodoCounts | null): number {
  return counts?.lead?.programs.reduce((sum, p) => sum + p.pending.length, 0) ?? 0;
}

/** Overlapping-visit conflicts across the caller's led programs (red badge count). */
export function leadConflictCount(counts: TodoCounts | null): number {
  return counts?.lead?.conflicts ?? 0;
}

/**
 * Red pill for unconfigured required membership board settings (the Shopify
 * membership variant ID, the volunteer discount code, the background-check
 * re-check interval, and the membership-year boundary). Count is 1–4, or null
 * when all are set. Red (alert) — not green/gray — because until it's fixed
 * membership checkout / renewals are broken. Shown on the Settings nav item and
 * the Membership Settings sub-tab,
 * both board/sysadmin-only (the people who can fix it). Returns null off the
 * admin surface (non-board viewers never see it).
 */
export function settingsMisconfigBadge(counts: TodoCounts | null): NavBadge | null {
  const n = counts?.admin?.settingsMisconfig ?? 0;
  return n > 0
    ? { count: n, color: 'red', label: `${n} required membership setting${n === 1 ? '' : 's'} not configured` }
    : null;
}

/**
 * Red pill for programs that have a price but no matching Shopify variant — paid
 * enrollment silently can't check out (parent can't pay; the participant stays
 * PENDING). Red (alert) — checkout is broken until synced. Shown on the Program
 * Ops "All Programs" tab, admin/board-gated (the count is absent from the payload
 * for everyone else). Returns null at 0 or off the admin surface.
 */
export function programsMisconfigBadge(counts: TodoCounts | null): NavBadge | null {
  const n = counts?.admin?.programsMisconfig ?? 0;
  return n > 0
    ? { count: n, color: 'red', label: `${n} program${n === 1 ? '' : 's'} with broken checkout` }
    : null;
}

/**
 * Background-check Review badges (0, 1, or 2), shared by the left-nav Membership
 * Ops item and the Review sub-tab so both stay in lockstep: green = applications
 * this reviewer can act on now; gray = ones they approved awaiting a second
 * reviewer. Each hides at 0.
 */
export function reviewBadges(counts: TodoCounts | null): NavBadge[] {
  const r = counts?.review;
  if (!r) return [];
  const out: NavBadge[] = [];
  if (r.canActOn > 0)
    out.push({ count: r.canActOn, color: 'treehouseGreen', label: `${r.canActOn} background check${r.canActOn === 1 ? '' : 's'} you can review now` });
  if (r.approvedAwaitingSecond > 0)
    out.push({ count: r.approvedAwaitingSecond, color: 'gray', label: `${r.approvedAwaitingSecond} you approved, awaiting a second reviewer` });
  return out;
}

/**
 * Badges for a nav item (0, 1, or 2). Green = action the viewer must take, or
 * the viewer's own household; gray = live informational count (others'
 * occupancy, running programs). Attendance shows two: my household vs everyone
 * else currently in the building.
 */
export function navBadgeFor(href: string, counts: TodoCounts | null): NavBadge[] {
  if (!counts) return [];
  const green = (n: number, label: string): NavBadge[] =>
    n > 0 ? [{ count: n, color: 'treehouseGreen', label }] : [];
  const gray = (n: number, label: string): NavBadge[] =>
    n > 0 ? [{ count: n, color: 'gray', label }] : [];
  switch (href) {
    case '/my-household':
      return green(counts.member.household.length, `${counts.member.household.length} items need attention`);
    case '/my-activities': {
      // Green = program payments the household can pay now (actionable); gray =
      // payment plans sent to finance, awaiting board approval (not actionable).
      const due = counts.member.programs.length;
      const finance = counts.member.programsAwaitingFinance;
      return [
        ...green(due, `${due} program payment${due === 1 ? '' : 's'} due`),
        ...gray(finance, `${finance} program payment${finance === 1 ? '' : 's'} awaiting finance approval`),
      ];
    }
    case '/my-programs': {
      // Red conflicts first (left of green), then pending attendance the lead
      // must confirm — mirrors the Conflicts/Attendance subtab badges.
      const c = leadConflictCount(counts);
      const red = c > 0 ? [{ count: c, color: 'red', label: `${c} attendance ${c === 1 ? 'conflict' : 'conflicts'} to resolve` }] : [];
      const n = leadPendingCount(counts);
      return [...red, ...green(n, `${n} attendance ${n === 1 ? 'item' : 'items'} to confirm`)];
    }
    case '/attendance': {
      const mine = counts.buildingHousehold;
      const blue = (n: number, label: string): NavBadge[] =>
        n > 0 ? [{ count: n, color: 'blue', label }] : [];
      return [
        // Blue not green: informational (who's here), not an action to take.
        ...blue(mine, `${mine} from your household currently in the building`),
        ...gray(counts.building, `${counts.building} people currently in the building`),
      ];
    }
    case '/programs':
      return gray(counts.activePrograms, `${counts.activePrograms} active programs`);
    case '/program-ops': {
      // Red: priced programs missing their Shopify variant (broken paid checkout).
      // Mirrors the Programs section-tab pill; admin/board-gated (count absent otherwise).
      const b = programsMisconfigBadge(counts);
      return b ? [b] : [];
    }
    case '/membership-ops': {
      // The Review tab lives under this nav item, so its counts surface here
      // too. Everything collapses into at most ONE green + ONE gray so the nav
      // item never shows two same-color pills side by side. Green (actions you
      // can take): board's BLOCKED membership queue + background checks you can
      // review now. Gray (passive info): in-flight applications + reviews you
      // approved awaiting a second reviewer. reviewBadges is NOT spread here —
      // both its halves are folded in inline (its other caller, the Review tab,
      // still wants them separate).
      const membership = counts.admin ? counts.admin.membership : 0;
      const canActOn = counts.review?.canActOn ?? 0;
      const action = membership + canActOn;
      const actionLabel = `${membership} pending membership review${plural(membership, '', 's')}; ${canActOn} background check${plural(canActOn, '', 's')} you can review now`;

      const apps = counts.admin ? counts.admin.applicationsTotal : 0;
      const awaiting = counts.review?.approvedAwaitingSecond ?? 0;
      const info = apps + awaiting;
      const infoLabel = `${apps} in-flight application${plural(apps, '', 's')}; ${awaiting} you approved awaiting a second reviewer`;
      // Red (blocking): people whose email bounced/complained — surfaced on the
      // Manage Memberships (households) tab, where the board fixes the address.
      // Mirrors the /membership-ops/households tab pill (tabBadgeFor below).
      const brokenEmails = counts.admin ? counts.admin.brokenEmails : 0;
      const red = brokenEmails > 0
        ? [{ count: brokenEmails, color: 'red', label: `${brokenEmails} member${plural(brokenEmails, '', 's')} with an undeliverable email` }]
        : [];
      return [
        ...red,
        ...green(action, actionLabel),
        ...gray(info, infoLabel),
      ];
    }
    case '/membership-audit': {
      // Red: leadless households the board must fix (assign a lead) — blocking, so
      // it's an alert not a routine action. Gray: gaps the household must close —
      // missing emergency contacts plus accounts created at registration but never
      // claimed.
      const red = (n: number, label: string): NavBadge[] =>
        n > 0 ? [{ count: n, color: 'red', label }] : [];
      const grayTotal = counts.admin ? counts.admin.householdsMissingContact + counts.admin.unclaimedHouseholds : 0;
      return [
        ...red(counts.admin ? counts.admin.brokenHouseholds : 0, 'Leadless households needing a lead assigned'),
        ...gray(grayTotal, 'Households missing an emergency contact or with an unclaimed account'),
      ];
    }
    case '/finance-ops': {
      // Both queues fold into one green pill (program + membership payment-plan
      // approvals) — matching how /membership-ops collapses its counts.
      const program = counts.admin ? counts.admin.paymentPlanPending : 0;
      const membership = counts.admin ? counts.admin.membershipPaymentPlanPending : 0;
      return green(program + membership, 'Pending payment-plan approvals');
    }
    case '/safety':
      // Trusted-adult disclosures awaiting board review.
      return green(counts.admin ? counts.admin.trustedAdults : 0, 'Trusted-adult disclosures to review');
    case '/settings': {
      // Red: required Shopify-checkout settings still unset (variant ID, volunteer code).
      const b = settingsMisconfigBadge(counts);
      return b ? [b] : [];
    }
    case '/system-status': {
      // Red alert: things broken about the deployment itself — failing system-config
      // checks (env-var/deploy gaps, e.g. Zoho e-sign unconfigured) plus cron sweeps
      // that stopped running OR stopped working. Distinct from the
      // green/gray queue badges — this is "infra broken," not "you have a task."
      // Admins + board only (the counts are absent from the payload for everyone else).
      //
      // ONE pill, not two: both halves mean "go look at System Status", they land on
      // the same page and the same audience fixes them, and a second red pill on the
      // same nav item would just be a second number pointing at the same link. The
      // label keeps them itemized so the pill is still specific. See lib/configHealth.ts
      // and lib/cronRuns.ts.
      const config = counts.configHealth?.openIssues ?? 0;
      // "unhealthy", not "not running": the count also covers a sweep that runs every
      // night and cannot finish its work. Which one it is, is a panel-level detail.
      const cron = counts.configHealth?.unhealthyCronJobs ?? 0;
      const n = config + cron;
      if (n === 0) return [];
      const parts = [
        ...(config > 0 ? [`${config} config ${config === 1 ? 'issue' : 'issues'}`] : []),
        ...(cron > 0 ? [`${cron} cron job${plural(cron, '', 's')} unhealthy`] : []),
      ];
      return [{ count: n, color: 'red', label: parts.join(', ') }];
    }
    // Other admin roll-ups have no badge here: every queue count belongs to another
    // nav item that already badges it, so a roll-up would just duplicate numbers.
    default:
      return [];
  }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Badge for a section *sub-tab*, off the same shared counts. Lives here beside
 * navBadgeFor so the tab number and the section-nav number are derived from one
 * file — a new admin badge is one edit, and nav vs tab can't silently slice
 * different fields for the same thing (they used to). Returns null when the tab
 * has nothing to show. Layouts own the <Badge> JSX (variant, active-tab color
 * pins); this owns only count + intent-color + label.
 *
 * NOT covered here: informational *total* counters that show even at 0 (e.g. the
 * Manage Memberships member-family total) — those have no section-nav twin to
 * diverge from, so they stay local to their layout.
 */
export function tabBadgeFor(href: string, counts: TodoCounts | null): NavBadge | null {
  const admin = counts?.admin;
  if (!admin) return null;
  const green = (n: number, label: string): NavBadge | null =>
    n > 0 ? { count: n, color: 'treehouseGreen', label } : null;
  const gray = (n: number, label: string): NavBadge | null =>
    n > 0 ? { count: n, color: 'gray', label } : null;
  switch (href) {
    // Membership Ops. Gray, informational: every in-flight application the
    // Applications page lists (status != ACTIVE). Distinct from the /membership-ops
    // section badge, which is green board-actionable (BLOCKED) only.
    case '/membership-ops/applications':
      return gray(admin.applicationsTotal, `${admin.applicationsTotal} application${plural(admin.applicationsTotal, '', 's')}`);
    // Manage Memberships (households). Red, blocking: members whose email Resend
    // reported undeliverable (bounce/complaint) — the board fixes the address on
    // this page. Same count as the /membership-ops section-nav red pill.
    case '/membership-ops/households':
      return admin.brokenEmails > 0
        ? { count: admin.brokenEmails, color: 'red', label: `${admin.brokenEmails} member${plural(admin.brokenEmails, '', 's')} with an undeliverable email` }
        : null;
    // Membership Audit — mirrors the /membership-audit section badge: broken is
    // red (board must assign a lead — blocking), the other two gray (household's own gaps).
    case '/membership-audit/emergency-contacts':
      return gray(admin.householdsMissingContact, `${admin.householdsMissingContact} household${plural(admin.householdsMissingContact, '', 's')} missing an emergency contact`);
    case '/membership-audit/broken':
      return admin.brokenHouseholds > 0
        ? { count: admin.brokenHouseholds, color: 'red', label: `${admin.brokenHouseholds} household${plural(admin.brokenHouseholds, '', 's')} without a lead` }
        : null;
    case '/membership-audit/unclaimed':
      return gray(admin.unclaimedHouseholds, `${admin.unclaimedHouseholds} unclaimed account household${plural(admin.unclaimedHouseholds, '', 's')}`);
    // Finance Ops — one green pill per tab, so both queues badge consistently.
    case '/finance-ops/payment-plan':
      return green(admin.paymentPlanPending, `${admin.paymentPlanPending} program payment-plan approval${plural(admin.paymentPlanPending, '', 's')}`);
    case '/finance-ops/membership-payment-plan':
      return green(admin.membershipPaymentPlanPending, `${admin.membershipPaymentPlanPending} membership payment-plan approval${plural(admin.membershipPaymentPlanPending, '', 's')}`);
    case '/finance-ops/payments':
      return green(admin.openPaymentExceptions, `${admin.openPaymentExceptions} payment problem${plural(admin.openPaymentExceptions, '', 's')} to review`);
    // Safety — same count as the /safety section badge.
    case '/safety/trusted-adults':
      return green(admin.trustedAdults, `${admin.trustedAdults} trusted-adult disclosure${plural(admin.trustedAdults, '', 's')} to review`);
    default:
      return null;
  }
}
