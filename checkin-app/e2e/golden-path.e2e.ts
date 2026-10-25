/**
 * The golden path in the browser: the inventory manager uploads a receipt and reviews it, maps
 * its line to a catalog part in Part mapping (the last line resolved applies it), FINANCE puts
 * the expense line in a bucket, the bucket's owner approves it, and FINANCE sees the approved
 * line in its expense review. Every page on the way must show no error.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { lineAct, lineRow } from "./support/expenseLines";
import { watchPage, type PageWatch } from "./support/pageErrors";
import { APPROVER, bucket, FINANCE, INVENTORY_MANAGER, releaseLibraries, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const RETAILER = `E2E Hardware ${stamp}`;
const LINE = `Golden path part ${stamp}`;
/** A seeded catalog item (packages/global-catalog/prisma/seed.ts). */
const CATALOG_ITEM = "Power Distribution Hub";
/** Yesterday, so no time zone makes it future-dated, which would route it to finance review. */
const RECEIPT_DATE = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

const undo: Undo[] = [];
let bucketName: string;

test.beforeAll(async () => {
  undo.push(await releaseLibraries());
  const b = await bucket(`Golden path ${stamp}`, APPROVER);
  bucketName = b.name;
  undo.push(b.undo);
});

test.afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

/** Reloads until `locator` shows, for state a page reads once on load. */
async function eventually(page: Page, locator: Locator): Promise<void> {
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
    await page.getByText("I'll type the details").click();
    await page.getByLabel("Retailer").fill(RETAILER);
    await page.getByLabel("Date", { exact: true }).fill(RECEIPT_DATE);
    await page.getByLabel("Total", { exact: true }).fill("12.34");
    await page.getByLabel("Item 1 description").fill(LINE);
    await page.getByLabel("Item 1 quantity").fill("1");
    await page.getByLabel("Item 1 unit price").fill("12.34");
    await page.getByRole("button", { name: "Upload", exact: true }).click();

    await page.waitForURL(/\/receipts\/[^/]+$/);
    receiptId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");
    await eventually(page, page.getByText("Needs your review", { exact: true }));
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await eventually(page, page.getByText("Receipt finalized", { exact: true }));
    await noProblems(watch, "receipt upload and review");
  });

  await test.step("Part mapping maps its line to a catalog part, which applies it", async () => {
    const page = await submitter.context.newPage();
    const watch = watchPage(page);
    await page.goto("/inventory/receiving?queue=all");
    await page.getByRole("row").filter({ hasText: RETAILER }).getByRole("link").click();
    await expect(page.getByText("Needs mapping", { exact: true })).toBeVisible();

    await line(page).getByRole("button", { name: "Associate" }).click();
    await page.getByPlaceholder("Search the catalog by name, GTIN or category").fill(CATALOG_ITEM);
    await page.getByRole("option", { name: new RegExp(CATALOG_ITEM) }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await eventually(page, page.getByText("Resolved", { exact: true }));
    await noProblems(watch, "Part mapping");
  });

  await test.step("FINANCE puts the expense line in the bucket", async () => {
    const page = await finance.context.newPage();
    const watch = watchPage(page);
    await page.goto(`/expense/expenses/${encodeURIComponent(receiptId)}`);
    await lineAct(page, LINE, "Assign bucket");
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Bucket").click();
    await page.getByRole("option", { name: bucketName }).click();
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog).toBeHidden();
    // A decision with nothing left for FINANCE returns to the list, so read the line afresh.
    await page.goto(`/expense/expenses/${encodeURIComponent(receiptId)}`);
    await expect(line(page).getByText("pending", { exact: true })).toBeVisible();
    await noProblems(watch, "FINANCE assigns the bucket");
  });

  await test.step("the bucket's owner approves the line", async () => {
    const page = await approver.context.newPage();
    const watch = watchPage(page);
    await page.goto(`/programs-i-lead/expense-approvals/${encodeURIComponent(receiptId)}`);
    await lineAct(page, LINE, "Approve as bucket approver");
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.goto(`/programs-i-lead/expense-approvals/${encodeURIComponent(receiptId)}`);
    await expect(line(page).getByText("approved", { exact: true })).toBeVisible();
    await noProblems(watch, "the owner approves");
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
