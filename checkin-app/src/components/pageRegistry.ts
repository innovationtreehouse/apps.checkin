// Flat directory of every named (non-dynamic) app page, used by the /index
// page directory and available to any future command palette. Each entry's
// `visible` is read from its section descriptor (lib/nav/sections): the gate of
// the section tab it is, or of the tab it sits under, or the section's own gate.
// Over-listing here never grants access: every target re-enforces its own gate
// on arrival, so a drifted predicate at worst shows a link that 403s. See
// docs/rules/principles.md, "Reachability is not permission".

import type { NavGate } from '@/lib/nav/types';
import { everyone, linkGate, signedIn } from '@/lib/nav/gates';
import { isHouseholdLead, seesCertificationGrid } from '@/lib/nav/sections/personal';
import { SAFETY } from '@/lib/nav/sections/safety';
import { MY_ACTIVITIES } from '@/lib/nav/sections/myActivities';
import { MY_RECEIPTS } from '@/lib/nav/sections/myReceipts';
import { PROGRAMS_I_LEAD } from '@/lib/nav/sections/programsILead';
import { SHOP_OPS } from '@/lib/nav/sections/shopOps';
import { INVENTORY } from '@/lib/nav/sections/inventory';
import { FACILITY_OPS } from '@/lib/nav/sections/facilityOps';
import { MEMBERSHIP_OPS, isMembershipOpsAdmin } from '@/lib/nav/sections/membershipOps';
import { MEMBERSHIP_AUDIT } from '@/lib/nav/sections/membershipAudit';
import { PROGRAM_OPS } from '@/lib/nav/sections/programOps';
import { REVENUE_OPS } from '@/lib/nav/sections/revenueOps';
import { DONATIONS as DONATIONS_SECTION } from '@/lib/nav/sections/donations';
import { FINANCE, FINANCE_REVIEW_PATH } from '@/lib/nav/sections/finance';
import { SYSTEM_STATUS } from '@/lib/nav/sections/systemStatus';
import { SETTINGS } from '@/lib/nav/sections/settings';

const PUBLIC = everyone;
const SIGNED_IN = signedIn;
const LEADS_PROGRAM = linkGate(PROGRAMS_I_LEAD, '/programs-i-lead/attendance');
const SAFETY_SECTION = SAFETY.visible;
const SHOP = SHOP_OPS.visible;
const CATALOG = linkGate(INVENTORY, '/catalog/items');
const ORG_INVENTORY = linkGate(INVENTORY, '/inventory/org-items');
const INVENTORY_MANAGER = linkGate(INVENTORY, '/inventory/merge-conflicts');
const INVENTORY_RECEIVING = linkGate(INVENTORY, '/inventory/receive-queue');
const INVENTORY_UNLOCATED = linkGate(INVENTORY, '/inventory/unlocated');
const INVENTORY_LOG = linkGate(INVENTORY, '/inventory/inventory-log');
const PART_MAPPING = linkGate(INVENTORY, '/inventory/receiving');
const INCOME = linkGate(REVENUE_OPS, '/income');
const DONATIONS = linkGate(DONATIONS_SECTION, '/donations/uploads');
// The hub redirects to the first finance tool, so it is listed to their audience.
const FINANCE_TOOLS = linkGate(REVENUE_OPS, '/finance-ops/payment-plan');
const REVENUE = (href: string): NavGate => linkGate(REVENUE_OPS, href);
const EXPENSES = linkGate(FINANCE, '/expense/expenses');
const BUDGETS = linkGate(FINANCE, '/budgets');
const BOOKS_MAP = linkGate(FINANCE, '/books-map');
const FINANCE_REVIEW = linkGate(FINANCE, FINANCE_REVIEW_PATH);
// FINANCE and BOARD reach it from Finance, an inventory manager from Inventory.
const RECEIPT_FLOW: NavGate = (u, c) => linkGate(FINANCE, '/receipt-flow')(u, c) || linkGate(INVENTORY, '/receipt-flow')(u, c);
const MOPS = (href: string): NavGate => linkGate(MEMBERSHIP_OPS, href);
const FACILITY = (href: string): NavGate => linkGate(FACILITY_OPS, href);
const SYSTEM = SYSTEM_STATUS.visible;
const SETTING = (href: string): NavGate => linkGate(SETTINGS, href);

export type PageEntry = {
  href: string;
  label: string;
  section: string;
  keywords?: string;
  visible: NavGate;
};

export const PAGES: PageEntry[] = [
  // Personal — any signed-in member
  { href: '/my-household', label: 'My Household', section: 'Personal', visible: SIGNED_IN },
  { href: '/my-activities', label: 'My Activities', section: 'Personal', visible: MY_ACTIVITIES.visible },
  { href: '/my-activities/events', label: 'My Events', section: 'Personal', visible: linkGate(MY_ACTIVITIES, '/my-activities/events') },
  { href: '/my-activities/programs', label: 'My Programs', section: 'Personal', visible: linkGate(MY_ACTIVITIES, '/my-activities/programs') },
  { href: '/profile', label: 'My Profile', section: 'Personal', visible: SIGNED_IN },
  // Programs I Lead — the program-leader home, gated as its sidebar section.
  { href: '/programs-i-lead/attendance', label: 'Programs I Lead', section: 'Programs I Lead', keywords: 'program leader attendance confirm', visible: LEADS_PROGRAM },
  { href: '/programs-i-lead/expense-approvals', label: 'Expense approvals', section: 'Programs I Lead', keywords: 'program leader treasurer budget bucket sign-off approve expense reimbursement', visible: linkGate(PROGRAMS_I_LEAD, '/programs-i-lead/expense-approvals') },
  { href: '/programs-i-lead/in-kind-gifts', label: 'In-kind gifts', section: 'Programs I Lead', keywords: 'program leader in-kind donated goods gift program bucket', visible: linkGate(PROGRAMS_I_LEAD, '/programs-i-lead/in-kind-gifts') },
  { href: '/programs-i-lead/conflicts', label: 'Attendance Conflicts', section: 'Programs I Lead', keywords: 'program leader duplicate overlapping visit attendance', visible: linkGate(PROGRAMS_I_LEAD, '/programs-i-lead/conflicts') },
  // Stays visible to all members: also the Join/renewal entry for new applicants
  // who aren't a household lead yet (gating it on lead would break joining).
  { href: '/membership', label: 'Membership Application', section: 'Personal', keywords: 'join intake', visible: SIGNED_IN },
  { href: '/trusted-adults', label: 'Trusted Adults', section: 'Personal', visible: isHouseholdLead },

  // Attendance — any signed-in member
  { href: '/attendance/current', label: 'Attendance', section: 'Attendance', visible: SIGNED_IN },
  { href: '/attendance/manual', label: 'Manual Check-In', section: 'Attendance', visible: SIGNED_IN },
  { href: '/attendance/my-visits', label: 'My Visits', section: 'Attendance', keywords: 'hours correction edit delete', visible: SIGNED_IN },
  { href: '/attendance/household', label: 'Household Check-ins', section: 'Attendance', keywords: 'visits history dependents', visible: SIGNED_IN },
  { href: '/attendance/certifications', label: 'Certifications', section: 'Attendance', visible: seesCertificationGrid },

  // Programs — public
  { href: '/programs', label: 'Programs', section: 'Programs', visible: PUBLIC },

  // Communication — signed-in member
  { href: '/communication', label: 'Communication', section: 'Personal', keywords: 'notifications email preferences settings', visible: SIGNED_IN },

  // Safety — board or isKeyholder
  { href: '/safety', label: 'Safety', section: 'Safety', visible: SAFETY_SECTION },
  { href: '/safety/board-contacts', label: 'Board Contacts', section: 'Safety', visible: SAFETY_SECTION },
  { href: '/safety/emergency-contacts', label: 'Emergency Contacts', section: 'Safety', visible: SAFETY_SECTION },
  { href: '/safety/pickup', label: 'Pickup', section: 'Safety', visible: SAFETY_SECTION },
  { href: '/safety/trusted-adults', label: 'Trusted Adults (Safety)', section: 'Safety', visible: linkGate(SAFETY, '/safety/trusted-adults') },

  // Shop Ops — board or certifier
  { href: '/shop-ops', label: 'Shop Ops', section: 'Shop Ops', visible: SHOP },
  { href: '/shop-ops/create', label: 'Create', section: 'Shop Ops', visible: linkGate(SHOP_OPS, '/shop-ops/create') },
  { href: '/shop-ops/live', label: 'Live', section: 'Shop Ops', visible: linkGate(SHOP_OPS, '/shop-ops/live') },
  { href: '/shop-ops/manage', label: 'Manage', section: 'Shop Ops', visible: linkGate(SHOP_OPS, '/shop-ops/manage') },

  // Inventory (global catalog, #1286) — any catalog viewer. The index redirects
  // to the Global Catalog. Write controls within each screen are INVENTORY_MANAGER-gated.
  { href: '/catalog', label: 'Global Catalog', section: 'Inventory', keywords: 'catalog parts items reference gtin', visible: CATALOG },
  { href: '/catalog/items', label: 'Catalog Items', section: 'Inventory', keywords: 'global catalog parts gtin', visible: CATALOG },
  { href: '/catalog/categories', label: 'Categories', section: 'Inventory', visible: CATALOG },
  { href: '/catalog/proposals', label: 'Proposals', section: 'Inventory', keywords: 'item reference provisional', visible: CATALOG },
  { href: '/catalog/conversion-challenges', label: 'Conversion Challenges', section: 'Inventory', visible: CATALOG },
  // Org inventory (#1287) — same viewer gate; the receiving screens are
  // INVENTORY_MANAGER, FINANCE or BOARD (#2384) and the work-queue screens
  // INVENTORY_MANAGER-only, like their routes.
  { href: '/inventory/org-items', label: 'Org Inventory', section: 'Inventory', keywords: 'stock on hand quantity location', visible: ORG_INVENTORY },
  { href: '/inventory/unlocated', label: 'Needs a Location', section: 'Inventory', keywords: 'unlocated no location shelf', visible: INVENTORY_UNLOCATED },
  { href: '/inventory/inventory-log', label: 'Inventory Log', section: 'Inventory', keywords: 'stock change history quantity receipt donation apply failed delta', visible: INVENTORY_LOG },
  { href: '/inventory/locations', label: 'Locations', section: 'Inventory', keywords: 'shelf bin backstock', visible: ORG_INVENTORY },
  { href: '/inventory/receive-queue', label: 'Receive Queue', section: 'Inventory', keywords: 'backorder receiving', visible: INVENTORY_RECEIVING },
  { href: '/inventory/merge-conflicts', label: 'Merge Conflicts', section: 'Inventory', keywords: 'uom mismatch', visible: INVENTORY_MANAGER },
  { href: '/inventory/provisional-items', label: 'Provisional Map', section: 'Inventory', keywords: 'provisional part', visible: INVENTORY_MANAGER },
  { href: '/inventory/org-events', label: 'Org Events', section: 'Inventory', keywords: 'catalog events', visible: INVENTORY_MANAGER },
  // Part mapping (#1289) — receipt mapping. Mirrors the routes' read gate:
  // INVENTORY_MANAGER, FINANCE or BOARD; writes inside are manager-only.
  { href: '/inventory/receiving', label: 'Part Mapping', section: 'Inventory', keywords: 'receiving receipt mapping proceed apply failed', visible: PART_MAPPING },
  { href: '/inventory/receiving/audit-log', label: 'Part Mapping Audit Log', section: 'Inventory', keywords: 'receiving receipt mapping history', visible: PART_MAPPING },

  // Income — FINANCE works it, BOARD reads it (the routes' finance-or-board gate).
  // The index redirects to Item Categories; Payouts and Reconciliation sit under the Shopify tab.
  { href: '/income', label: 'Income', section: 'Income', keywords: 'shopify payout quickbooks', visible: INCOME },
  { href: '/income/payouts', label: 'Payouts', section: 'Income', keywords: 'shopify payout deposit', visible: REVENUE('/income/payouts') },
  { href: '/income/reconciliation', label: 'Income Reconciliation', section: 'Income', keywords: 'payout deposit quickbooks drift', visible: REVENUE('/income/reconciliation') },
  { href: '/income/items', label: 'Item Categories', section: 'Income', keywords: 'budget owner bucket class', visible: REVENUE('/income/items') },
  { href: '/income/exclusions', label: 'QB Exclusions', section: 'Income', keywords: 'quickbooks deposit exclude', visible: REVENUE('/income/exclusions') },

  // My Receipts — anyone who may upload; Finance — finance.
  { href: '/receipts', label: 'My Receipts', section: 'My Receipts', keywords: 'receipt reimbursement upload purchase', visible: linkGate(MY_RECEIPTS, '/receipts') },
  { href: '/receipts/upload', label: 'Upload Receipt', section: 'My Receipts', keywords: 'receipt photo pdf purchase donation', visible: linkGate(MY_RECEIPTS, '/receipts/upload') },
  { href: '/receipts/confirm', label: 'Receipts to Confirm', section: 'My Receipts', keywords: 'receipt reimbursement confirm sign', visible: linkGate(MY_RECEIPTS, '/receipts/confirm') },
  { href: FINANCE_REVIEW_PATH, label: 'Finance Review', section: 'Finance', keywords: 'receipt expense finance tax duplicate queue flags holds quickbooks board sign treasurer', visible: FINANCE_REVIEW },
  { href: '/receipts/mail', label: 'Incoming Receipt Queue', section: 'Finance', keywords: 'receipt email gmail mail held assign discard incoming', visible: linkGate(FINANCE, '/receipts/mail') },
  { href: '/receipts/settings', label: 'Receipt Settings', section: 'Finance', keywords: 'tax exempt age limit', visible: linkGate(FINANCE, '/receipts/settings') },
  { href: '/receipt-flow', label: 'Receipt Flow Status', section: 'Finance', keywords: 'receipt receiving expense state count applying status', visible: RECEIPT_FLOW },

  // Facility Ops — board, plus operations on the two aggregate tools. The index
  // redirects to the caller's first visible tab, so it is listed to anyone the
  // section admits.
  { href: '/facility-ops', label: 'Facility Ops', section: 'Facility Ops', visible: FACILITY_OPS.visible },
  { href: '/facility-ops/badges', label: 'Badges', section: 'Facility Ops', visible: FACILITY('/facility-ops/badges') },
  { href: '/facility-ops/print-badges', label: 'Print Badges', section: 'Facility Ops', visible: FACILITY('/facility-ops/print-badges') },
  { href: '/facility-ops/trends', label: 'Trends', section: 'Facility Ops', visible: FACILITY('/facility-ops/trends') },
  { href: '/facility-ops/visits', label: 'Visits', section: 'Facility Ops', visible: FACILITY('/facility-ops/visits') },
  { href: '/facility-ops/corrections', label: 'Corrections', section: 'Facility Ops', keywords: 'audit attendance edit delete flagged significance review', visible: FACILITY('/facility-ops/corrections') },

  // Membership Ops — admin tools, plus operations (Participants) and background-check
  // reviewers (Review). Pages that are not tabs take the admin gate.
  { href: '/membership-ops', label: 'Membership Ops', section: 'Membership Ops', visible: isMembershipOpsAdmin },
  { href: '/membership-ops/applications', label: 'Applications', section: 'Membership Ops', visible: MOPS('/membership-ops/applications') },
  { href: '/membership-ops/households', label: 'Households', section: 'Membership Ops', visible: MOPS('/membership-ops/households') },
  { href: '/membership-ops/volunteer-memberships', label: 'Volunteer Families', section: 'Membership Ops', visible: MOPS('/membership-ops/volunteer-memberships') },
  { href: '/membership-ops/participants', label: 'Participants', section: 'Membership Ops', visible: MOPS('/membership-ops/participants') },
  { href: '/membership-ops/participants/new', label: 'New Participant', section: 'Membership Ops', visible: isMembershipOpsAdmin },
  { href: '/membership-ops/participants/merge', label: 'Merge Participants', section: 'Membership Ops', visible: MOPS('/membership-ops/participants/merge') },
  { href: '/membership-ops/participants/tombstones', label: 'Tombstone Census', section: 'Membership Ops', visible: isMembershipOpsAdmin },
  { href: '/membership-ops/review', label: 'Background-check Review', section: 'Membership Ops', visible: MOPS('/membership-ops/review') },
  { href: '/membership-ops/roles', label: 'Roles', section: 'Membership Ops', visible: MOPS('/membership-ops/roles') },

  // Membership Audit — board
  { href: '/membership-audit', label: 'Membership Audit', section: 'Membership Audit', visible: MEMBERSHIP_AUDIT.visible },
  { href: '/membership-audit/emergency-contacts', label: 'Missing Emergency Contacts', section: 'Membership Audit', visible: MEMBERSHIP_AUDIT.visible },
  { href: '/membership-audit/unclaimed', label: 'Unclaimed Accounts', section: 'Membership Audit', visible: MEMBERSHIP_AUDIT.visible },
  { href: '/membership-audit/broken', label: 'Broken Households', section: 'Membership Audit', keywords: 'lead leadless no lead unclaimed', visible: MEMBERSHIP_AUDIT.visible },
  { href: '/membership-audit/compliance', label: 'Membership Compliance', section: 'Membership Audit', keywords: 'violations background check revoked denied stale follow-up', visible: MEMBERSHIP_AUDIT.visible },
  { href: '/membership-audit/bg-attestations', label: 'BG Attestations', section: 'Membership Audit', keywords: 'background check attestation reviewer signed off who approved', visible: MEMBERSHIP_AUDIT.visible },
  { href: '/membership-audit/turning-18', label: 'Students 18+', section: 'Membership Audit', keywords: 'age 18 adult turning eighteen agreement member year sept 1 september', visible: MEMBERSHIP_AUDIT.visible },

  // Program Ops — board
  { href: '/program-ops', label: 'Program Ops', section: 'Program Ops', visible: PROGRAM_OPS.visible },
  { href: '/program-ops/programs', label: 'All Programs', section: 'Program Ops', visible: PROGRAM_OPS.visible },
  { href: '/program-ops/events', label: 'Events', section: 'Program Ops', visible: PROGRAM_OPS.visible },
  { href: '/program-ops/new', label: 'New Program', section: 'Program Ops', visible: PROGRAM_OPS.visible },
  { href: '/program-ops/sessions', label: 'Sessions', section: 'Program Ops', visible: PROGRAM_OPS.visible },
  { href: '/program-ops/sessions/new', label: 'New Session', section: 'Program Ops', visible: PROGRAM_OPS.visible },

  // Revenue Ops (path /finance-ops) — the finance tools are board-only
  { href: '/finance-ops', label: 'Revenue Ops', section: 'Revenue Ops', visible: FINANCE_TOOLS },
  { href: '/finance-ops/payment-plan', label: 'Program Payment Plan', section: 'Revenue Ops', visible: FINANCE_TOOLS },
  { href: '/finance-ops/membership-payment-plan', label: 'Membership Payment Plan', section: 'Revenue Ops', visible: FINANCE_TOOLS },
  { href: '/finance-ops/shopify-holds', label: 'Shopify Hold Reconciliation', section: 'Revenue Ops', keywords: 'seat hold failed inventory scholarship manual reconcile shopify', visible: REVENUE('/finance-ops/shopify-holds') },
  { href: '/finance-ops/shopify-stock', label: 'Unconfirmed Shopify stock', section: 'Revenue Ops', keywords: 'inventory seats unconfirmed settle carry shopify stock', visible: REVENUE('/finance-ops/shopify-stock') },
  { href: '/finance-ops/payments', label: 'Payment problems', section: 'Revenue Ops', keywords: 'reconcile exception refund chargeback unmatched shopify', visible: REVENUE('/finance-ops/payments') },

  // Finance — FINANCE or BOARD
  { href: '/budgets', label: 'Budgets', section: 'Finance', keywords: 'budget owner bucket treasurer approver quickbooks class', visible: BUDGETS },
  { href: '/books-map', label: 'Books map', section: 'Finance', keywords: 'quickbooks account class bank role shopify benevity deposit', visible: BOOKS_MAP },
  { href: '/expense/expenses', label: 'Expenses', section: 'Finance', keywords: 'receipt reimbursement approval sign-off queue', visible: EXPENSES },
  { href: '/expense/account-mapping', label: 'Account Mapping', section: 'Finance', keywords: 'quickbooks rule category', visible: EXPENSES },
  { href: '/expense/qb-accounts', label: 'QuickBooks Accounts', section: 'Finance', keywords: 'qb account list chart of accounts category', visible: EXPENSES },
  { href: '/expense/ownership-map', label: 'Part Buckets', section: 'Finance', keywords: 'budget owner bucket part ownership map gtin', visible: EXPENSES },
  { href: '/expense/capital-seed', label: 'Capital Seed', section: 'Finance', keywords: 'itfa capital register asset', visible: EXPENSES },
  { href: '/expense/donated-capital', label: 'Donated Equipment', section: 'Finance', keywords: 'in-kind gift capital asset itfa', visible: EXPENSES },

  // Donations — FINANCE or BOARD
  { href: '/donations', label: 'Donations', section: 'Donations', visible: DONATIONS },
  { href: '/donations/uploads', label: 'Benevity Uploads', section: 'Donations', keywords: 'benevity csv import corporate giving', visible: DONATIONS },
  { href: '/donations/unassigned', label: 'Unassigned Gifts', section: 'Donations', keywords: 'owner bucket assign organizational level', visible: DONATIONS },
  { href: '/donations/transactions', label: 'Gifts', section: 'Donations', keywords: 'donation donor match benevity', visible: DONATIONS },
  { href: '/donations/holds', label: 'Disbursement Holds', section: 'Donations', keywords: 'account map no match resubmit', visible: DONATIONS },
  { href: '/donations/in-kind', label: 'In-kind Queue', section: 'Donations', keywords: 'in-kind receipt donor needed withdrawn anomaly', visible: DONATIONS },
  { href: '/donations/events', label: 'Booking Batches', section: 'Donations', keywords: 'disbursement quickbooks deposit', visible: DONATIONS },
  { href: '/donations/qb-queue', label: 'QuickBooks Queue', section: 'Donations', keywords: 'quickbooks deposit match ambiguous retry held disbursement', visible: DONATIONS },
  { href: '/donations/comment-rules', label: 'Comment Rules', section: 'Donations', keywords: 'donor comment owner rule', visible: DONATIONS },
  { href: '/donations/account-map', label: 'Account Map', section: 'Donations', keywords: 'ledger gl account donation match fees', visible: DONATIONS },
  { href: '/donations/qb-exclusions', label: 'QuickBooks Exclusions', section: 'Donations', keywords: 'quickbooks match exclude', visible: DONATIONS },
  // No-receipt in-kind gifts — FINANCE, BOARD, OPERATIONS or INVENTORY_MANAGER, like the list route.
  { href: '/donations/in-kind-gifts', label: 'In-kind Gifts', section: 'Donations', keywords: 'donation donor gift no receipt', visible: linkGate(DONATIONS_SECTION, '/donations/in-kind-gifts') },

  // System Status — board
  { href: '/system-status', label: 'System Status', section: 'System Status', visible: SYSTEM },
  { href: '/system-status/health', label: 'Health', section: 'System Status', visible: SYSTEM },
  { href: '/system-status/errors', label: 'Errors', section: 'System Status', visible: SYSTEM },
  { href: '/system-status/unsynced-scans', label: 'Unsynced Scans', section: 'System Status', keywords: 'kiosk parked replay badge scan review stale out of order offline queue', visible: linkGate(SYSTEM_STATUS, '/system-status/unsynced-scans') },
  { href: '/system-status/audit-log', label: 'Audit Log', section: 'System Status', visible: SYSTEM },
  { href: '/system-status/links', label: 'Links', section: 'System Status', visible: SYSTEM },
  { href: '/system-status/lifecycle', label: 'Lifecycle', section: 'System Status', keywords: 'invariant validate off-diagram drift reconcile enrollment membership state machine', visible: SYSTEM },

  // Settings — board
  { href: '/settings/membership', label: 'Membership Settings', section: 'Settings', visible: SETTING('/settings/membership') },
  { href: '/settings/localization', label: 'Localization', section: 'Settings', visible: SETTING('/settings/localization') },
  { href: '/settings/email', label: 'Email Settings', section: 'Settings', keywords: 'sender from reply-to identity', visible: SETTING('/settings/email') },
  { href: '/settings/outreach', label: 'Outreach', section: 'Settings', keywords: 'renewal join campaign email template bulk send reminder opening', visible: SETTING('/settings/outreach') },
  { href: '/settings/shopify-webhook', label: 'Shopify Webhook', section: 'Settings', keywords: 'orders paid delivery test notification signature secret payment', visible: SETTING('/settings/shopify-webhook') },
  { href: '/settings/finance', label: 'Finance Settings', section: 'Settings', keywords: 'expense threshold capital board review note in lieu', visible: SETTING('/settings/finance') },
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
  '/programs-i-lead',        // redirects to /programs-i-lead/attendance
  '/expense',                // redirects to /expense/expenses
  '/dev',                    // dev-tools hub, redirects to /dev/sent-mail
  '/dev/sent-mail',          // dev-only captured-email inbox (EMAIL_DEV_MOCK.md); 404s off dev
  '/dev/zoho-sign',          // dev-only Zoho Sign mock interstitial (404 in prod)
  '/dev/shopify',            // dev-only Shopify orders/paid mock (docs/ops/shopify-dev-store.md); 404s off dev
  '/membership-ops/participants/import', // optional CSV import module; 404s unless CSV_IMPORT_ENABLED=true, reached from Participants
  '/dev/bg-consent',         // dev-only background-check consent mock (docs/ops/background-check-mock.md); 404s off dev
];
