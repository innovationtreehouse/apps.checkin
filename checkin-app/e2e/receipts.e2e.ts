/**
 * Receipts in the browser: what a submitter, FINANCE, a plain member and a signed-out visitor
 * see and can do on the receipt pages. Each test sets up its own receipt over HTTP and drives
 * the page it is about. Every page must show no error (support/pageErrors).
 */
import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "../flow-tests/helpers";
import { watchPage, type PageWatch } from "./support/pageErrors";
import { daysAgo, inReview, uploadForReading, uploadManual } from "./support/receipts";
import { APPROVER, FINANCE, INVENTORY_MANAGER, MEMBER, releaseLibraries, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

const SUBMITTER = INVENTORY_MANAGER;
/** A second submitter: a role holder, so admitted to receipts. */
const OTHER_SUBMITTER = APPROVER;

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const undo: Undo[] = [];
test.beforeAll(async () => {
  undo.push(await releaseLibraries());
});
test.afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

async function noProblems(watch: PageWatch, where: string): Promise<void> {
  expect([where, await watch.problems()]).toEqual([where, []]);
}

/** Leaves the page alone until a client-side redirect has landed. */
const settle = (page: Page) => page.waitForLoadState("networkidle");

test.describe("receipts in the browser", () => {
  test("a submitter's receipt shows its money exactly", async ({ browser }) => {
    const retailer = `E2E Money ${stamp()}`;
    // A typed-in receipt is done on upload, so its page shows its lines as a table.
    const receipt = await uploadManual(await loginAs(SUBMITTER), retailer, [{ description: "Money widget", quantity: 2, unitPrice: 61.73 }]);
    expect(receipt.state).toBe("receipt_finalized");
    const { context } = await signIn(browser, SUBMITTER);
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto(`/receipts/${encodeURIComponent(receipt.id)}`);
    await expect(page.getByRole("heading", { name: retailer })).toBeVisible();
    await expect(page.getByText(/^Total: \$123\.46 \(tax \$0\.00, shipping \$0\.00\)$/)).toBeVisible();
    const line = page.getByRole("row").filter({ hasText: "Money widget" });
    await expect(line.getByRole("cell")).toHaveText(["Money widget", "2", "$123.46"]);
    await expect(page.getByText(/NaN|undefined/)).toHaveCount(0);
    await noProblems(watch, "receipt detail");
    await context.close();
  });

  test("a submitter sees only their own receipts", async ({ browser }) => {
    const mine = `E2E Mine ${stamp()}`;
    const theirs = `E2E Theirs ${stamp()}`;
    await uploadManual(await loginAs(SUBMITTER), mine, [{ description: "Mine", quantity: 1, unitPrice: 5 }]);
    const other = await uploadManual(await loginAs(OTHER_SUBMITTER), theirs, [{ description: "Theirs", quantity: 1, unitPrice: 5 }]);
    const { context } = await signIn(browser, SUBMITTER);
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto("/receipts");
    await expect(page.getByText(mine)).toBeVisible();
    await expect(page.getByText(theirs)).toHaveCount(0);
    await noProblems(watch, "my receipts");

    // Opening someone else's receipt by its address shows none of it.
    await page.goto(`/receipts/${encodeURIComponent(other.id)}`);
    await settle(page);
    await expect(page.getByRole("heading", { name: theirs })).toHaveCount(0);
    await context.close();
  });

  test("a submitter's date correction sends the receipt to finance review, and FINANCE's rejection sticks", async ({ browser }) => {
    const receipt = await inReview(await loginAs(SUBMITTER), await loginAs(FINANCE), `E2E corrected ${stamp()}`);

    const submitter = await signIn(browser, SUBMITTER);
    const page = await submitter.context.newPage();
    const watch = watchPage(page);
    await page.goto(`/receipts/${encodeURIComponent(receipt.id)}`);
    await page.getByLabel("Date", { exact: true }).fill(daysAgo(2));
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByText("Finance review", { exact: true })).toBeVisible();
    await expect(page.getByText(/the submitter changed the tax or date/)).toBeVisible();
    await noProblems(watch, "submitter correction");

    const finance = await signIn(browser, FINANCE);
    const review = await finance.context.newPage();
    const financeWatch = watchPage(review);
    await review.goto(`/receipts/${encodeURIComponent(receipt.id)}?queue=all`);
    await review.getByLabel("Reason to reject").fill("E2E rejection");
    await review.getByRole("button", { name: "Reject", exact: true }).click();
    await review.waitForURL(/\/finance\/review(\?|$)/);
    await noProblems(financeWatch, "FINANCE rejects");

    await review.goto(`/receipts/${encodeURIComponent(receipt.id)}?queue=all`);
    await expect(review.getByText("Rejected", { exact: true })).toBeVisible();
    await expect(review.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);
    await submitter.context.close();
    await finance.context.close();
  });

  test("a submitter discards their own receipt", async ({ browser }) => {
    const receipt = await inReview(await loginAs(SUBMITTER), await loginAs(FINANCE), `E2E discard ${stamp()}`);
    const { context } = await signIn(browser, SUBMITTER);
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto(`/receipts/${encodeURIComponent(receipt.id)}`);
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    // The success chip also reads "Discarded", so read the page's own badge.
    const badge = page.getByRole("main").getByText("Discarded", { exact: true });
    await expect(badge).toBeVisible();
    await page.reload();
    await expect(badge).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
    await noProblems(watch, "discard");
    await context.close();
  });

  test("FINANCE sees a receipt's file and its history", async ({ browser }) => {
    const text = `E2E file body ${stamp()}`;
    const receipt = await inReview(await loginAs(SUBMITTER), await loginAs(FINANCE), text);
    const { context } = await signIn(browser, FINANCE);
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto(`/receipts/${encodeURIComponent(receipt.id)}?queue=all`);
    await expect(page.getByText(text)).toBeVisible();
    await expect(page.getByText("History", { exact: true })).toBeVisible();
    await noProblems(watch, "FINANCE receipt detail");
    await context.close();
  });

  test("FINANCE compares a suspected duplicate's file with its original's", async ({ browser }) => {
    const id = stamp();
    const submitter = await loginAs(SUBMITTER);
    // The OCR mock reads every upload as the same purchase, so the second read repeats the first.
    await inReview(submitter, await loginAs(FINANCE), `E2E original ${id}`);
    const copy = await uploadForReading(submitter, `E2E copy ${id}`);
    expect(copy.state).toBe("duplicate_flagged");

    const { context } = await signIn(browser, FINANCE);
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto(`/receipts/${encodeURIComponent(copy.id)}?queue=all`);
    // The suspected original is the earliest matching read, which may be another test's receipt.
    await expect(page.getByText("This receipt's file", { exact: true })).toBeVisible();
    // The page shows this receipt's file above the comparison as well.
    await expect(page.getByText(`E2E copy ${id}`).first()).toBeVisible();
    await expect(page.getByText("The original's file", { exact: true })).toBeVisible();
    await expect(page.getByText("The original's file is not loaded.")).toHaveCount(0);
    await noProblems(watch, "duplicate compare");
    await context.close();
  });

  test("FINANCE saves the receipt settings", async ({ browser }) => {
    const { context } = await signIn(browser, FINANCE);
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto("/receipts/settings");
    const ageLimit = page.getByLabel("Age limit (days)");
    await expect(ageLimit).not.toHaveValue("");
    const before = await ageLimit.inputValue();
    const changed = String(Number(before) + 1);

    await ageLimit.fill(changed);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".mantine-Notification-root").filter({ hasText: "Settings saved" })).toBeVisible();
    await page.reload();
    await expect(ageLimit).toHaveValue(changed);

    await ageLimit.fill(before);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.reload();
    await expect(ageLimit).toHaveValue(before);
    await noProblems(watch, "receipt settings");
    await context.close();
  });

  test("a plain member is sent away from Finance review", async ({ browser }) => {
    const { context } = await signIn(browser, MEMBER);
    const page = await context.newPage();
    await page.goto("/finance/review");
    await settle(page);
    await expect(page).toHaveURL((url) => url.pathname === "/");
    await context.close();
  });

  test("a signed-out visitor is sent away from the receipt pages", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const path of ["/receipts", "/receipts/upload", "/finance/review"]) {
      await page.goto(path);
      await settle(page);
      await expect(page, path).not.toHaveURL((url) => url.pathname === path);
    }
    await context.close();
  });
});
