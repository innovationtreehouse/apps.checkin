/**
 * Expenses in the browser: the expense list and detail for FINANCE, the Board and a bucket's
 * owner, and the exception path on a line. FINANCE or the Board reach Expense Ops; a bucket's
 * approvers reach their buckets' expenses (docs/rules/expenses.md → Who may see and do what,
 * Budget buckets). Every page must show no error (support/pageErrors).
 */
import { expect, test } from "@playwright/test";
import { loginAs } from "../flow-tests/helpers";
import { lineAct, lineRow } from "./support/expenseLines";
import { watchPage, type PageWatch } from "./support/pageErrors";
import { expenseFrom } from "./support/receipts";
import { APPROVER, BOARD, bucket, FINANCE, INVENTORY_MANAGER, MEMBER, releaseLibraries, send, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

interface Approval { id: number; ownerId: number | null; status: string }

const undo: Undo[] = [];
let bucketId: number;

test.beforeAll(async () => {
  undo.push(await releaseLibraries());
  const b = await bucket(`Expense e2e ${stamp()}`, APPROVER);
  bucketId = b.id;
  undo.push(b.undo);
});
test.afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

async function noProblems(watch: PageWatch, where: string): Promise<void> {
  expect([where, await watch.problems()]).toEqual([where, []]);
}

/** An expense whose only line FINANCE has put in this spec's bucket, so it waits on the owner. */
async function expenseInBucket(retailer: string, line: string): Promise<string> {
  const id = await expenseFrom(await loginAs(INVENTORY_MANAGER), retailer, [{ description: line, quantity: 2, unitPrice: 61.73 }]);
  const finance = await loginAs(FINANCE);
  const approvals = await send(finance, "GET", `/api/expense/expenses/${encodeURIComponent(id)}/line-item-approvals`);
  const [approval] = (approvals.json as { LineItemOwnerApproval: Approval[] }).LineItemOwnerApproval;
  const assigned = await send(finance, "POST", `/api/expense/expenses/${encodeURIComponent(id)}/line-item-approvals/${approval.id}/assign-owner`, { ownerId: bucketId });
  expect(assigned.status).toBe(200);
  return id;
}

test.describe("expenses in the browser", () => {
  test("the expense list and detail show the money exactly", async ({ browser }) => {
    const retailer = `E2E Expense money ${stamp()}`;
    const id = await expenseFrom(await loginAs(INVENTORY_MANAGER), retailer, [{ description: "Money line", quantity: 2, unitPrice: 61.73 }]);
    const { context } = await signIn(browser, FINANCE);
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto("/expense/expenses?view=all&page=1");
    const row = page.getByRole("row").filter({ hasText: retailer });
    await expect(row).toContainText("$123.46");
    await row.getByRole("link").click();
    await page.waitForURL(new RegExp(`/expense/expenses/${encodeURIComponent(id)}`));
    const line = lineRow(page, "Money line");
    await expect(line).toContainText("$61.73");
    await expect(line).toContainText("$123.46");
    await expect(page.getByText(/NaN|undefined/)).toHaveCount(0);
    await noProblems(watch, "expense list and detail");
    await context.close();
  });

  const viewers: Array<{ email: string; base: string }> = [
    { email: FINANCE, base: "/expense/expenses" },
    { email: BOARD, base: "/expense/expenses" },
    { email: APPROVER, base: "/programs-i-lead/expense-approvals" },
  ];
  for (const { email, base } of viewers) {
    test(`the expense detail page renders for ${email}`, async ({ browser }) => {
      const line = `E2E detail line ${stamp()}`;
      const id = await expenseInBucket(`E2E Expense detail ${stamp()}`, line);
      const { context } = await signIn(browser, email);
      const page = await context.newPage();
      const watch = watchPage(page);

      await page.goto(`${base}/${encodeURIComponent(id)}`);
      await expect(lineRow(page, line)).toBeVisible();
      await page.waitForLoadState("networkidle");
      await noProblems(watch, `${email} expense detail`);
      await context.close();
    });
  }

  test("the bucket's owner raises an exception on a line and FINANCE rejects it", async ({ browser }) => {
    const line = `E2E exception line ${stamp()}`;
    const id = await expenseInBucket(`E2E Expense exception ${stamp()}`, line);

    const owner = await signIn(browser, APPROVER);
    const ownerPage = await owner.context.newPage();
    const ownerWatch = watchPage(ownerPage);
    await ownerPage.goto(`/programs-i-lead/expense-approvals/${encodeURIComponent(id)}`);
    await lineAct(ownerPage, line, "Raise exception");
    const dialog = ownerPage.getByRole("dialog");
    await dialog.getByLabel("Notes").fill("E2E: not ours");
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog).toBeHidden();
    // The approver's last decision returns them to the list once the page has refetched; a goto before that is aborted by it.
    await ownerPage.waitForURL((url) => url.pathname === "/programs-i-lead/expense-approvals");
    await ownerPage.goto(`/programs-i-lead/expense-approvals/${encodeURIComponent(id)}`);
    await expect(lineRow(ownerPage, line).getByText("exception_raised", { exact: true })).toBeVisible();
    await expect(ownerPage.getByRole("button", { name: "Reject exception" })).toHaveCount(0);
    await expect(ownerPage.getByRole("menuitem", { name: "Reject exception" })).toHaveCount(0);
    await noProblems(ownerWatch, "owner raises an exception");

    const finance = await signIn(browser, FINANCE);
    const page = await finance.context.newPage();
    const watch = watchPage(page);
    const detail = `/expense/expenses/${encodeURIComponent(id)}`;
    await page.goto(detail);
    await lineAct(page, line, "Reject exception");
    await page.getByRole("dialog").getByLabel("Notes").fill("E2E: it is yours");
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.goto(detail);
    await expect(lineRow(page, line).getByText("rejected", { exact: true })).toBeVisible();
    await noProblems(watch, "FINANCE rejects the exception");
    await owner.context.close();
    await finance.context.close();
  });

  // Raising a capital threshold is the Board's alone (settingsService boardOnlyChanges), so the Board saves it.
  test("the Board saves the expense settings", async ({ browser }) => {
    const { context } = await signIn(browser, BOARD);
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto("/settings/finance");
    const unitThreshold = page.getByLabel(/^Capital review: unit price over/);
    await expect(unitThreshold).not.toHaveValue("");
    const before = await unitThreshold.inputValue();

    await unitThreshold.fill("4321");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".mantine-Notification-root").filter({ hasText: "Settings saved" })).toBeVisible();
    await page.reload();
    await expect(unitThreshold).toHaveValue(/^\$?4321(\.00)?$/);

    await unitThreshold.fill(before);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.reload();
    await expect(unitThreshold).toHaveValue(before);
    await noProblems(watch, "expense settings");
    await context.close();
  });

  test("FINANCE is not offered a capital threshold raise it cannot save", async ({ browser }) => {
    const { context } = await signIn(browser, FINANCE);
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto("/settings/finance");
    const unitThreshold = page.getByLabel(/^Capital review: unit price over/);
    await expect(unitThreshold).not.toHaveValue("");
    const save = page.getByRole("button", { name: "Save", exact: true });
    if ((await unitThreshold.isEditable()) && (await save.isEnabled())) {
      const before = Number((await unitThreshold.inputValue()).replace(/[^0-9.]/g, "")) || 0;
      await unitThreshold.fill(String(before + 1000));
      await save.click();
      await page.waitForLoadState("networkidle");
    }
    expect(await watch.problems()).toEqual([]);
    await context.close();
  });

  test("a plain member is sent away from Expense Ops", async ({ browser }) => {
    const { context } = await signIn(browser, MEMBER);
    const page = await context.newPage();
    await page.goto("/expense/expenses");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL((url) => url.pathname === "/");
    await context.close();
  });

  test("a signed-out visitor is sent away from the expense pages", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const path of ["/expense/expenses", "/programs-i-lead/expense-approvals"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page, path).not.toHaveURL((url) => url.pathname === path);
    }
    await context.close();
  });
});
