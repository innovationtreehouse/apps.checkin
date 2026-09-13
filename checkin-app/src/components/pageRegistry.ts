// Flat directory of every named (non-dynamic) app page, used by the /index
// page directory and available to any future command palette. Each entry's
// `visible` predicate mirrors the route's real gate (NAV_ITEMS[].visible +
// the section layout's useRequireRole). Over-listing here never grants access:
// every target re-enforces its own gate on arrival, so a drifted predicate at
// worst shows a link that 403s. See docs/designs/INDEX_PAGE_SCOPING.md.

import type { TodoCounts } from '@/app/api/nav/todo-counts/route';
import type { BusinessRole } from '@/types/auth';
import { leadsAnyProgram } from '@/components/navBadges';
import { shopRoles } from '@/lib/shopNav';
import { FINANCE_SECTION_ROLES } from '@/lib/financeNav';
import { SAFETY_SECTION_ROLES } from '@/lib/safetyNav';
import { membershipOpsRouteVisible } from '@/lib/membershipOpsNav';

export type RegistryUser = {
  isSysadmin?: boolean;
  isBoardMember?: boolean;
  isKeyholder?: boolean;
  isBackgroundCheckReviewer?: boolean;
  isOperations?: boolean;
  householdLead?: boolean;
  toolStatuses?: Array<{ level: string }>;
};

// counts mirrors the nav: computed roles (leads ≥1 program) aren't on the
// session user, they ride in on the todo-counts payload the index already fetches.
type Visible = (user: RegistryUser | undefined, signedIn: boolean, counts: TodoCounts | null) => boolean;

const PUBLIC: Visible = () => true;
const SIGNED_IN: Visible = (_u, signedIn) => signedIn;
// Household lead only — the membership application and trusted-adult management
// belong to the lead, not every member (a youth/dependent must not see them).
const HOUSEHOLD_LEAD: Visible = (u, signedIn) => signedIn && !!u?.householdLead;
// Program lead mentors only — mirrors the staff "My Programs" nav gate.
const LEADS_PROGRAM: Visible = (_u, signedIn, counts) => signedIn && leadsAnyProgram(counts);
const BOARD: Visible = (u) => !!u?.isSysadmin || !!u?.isBoardMember;
// Participants is the one Membership Ops page operations can also reach (read-only
// directory + add-contact) — see membership-ops/layout.tsx's nav gate. Outreach is
// the one settings/* page operations can also reach (see settings/layout.tsx).
const BOARD_OR_OPS: Visible = (u) => !!u?.isSysadmin || !!u?.isBoardMember || !!u?.isOperations;
const SYSADMIN: Visible = (u) => !!u?.isSysadmin;
// Section gates read from the module that owns the section, never a second copy
// (#1569). A role-list gate becomes a Visible via roleGate; sections with a
// richer predicate (Shop resolves toolStatuses, Membership Ops gates per tab)
// call their own exported function.
const roleGate = (roles: BusinessRole[]): Visible => (u) => roles.some((r) => !!u?.[r]);
const SAFETY = roleGate(SAFETY_SECTION_ROLES);
// Finance Ops is board-only — sysadmin has no access (issue #1083).
const FINANCE = roleGate(FINANCE_SECTION_ROLES);
const SHOP: Visible = (u) => shopRoles(u).isCertifier;
const SHOP_ADMIN: Visible = (u) => shopRoles(u).isAdmin;
// Membership Ops gates per tab (Review admits reviewers, Participants admits
// operations, the rest are admin-only). One definition in membershipOpsNav.
const MOPS = (href: string): Visible => (u) => membershipOpsRouteVisible(href, u);

export type PageEntry = {
  href: string;
  label: string;
  section: string;
  keywords?: string;
  visible: Visible;
};

export const PAGES: PageEntry[] = [
  // Personal — any signed-in member
  { href: '/my-household', label: 'My Household', section: 'Personal', visible: SIGNED_IN },
  { href: '/my-activities', label: 'My Activities', section: 'Personal', visible: SIGNED_IN },
  { href: '/my-activities/events', label: 'My Events', section: 'Personal', visible: SIGNED_IN },
  { href: '/my-activities/programs', label: 'My Programs (as Participant)', section: 'Personal', visible: SIGNED_IN },
  { href: '/profile', label: 'My Profile', section: 'Personal', visible: SIGNED_IN },
  // Home for program lead mentors. Lead status rides in on the todo-counts
  // payload (leadsAnyProgram), matching the nav gate. Distinct from the attendee
  // "My Programs" tab above.
  { href: '/my-programs/attendance', label: 'My Programs (as Volunteer)', section: 'Personal', keywords: 'lead mentor program volunteer attendance', visible: LEADS_PROGRAM },
  { href: '/my-programs/conflicts', label: 'Attendance Conflicts', section: 'Personal', keywords: 'lead mentor duplicate overlapping visit attendance', visible: LEADS_PROGRAM },
  // Stays visible to all members: also the Join/renewal entry for new applicants
  // who aren't a household lead yet (gating it on lead would break joining).
  { href: '/membership', label: 'Membership Application', section: 'Personal', keywords: 'join intake', visible: SIGNED_IN },
  { href: '/trusted-adults', label: 'Trusted Adults', section: 'Personal', visible: HOUSEHOLD_LEAD },

  // Attendance — any signed-in member
  { href: '/attendance/current', label: 'Attendance', section: 'Attendance', visible: SIGNED_IN },
  { href: '/attendance/manual', label: 'Manual Check-In', section: 'Attendance', visible: SIGNED_IN },
  { href: '/attendance/my-visits', label: 'My Visits', section: 'Attendance', keywords: 'hours correction edit delete', visible: SIGNED_IN },
  { href: '/attendance/household', label: 'Household Check-ins', section: 'Attendance', keywords: 'visits history dependents', visible: SIGNED_IN },
  { href: '/attendance/certifications', label: 'Certifications', section: 'Attendance', visible: SIGNED_IN },

  // Programs — public
  { href: '/programs', label: 'Programs', section: 'Programs', visible: PUBLIC },

  // Communication — signed-in member
  { href: '/communication', label: 'Communication', section: 'Personal', keywords: 'notifications email preferences settings', visible: SIGNED_IN },

  // Safety — board or isKeyholder
  { href: '/safety', label: 'Safety', section: 'Safety', visible: SAFETY },
  { href: '/safety/board-contacts', label: 'Board Contacts', section: 'Safety', visible: SAFETY },
  { href: '/safety/emergency-contacts', label: 'Emergency Contacts', section: 'Safety', visible: SAFETY },
  { href: '/safety/pickup', label: 'Pickup', section: 'Safety', visible: SAFETY },
  { href: '/safety/trusted-adults', label: 'Trusted Adults (Safety)', section: 'Safety', visible: SAFETY },

  // Shop Ops — board or certifier
  { href: '/shop-ops', label: 'Shop Ops', section: 'Shop Ops', visible: SHOP },
  { href: '/shop-ops/create', label: 'Create', section: 'Shop Ops', visible: SHOP_ADMIN },
  { href: '/shop-ops/live', label: 'Live', section: 'Shop Ops', visible: SHOP },
  { href: '/shop-ops/manage', label: 'Manage', section: 'Shop Ops', visible: SHOP },

  // Facility Ops — board, plus operations on the two aggregate tools (#1633:
  // operations reach attendance in aggregate only). Visits, Badges (the raw
  // badge-event log) and Corrections are one person's record, so they stay
  // board-only. The index redirects to the caller's first visible tab, so it is
  // listed to anyone the section admits.
  { href: '/facility-ops', label: 'Facility Ops', section: 'Facility Ops', visible: BOARD_OR_OPS },
  { href: '/facility-ops/badges', label: 'Badges', section: 'Facility Ops', visible: BOARD },
  { href: '/facility-ops/print-badges', label: 'Print Badges', section: 'Facility Ops', visible: BOARD_OR_OPS },
  { href: '/facility-ops/trends', label: 'Trends', section: 'Facility Ops', visible: BOARD_OR_OPS },
  { href: '/facility-ops/visits', label: 'Visits', section: 'Facility Ops', visible: BOARD },
  { href: '/facility-ops/corrections', label: 'Corrections', section: 'Facility Ops', keywords: 'audit attendance edit delete flagged significance review', visible: BOARD },

  // Membership Ops — admin tools, plus operations (Participants) and background-check
  // reviewers (Review). Gates read from membershipOpsNav, not retyped here.
  { href: '/membership-ops', label: 'Membership Ops', section: 'Membership Ops', visible: MOPS('/membership-ops') },
  { href: '/membership-ops/applications', label: 'Applications', section: 'Membership Ops', visible: MOPS('/membership-ops/applications') },
  { href: '/membership-ops/households', label: 'Households', section: 'Membership Ops', visible: MOPS('/membership-ops/households') },
  { href: '/membership-ops/volunteer-memberships', label: 'Volunteers', section: 'Membership Ops', visible: MOPS('/membership-ops/volunteer-memberships') },
  { href: '/membership-ops/participants', label: 'Participants', section: 'Membership Ops', visible: MOPS('/membership-ops/participants') },
  { href: '/membership-ops/participants/new', label: 'New Participant', section: 'Membership Ops', visible: MOPS('/membership-ops/participants/new') },
  { href: '/membership-ops/participants/import', label: 'Import Participants', section: 'Membership Ops', visible: MOPS('/membership-ops/participants/import') },
  { href: '/membership-ops/participants/merge', label: 'Merge Participants', section: 'Membership Ops', visible: MOPS('/membership-ops/participants/merge') },
  { href: '/membership-ops/review', label: 'Membership Review', section: 'Membership Ops', visible: MOPS('/membership-ops/review') },
  { href: '/membership-ops/roles', label: 'Roles', section: 'Membership Ops', visible: MOPS('/membership-ops/roles') },

  // Membership Audit — board
  { href: '/membership-audit', label: 'Membership Audit', section: 'Membership Audit', visible: BOARD },
  { href: '/membership-audit/emergency-contacts', label: 'Missing Emergency Contacts', section: 'Membership Audit', visible: BOARD },
  { href: '/membership-audit/unclaimed', label: 'Unclaimed Accounts', section: 'Membership Audit', visible: BOARD },
  { href: '/membership-audit/broken', label: 'Broken Households', section: 'Membership Audit', keywords: 'lead leadless no lead unclaimed', visible: BOARD },
  { href: '/membership-audit/compliance', label: 'Membership Compliance', section: 'Membership Audit', keywords: 'violations background check revoked denied stale follow-up', visible: BOARD },
  { href: '/membership-audit/bg-attestations', label: 'BG Attestations', section: 'Membership Audit', keywords: 'background check attestation reviewer signed off who approved', visible: BOARD },
  { href: '/membership-audit/turning-18', label: 'Students 18+', section: 'Membership Audit', keywords: 'age 18 adult turning eighteen agreement member year sept 1 september', visible: BOARD },

  // Program Ops — board
  { href: '/program-ops', label: 'Program Ops', section: 'Program Ops', visible: BOARD },
  { href: '/program-ops/programs', label: 'All Programs', section: 'Program Ops', visible: BOARD },
  { href: '/program-ops/events', label: 'Events', section: 'Program Ops', visible: BOARD },
  { href: '/program-ops/new', label: 'New Program', section: 'Program Ops', visible: BOARD },
  { href: '/program-ops/sessions', label: 'Sessions', section: 'Program Ops', visible: BOARD },
  { href: '/program-ops/sessions/new', label: 'New Session', section: 'Program Ops', visible: BOARD },

  // Finance Ops — board
  { href: '/finance-ops', label: 'Finance Ops', section: 'Finance Ops', visible: FINANCE },
  { href: '/finance-ops/payment-plan', label: 'Program Payment Plan', section: 'Finance Ops', visible: FINANCE },
  { href: '/finance-ops/membership-payment-plan', label: 'Membership Payment Plan', section: 'Finance Ops', visible: FINANCE },
  { href: '/finance-ops/shopify-holds', label: 'Shopify Hold Reconciliation', section: 'Finance Ops', keywords: 'seat hold failed inventory scholarship manual reconcile shopify', visible: FINANCE },
  { href: '/finance-ops/payments', label: 'Payment problems', section: 'Finance Ops', keywords: 'reconcile exception refund chargeback unmatched shopify', visible: FINANCE },

  // System Status — board
  { href: '/system-status', label: 'System Status', section: 'System Status', visible: BOARD },
  { href: '/system-status/health', label: 'Health', section: 'System Status', visible: BOARD },
  { href: '/system-status/errors', label: 'Errors', section: 'System Status', visible: BOARD },
  { href: '/system-status/unsynced-scans', label: 'Unsynced Scans', section: 'System Status', keywords: 'kiosk parked replay badge scan review stale out of order offline queue', visible: SAFETY },
  { href: '/system-status/audit-log', label: 'Audit Log', section: 'System Status', visible: BOARD },
  { href: '/system-status/links', label: 'Links', section: 'System Status', visible: BOARD },
  { href: '/system-status/lifecycle', label: 'Lifecycle', section: 'System Status', keywords: 'invariant validate off-diagram drift reconcile enrollment membership state machine', visible: BOARD },

  // Settings — board
  { href: '/settings/membership', label: 'Membership Settings', section: 'Settings', visible: BOARD },
  { href: '/settings/localization', label: 'Localization', section: 'Settings', visible: SYSADMIN },
  { href: '/settings/email', label: 'Email Settings', section: 'Settings', keywords: 'sender from reply-to identity', visible: BOARD },
  { href: '/settings/outreach', label: 'Outreach', section: 'Settings', keywords: 'renewal join campaign email template bulk send reminder opening', visible: BOARD_OR_OPS },
  { href: '/settings/shopify-webhook', label: 'Shopify Webhook', section: 'Settings', keywords: 'orders paid delivery test notification signature secret payment', visible: BOARD },
];

// Routes that exist as page.tsx but are intentionally absent from the directory.
// Keep in sync with the drift test (pageRegistry.test.ts).
export const REGISTRY_EXCLUDED: string[] = [
  '/',                       // home/landing, reached via the brand logo
  '/index',                  // this directory page itself
  '/access-denied',          // error surface, not a destination
  '/signin',                 // auth surface
  '/settings',               // redirects to /settings/membership
  '/attendance',             // redirects to /attendance/current
  '/my-programs',            // redirects to /my-programs/attendance
  '/dev',                    // dev-tools hub, redirects to /dev/sent-mail
  '/dev/sent-mail',          // dev-only captured-email inbox (EMAIL_DEV_MOCK.md); 404s off dev
  '/dev/zoho-sign',          // dev-only Zoho Sign mock interstitial (404 in prod)
  '/dev/shopify',            // dev-only Shopify orders/paid mock (SHOPIFY_DEV_STORE_WEBHOOK.md); 404s off dev
  '/dev/bg-consent',         // dev-only background-check consent mock (docs/ops/background-check-mock.md); 404s off dev
];
