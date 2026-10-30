/**
 * Org inventory in the browser: a backordered receipt line waits in the receive queue until an
 * inventory manager receives it, which adds it to stock once (docs/rules/inventory.md → On-hand
 * stock). Finance and the Board see the queue; only inventory managers act on it (→ Access).
 */
import { expect, test } from "@playwright/test";
import { api, loginAs, type Session } from "../flow-tests/helpers";
import { watchPage, type PageWatch } from "./support/pageErrors";
import { inReceiving } from "./support/receipts";
import { BOARD, FINANCE, INVENTORY_MANAGER, MEMBER, releaseLibraries, send, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

const MANAGER = INVENTORY_MANAGER;
/** A seeded catalog item (packages/global-catalog/prisma/seed.ts). */
const CATALOG_ITEM = "Roborio v2";
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const undo: Undo[] = [];
let gtin13: string;

test.beforeAll(async () => {
  undo.push(await releaseLibraries());
  const found = await api<Array<{ gtin13: string; name: string }>>(await loginAs(MANAGER), `/api/catalog/items?q=${encodeURIComponent(CATALOG_ITEM)}&limit=20`);
  const item = found.json.find((i) => i.name === CATALOG_ITEM);
  if (!item) throw new Error(`seeded catalog item ${CATALOG_ITEM} not found`);
  gtin13 = item.gtin13;
});
test.afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

async function noProblems(watch: PageWatch, where: string): Promise<void> {
  expect([where, await watch.problems()]).toEqual([where, []]);
}

async function onHand(s: Session): Promise<number> {
  const rows = await api<Array<{ gtin13: string; existingQuantity: number }>>(s, `/api/inventory/org-items?q=${gtin13}&page=1&limit=50`);
  return rows.json.find((r) => r.gtin13 === gtin13)?.existingQuantity ?? 0;
}

/** A receipt whose one backordered line is linked to the catalog item, so it waits in the receive queue. */
async function backordered(manager: Session, retailer: string, quantity: number): Promise<void> {
  const { receivedId } = await inReceiving(manager, retailer, [{ description: `Backordered ${retailer}`, quantity, unitPrice: 10, isDelayed: true }]);
  const detail = await api<{ ReceivedReceiptLineStatus: Array<{ id: number }> }>(manager, `/api/workflow-mapping/receipts/${receivedId}`);
  const [line] = detail.json.ReceivedReceiptLineStatus;
  const linked = await send(manager, "POST", `/api/workflow-mapping/receipts/${receivedId}/lines/${line.id}/associate`, { gtin13, conversionFactor: 1 });
  expect(linked.status).toBe(200);
}

test.describe("org inventory in the browser", () => {
  test("the inventory manager receives a backordered line and it is added to stock once", async ({ browser }) => {
    const retailer = `E2E Backorder ${stamp()}`;
    const manager = await loginAs(MANAGER);
    await backordered(manager, retailer, 3);
    const before = await onHand(manager);

    const { context } = await signIn(browser, MANAGER);
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto("/inventory/receive-queue");
    const row = page.getByRole("row").filter({ hasText: retailer });
    await expect(row).toContainText(CATALOG_ITEM);
    await row.getByRole("button", { name: "Fulfill" }).click();
    await expect(row).toHaveCount(0);
    expect(await onHand(manager)).toBe(before + 3);

    // A received line shows as fulfilled and offers no second receive.
    await page.getByLabel("Show fulfilled and cancelled").check();
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "Fulfill" })).toHaveCount(0);
    await noProblems(watch, "receive queue");

    await page.goto("/inventory/org-items");
    await expect(page.getByRole("row").filter({ hasText: CATALOG_ITEM })).toBeVisible();
    await noProblems(watch, "org items");
    await context.close();
  });

  for (const email of [FINANCE, BOARD]) {
    test(`${email} sees the receive queue but cannot receive or remove a line`, async ({ browser }) => {
      const retailer = `E2E Backorder view ${stamp()}`;
      await backordered(await loginAs(MANAGER), retailer, 1);
      const { context } = await signIn(browser, email);
      const page = await context.newPage();
      const watch = watchPage(page);

      await page.goto("/inventory/receive-queue");
      const row = page.getByRole("row").filter({ hasText: retailer });
      await expect(row).toBeVisible();
      await expect(row.getByRole("button", { name: "Fulfill" })).toHaveCount(0);
      await expect(row.getByRole("button", { name: "Remove" })).toHaveCount(0);
      await noProblems(watch, `${email} receive queue`);
      await context.close();
    });
  }

  test("a plain member does not see the receive queue", async ({ browser }) => {
    const retailer = `E2E Backorder hidden ${stamp()}`;
    await backordered(await loginAs(MANAGER), retailer, 1);
    const { context } = await signIn(browser, MEMBER);
    const page = await context.newPage();
    await page.goto("/inventory/receive-queue");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(retailer)).toHaveCount(0);
    await context.close();
  });

  test("a signed-out visitor is sent away from the inventory pages", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const path of ["/inventory/receive-queue", "/inventory/org-items"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page, path).not.toHaveURL((url) => url.pathname === path);
    }
    await context.close();
  });
});
