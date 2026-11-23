/**
 * The golden path in the browser: the inventory manager uploads a receipt, which the local OCR
 * mock reads, and reviews it (names its retailer and line, then confirms); Part mapping links
 * its line to a catalog part (the last line resolved applies it, adding it to org stock), FINANCE
 * puts the expense line in a bucket, the bucket's owner approves it, FINANCE signs it as
 * Treasurer, and sees the line in its expense review. The purchase is a card charge, so no
 * reimbursee is named, and QuickBooks is not wired here, so the expense stops before posting.
 * A second receipt's line, proposed as a new item, resolves against that item once the catalog
 * approves it. Every page on the way must show no error.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { api, differentPurchases, loginAs, type Session, untilRead } from "../flow-tests/helpers";
import { lineAct, lineRow } from "./support/expenseLines";
import { watchPage, type PageWatch } from "./support/pageErrors";
import { inReceiving, resolveAndReopen } from "./support/receipts";
import { APPROVER, bucket, FINANCE, INVENTORY_MANAGER, releaseLibraries, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const RETAILER = `E2E Hardware ${stamp}`;
const LINE = `Golden path part ${stamp}`;
/** A seeded catalog item (packages/global-catalog/prisma/seed.ts). */
const CATALOG_ITEM = "Power Distribution Hub";

const undo: Undo[] = [];
let bucketName: string;
let catalogGtin: string;

/** The GTIN of the catalog item named exactly `name`. */
async function gtinOf(s: Session, name: string): Promise<string> {
  const found = await api<Array<{ gtin13: string; name: string }>>(s, `/api/catalog/items?q=${encodeURIComponent(name)}&limit=20`);
  const item = found.json.find((i) => i.name === name);
  if (!item) throw new Error(`catalog item ${name} not found`);
  return item.gtin13;
}

/** The org's on-hand quantity of `gtin13`. */
async function onHand(s: Session, gtin13: string): Promise<number> {
  const rows = await api<{ OrgItem: Array<{ gtin13: string; existingQuantity: number }> }>(s, `/api/inventory/org-items?q=${gtin13}&page=1&limit=50`);
  return rows.json.OrgItem.find((r) => r.gtin13 === gtin13)?.existingQuantity ?? 0;
}

interface LineStatus { id: number; recognitionStatus: string; assignedGtin13: string | null }
const receivedLines = async (s: Session, receivedId: number) =>
  (await api<{ ReceivedReceiptLineStatus: LineStatus[] }>(s, `/api/workflow-mapping/receipts/${receivedId}`)).json.ReceivedReceiptLineStatus;

test.beforeAll(async () => {
  undo.push(await releaseLibraries());
  catalogGtin = await gtinOf(await loginAs(INVENTORY_MANAGER), CATALOG_ITEM);
  const b = await bucket(`Golden path ${stamp}`, APPROVER);
  bucketName = b.name;
  undo.push(b.undo);
});

test.afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

/** Waits for `locator`, reloading for state a page reads once on load; never reloads before a first look. */
async function eventually(page: Page, locator: Locator): Promise<void> {
  if (await locator.isVisible()) return;
  await expect(async () => {
    await page.reload();
    await expect(locator).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}


async function noProblems(watch: PageWatch, where: string): Promise<void> {
  expect([where, await watch.problems()]).toEqual([where, []]);
}

const line = (page: Page) => lineRow(page, LINE);

test("a receipt goes from upload to an approved line in finance review", async ({ browser }) => {
  test.setTimeout(300_000);
  const submitter = await signIn(browser, INVENTORY_MANAGER);
  const finance = await signIn(browser, FINANCE);
  const approver = await signIn(browser, APPROVER);
  let receiptId = "";

  await test.step("the inventory manager uploads the receipt and reviews it", async () => {
    const page = await submitter.context.newPage();
    const watch = watchPage(page);
    await page.goto("/receipts/upload");
    await page.locator('input[type="file"]').setInputFiles({ name: "receipt.txt", mimeType: "text/plain", buffer: Buffer.from(`golden path ${stamp}`) });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    // The upload page's own path also ends in one segment, so wait for the receipt's.
    await page.waitForURL((url) => /^\/receipts\/[^/]+$/.test(url.pathname) && url.pathname !== "/receipts/upload");
    receiptId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");
    // The local OCR mock reads every upload as the same purchase, so an earlier upload may flag this one once it is read.
    const read = await untilRead(finance.session, await api<{ id: string; state: string }>(finance.session, `/api/receipts/${encodeURIComponent(receiptId)}`));
    expect([receiptId, read.status]).toEqual([receiptId, 200]);
    if (read.json.state === "duplicate_flagged") {
      expect((await differentPurchases(finance.session, receiptId)).status).toBe(200);
    }

    // The submitter's review: name the retailer and the line as the receipt reads, then confirm.
    await eventually(page, page.getByText("Needs your review", { exact: true }));
    await page.getByLabel("Retailer", { exact: true }).fill(RETAILER);
    await page.getByRole("textbox", { name: / description$/ }).first().fill(LINE);
    // Confirm saves the edits first, then confirms; reloading before it answers would abort the save.
    const confirmed = page.waitForResponse((res) => res.url().endsWith(`/api/receipts/${receiptId}/submitter-confirm`));
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    expect((await confirmed).status()).toBe(200);
    await eventually(page, page.getByText("Receipt finalized", { exact: true }));
    await noProblems(watch, "receipt upload and review");
  });

  await test.step("Part mapping maps its line to a catalog part, which adds it to org stock", async () => {
    const stockBefore = await onHand(submitter.session, catalogGtin);
    const page = await submitter.context.newPage();
    const watch = watchPage(page);
    await page.goto("/inventory/receiving?queue=all");
    await page.getByRole("row").filter({ hasText: RETAILER }).getByRole("link").click();
    // The list shows other receipts' state badges, so read the badge only once the receipt's own page is up.
    await page.waitForURL(/\/inventory\/receiving\/\d+(\?|$)/);
    await expect(page.getByRole("heading", { name: `${RETAILER} · $12.50` })).toBeVisible();
    await expect(page.getByText("Needs mapping", { exact: true })).toBeVisible();

    await line(page).getByRole("button", { name: "Associate" }).click();
    await page.getByPlaceholder("Search the catalog by name, Part ID or category").fill(CATALOG_ITEM);
    await page.getByRole("radio", { name: new RegExp(CATALOG_ITEM) }).click();
    await resolveAndReopen(page, () => page.getByRole("button", { name: "Save", exact: true }).click());
    await expect(page.getByText("Resolved", { exact: true })).toBeVisible();
    // The fixture line is 1 × $12.50 at the default conversion factor of 1.
    expect(await onHand(submitter.session, catalogGtin)).toBe(stockBefore + 1);
    await noProblems(watch, "Part mapping");
  });

  await test.step("FINANCE puts the expense line in the bucket", async () => {
    const page = await finance.context.newPage();
    const watch = watchPage(page);
    await page.goto(`/expense/expenses/${encodeURIComponent(receiptId)}`);
    await lineAct(page, LINE, "Assign bucket");
    const dialog = page.getByRole("dialog");
    // "Always use this bucket for this part" also carries the word, so take the picker by its role.
    await dialog.getByRole("textbox", { name: "Bucket", exact: true }).click();
    await page.getByRole("option", { name: bucketName }).click();
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.goto(`/expense/expenses/${encodeURIComponent(receiptId)}`);
    await expect(line(page).getByText("pending", { exact: true })).toBeVisible();
    await noProblems(watch, "FINANCE assigns the bucket");
  });

  await test.step("the bucket's owner approves the line", async () => {
    const page = await approver.context.newPage();
    const watch = watchPage(page);
    await page.goto(`/programs-i-lead/expense-approvals/${encodeURIComponent(receiptId)}`);
    await lineAct(page, LINE, "Approve as Program approver");
    // The approver's last decision returns them to the list once the page has refetched; a goto before that is aborted by it.
    await page.waitForURL((url) => url.pathname === "/programs-i-lead/expense-approvals");
    await page.goto(`/programs-i-lead/expense-approvals/${encodeURIComponent(receiptId)}`);
    await expect(line(page).getByText("approved", { exact: true })).toBeVisible();
    await noProblems(watch, "the owner approves");
  });

  await test.step("FINANCE signs the line as Treasurer, which completes its sign-off", async () => {
    const page = await finance.context.newPage();
    const watch = watchPage(page);
    await page.goto("/finance/review?queue=to_sign");
    const row = page.getByRole("row").filter({ hasText: RETAILER });
    await row.getByRole("button", { name: "Sign all 1 as Treasurer" }).click();
    await expect(row).toHaveCount(0);
    await noProblems(watch, "FINANCE signs as Treasurer");

    await page.goto(`/expense/expenses/${encodeURIComponent(receiptId)}`);
    await expect(line(page).getByText("✓ Treasurer", { exact: true })).toBeVisible();
    const base = `/api/expense/expenses/${encodeURIComponent(receiptId)}`;
    const signoffs = await api<Array<{ missing: string[] }>>(finance.session, `${base}/signoffs`);
    expect(signoffs.json.map((s) => s.missing)).toEqual([[]]);
    // A fresh seed leaves the capital thresholds unset, so every expense waits at capital review before posting.
    const expense = await api<{ Expense: { state: string } }>(finance.session, base);
    expect(expense.json.Expense.state).toBe("capital_review");
    await noProblems(watch, "the signed expense");
  });

  await test.step("FINANCE sees the approved line in its expense review", async () => {
    const page = await finance.context.newPage();
    const watch = watchPage(page);
    await page.goto("/expense/expenses?view=all&page=1");
    await page.getByRole("row").filter({ hasText: RETAILER }).getByRole("link").first().click();
    await expect(line(page).getByText("approved", { exact: true })).toBeVisible();
    await noProblems(watch, "FINANCE review");
  });

  for (const persona of [submitter, finance, approver]) await persona.context.close();
});

test("a line proposed as a new item resolves against it once the catalog approves it", async ({ browser }) => {
  const retailer = `E2E Proposal ${stamp}`;
  const proposedLine = `Proposed part ${stamp}`;
  const otherLine = `Other part ${stamp}`;
  const itemName = `E2E new item ${stamp}`;
  const manager = await signIn(browser, INVENTORY_MANAGER);
  // A second line keeps the receipt in review, and only a receipt in review takes the catalog's decision.
  const { receivedId } = await inReceiving(manager.session, retailer, [
    { description: proposedLine, quantity: 2, unitPrice: 8 },
    { description: otherLine, quantity: 1, unitPrice: 3 },
  ]);
  const page = await manager.context.newPage();
  const watch = watchPage(page);

  await test.step("the inventory manager proposes the line as a new item", async () => {
    await page.goto(`/inventory/receiving/${receivedId}`);
    await expect(page.getByText("Needs mapping", { exact: true })).toBeVisible();
    await lineRow(page, proposedLine).getByRole("button", { name: "Associate" }).click();
    await page.getByPlaceholder("Search the catalog by name, Part ID or category").fill(itemName);
    await page.getByRole("button", { name: "Propose new item" }).click();
    await page.getByPlaceholder("Proposed name").fill(itemName);
    await page.getByPlaceholder("Category", { exact: true }).click();
    await page.getByRole("option", { name: "N — Electronics" }).click();
    await page.getByPlaceholder("Subcategory", { exact: true }).click();
    await page.getByRole("option", { name: "10 — Control System" }).click();
    await page.getByPlaceholder("Usage behavior").click();
    await page.getByRole("option", { name: "Durable" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(lineRow(page, proposedLine).getByText("Provisional", { exact: true })).toBeVisible();
    await noProblems(watch, "propose a new item");
  });

  await test.step("the inventory manager approves the proposal in the catalog", async () => {
    await page.goto("/catalog/provisional-items");
    const row = page.getByRole("row").filter({ hasText: itemName });
    // The row's actions are Approve, Map to existing item, Reject.
    await row.getByRole("button").nth(0).click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve & Create Item" }).click();
    await expect(row).toHaveCount(0);
    await noProblems(watch, "approve the proposal");
  });

  await test.step("the line is linked to the new item, and the receipt resolves into its stock", async () => {
    const newGtin = await gtinOf(manager.session, itemName);
    await page.goto(`/inventory/receiving/${receivedId}`);
    await expect(lineRow(page, proposedLine).getByText("Recognized", { exact: true })).toBeVisible();
    await expect(lineRow(page, proposedLine)).toContainText(itemName);
    await resolveAndReopen(page, () => lineRow(page, otherLine).getByRole("button", { name: "Not inventory" }).click());
    await expect(page.getByText("Resolved", { exact: true })).toBeVisible();

    const statuses = (await receivedLines(manager.session, receivedId)).map((l) => [l.recognitionStatus, l.assignedGtin13]);
    expect(statuses).toEqual(expect.arrayContaining([["recognized", newGtin], ["non_inventory", null]]));
    expect(await onHand(manager.session, newGtin)).toBe(2);
    await noProblems(watch, "the resolved receipt");
  });

  await manager.context.close();
});
