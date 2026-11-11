/**
 * The expense list's views in the browser: each viewer sees only the views they can act in, and
 * the server refuses the others. A program lead never sees Assign or Resolve ownership (@thpr:
 * "visibility needs to be restricted to who can act"). Who can act in each view is the expense
 * library's VIEW_ACTORS (packages/expense/src/nav.ts), from the checks each view's acts run.
 */
import { expect, test, type Page } from "@playwright/test";
import { api, type Session } from "../flow-tests/helpers";
import { watchPage } from "./support/pageErrors";
import { APPROVER, BOARD, bucket, FINANCE, releaseLibraries, TREASURER, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

/** Each view's tab label and its `?view=` value. */
const LABELS: Record<string, string> = {
  all: "All",
  awaiting_me: "Waiting on you",
  assign_ownership: "Assign ownership",
  resolve_ownership: "Resolve ownership",
  owner_approval: "Owner approval",
  owner_exception: "Exceptions",
  capital_review: "Capital review",
  set_depreciation_cycle: "Depreciation",
  qb_pending: "QB pending",
};
const ALL_VIEWS = Object.keys(LABELS);

interface Viewer { email: string; page: string; views: string[] }
const VIEWERS: Viewer[] = [
  {
    email: FINANCE,
    page: "/expense/expenses",
    views: ["all", "assign_ownership", "resolve_ownership", "owner_approval", "owner_exception", "capital_review", "set_depreciation_cycle", "qb_pending"],
  },
  { email: BOARD, page: "/expense/expenses", views: ["all", "awaiting_me", "owner_approval", "qb_pending"] },
  { email: APPROVER, page: "/programs-i-lead/expense-approvals", views: ["all", "awaiting_me", "owner_approval"] },
  { email: TREASURER, page: "/programs-i-lead/expense-approvals", views: ["all", "awaiting_me", "owner_approval"] },
];

const undo: Undo[] = [];
test.beforeAll(async () => {
  undo.push(await releaseLibraries());
  // The approver owns a bucket and the treasurer is its treasurer, which is what makes them approvers.
  undo.push((await bucket(`Expense views ${Date.now()}`, APPROVER, TREASURER)).undo);
});
test.afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

/** The view tabs' labels, without their counts and pills, once at least `expected` tabs show. */
async function viewLabels(page: Page, expected: number): Promise<string[]> {
  const labels = page.locator(".mantine-SegmentedControl-label");
  // The list shows only "All" until the nav counts load.
  await expect.poll(() => labels.count()).toBeGreaterThanOrEqual(expected);
  return (await labels.allInnerTexts()).map((t) => t.replace(/\s*\(\d+\)/, "").replace(/\s*\d+\s*$/, "").trim());
}

async function sessionFlags(s: Session): Promise<{ isFinance: boolean; isBoard: boolean }> {
  const me = await api<{ user?: { isFinance?: boolean; isBoardMember?: boolean } }>(s, "/api/auth/session");
  return { isFinance: me.json.user?.isFinance === true, isBoard: me.json.user?.isBoardMember === true };
}

for (const viewer of VIEWERS) {
  test(`${viewer.email} sees only the expense views they can act in`, async ({ browser }) => {
    const { context, session } = await signIn(browser, viewer.email);
    // The expected views assume the seed's roles: FINANCE is not Board, the Board is not FINANCE.
    expect(await sessionFlags(session)).toEqual({ isFinance: viewer.email === FINANCE, isBoard: viewer.email === BOARD });
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto(viewer.page);
    expect(await viewLabels(page, viewer.views.length)).toEqual(viewer.views.map((v) => LABELS[v]));

    const failures: string[] = [];
    for (const view of viewer.views) {
      await test.step(LABELS[view], async () => {
        await page.goto(`${viewer.page}?view=${view}&page=1`);
        await page.waitForLoadState("networkidle");
        failures.push(...(await watch.problems()).map((p) => `${view}: ${p}`));
      });
    }
    expect(failures).toEqual([]);

    // The routes refuse a view the viewer cannot act in.
    for (const view of ALL_VIEWS.filter((v) => !viewer.views.includes(v))) {
      const res = await api(session, `/api/expense/expenses?view=${view}&page=1&limit=50`);
      expect([view, res.status]).toEqual([view, 403]);
    }
    await context.close();
  });
}
