/**
 * Part mapping in the browser: a confirmed receipt waits here until each line is
 * linked to a catalog item, proposed as a new one, or marked not inventory
 * (docs/rules/inventory.md → Receiving). Only inventory managers act on it; finance and the
 * Board only see it, and nobody else reaches it (→ Access).
 */
import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "../flow-tests/helpers";
import { watchPage, type PageWatch } from "./support/pageErrors";
import { inReceiving } from "./support/receipts";
import { BOARD, FINANCE, INVENTORY_MANAGER, MEMBER, releaseLibraries, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

const MANAGER = INVENTORY_MANAGER;
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

const lineRow = (page: Page, description: string) => page.getByRole("row").filter({ hasText: description });

async function openAsManager(browser: Parameters<typeof signIn>[0], receivedId: number) {
  const { context } = await signIn(browser, MANAGER);
  const page = await context.newPage();
  const watch = watchPage(page);
  await page.goto(`/inventory/receiving/${receivedId}`);
  await expect(page.getByText("Needs mapping", { exact: true })).toBeVisible();
  return { context, page, watch };
}

test.describe("Part mapping in the browser", () => {
  test("a receipt's total and lines read right in the list and on the receipt", async ({ browser }) => {
    const retailer = `E2E Part mapping money ${stamp()}`;
    const { receivedId: id } = await inReceiving(await loginAs(MANAGER), retailer, [{ description: "Money part", quantity: 2, unitPrice: 61.73 }]);
    const { context } = await signIn(browser, MANAGER);
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto("/inventory/receiving?queue=all");
    const row = page.getByRole("row").filter({ hasText: retailer });
    await expect(row).toContainText("$123.46");
    await row.getByRole("link").click();
    await page.waitForURL(new RegExp(`/inventory/receiving/${id}(\\?|$)`));
    await expect(page.getByRole("heading", { name: `${retailer} · $123.46` })).toBeVisible();
    await expect(lineRow(page, "Money part").getByRole("cell").nth(3)).toHaveText("2");
    await expect(page.getByText(/NaN|undefined/)).toHaveCount(0);
    await noProblems(watch, "Part mapping list and receipt");
    await context.close();
  });

  test("the catalog search finds a partial name typed in any case", async ({ browser }) => {
    const line = `E2E search line ${stamp()}`;
    const { receivedId: id } = await inReceiving(await loginAs(MANAGER), `E2E Part mapping search ${stamp()}`, [{ description: line, quantity: 1, unitPrice: 4 }]);
    const { context, page, watch } = await openAsManager(browser, id);

    await lineRow(page, line).getByRole("button", { name: "Associate" }).click();
    await page.getByPlaceholder("Search the catalog by name, GTIN or category").fill("dISTRIBUTION h");
    await expect(page.getByRole("option", { name: /Power Distribution Hub/ })).toBeVisible();
    await noProblems(watch, "catalog search");
    await context.close();
  });

  test("marking the only line not inventory resolves the receipt", async ({ browser }) => {
    const line = `E2E not inventory ${stamp()}`;
    const { receivedId: id } = await inReceiving(await loginAs(MANAGER), `E2E Part mapping non-inv ${stamp()}`, [{ description: line, quantity: 1, unitPrice: 7 }]);
    const { context, page, watch } = await openAsManager(browser, id);

    await lineRow(page, line).getByRole("button", { name: "Not inventory" }).click();
    await expect(page.getByText("Resolved", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Resolved", { exact: true })).toBeVisible();
    await noProblems(watch, "not inventory");
    await context.close();
  });

  test("proposing the only line as a new item resolves the receipt", async ({ browser }) => {
    const line = `E2E proposed ${stamp()}`;
    const { receivedId: id } = await inReceiving(await loginAs(MANAGER), `E2E Part mapping propose ${stamp()}`, [{ description: line, quantity: 1, unitPrice: 8 }]);
    const { context, page, watch } = await openAsManager(browser, id);

    await lineRow(page, line).getByRole("button", { name: "Propose" }).click();
    await page.getByPlaceholder("Proposed name").fill(`E2E proposed item ${stamp()}`);
    await page.getByPlaceholder("Category", { exact: true }).click();
    await page.getByRole("option", { name: "N — Electronics" }).click();
    await page.getByPlaceholder("Subcategory", { exact: true }).click();
    await page.getByRole("option", { name: "10 — Control System" }).click();
    await page.getByPlaceholder("Usage behavior").click();
    await page.getByRole("option", { name: "Durable" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Resolved", { exact: true })).toBeVisible();
    await noProblems(watch, "propose");
    await context.close();
  });

  for (const email of [FINANCE, BOARD]) {
    test(`${email} sees a receipt in Part mapping but cannot act on it`, async ({ browser }) => {
      const line = `E2E view only ${stamp()}`;
      const { receivedId: id } = await inReceiving(await loginAs(MANAGER), `E2E Part mapping view ${stamp()}`, [{ description: line, quantity: 1, unitPrice: 2 }]);
      const { context } = await signIn(browser, email);
      const page = await context.newPage();
      const watch = watchPage(page);

      await page.goto(`/inventory/receiving/${id}`);
      await expect(lineRow(page, line)).toBeVisible();
      for (const action of ["Associate", "Propose", "Not inventory", "Proceed"]) {
        await expect(page.getByRole("button", { name: action, exact: true }), action).toHaveCount(0);
      }
      await noProblems(watch, `${email} views Part mapping`);
      await context.close();
    });
  }

  test("the inventory manager opens the Part mapping audit log", async ({ browser }) => {
    const { context } = await signIn(browser, MANAGER);
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto("/inventory/receiving/audit-log");
    await expect(page.getByRole("heading", { name: "Part mapping audit log" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await noProblems(watch, "audit log");
    await context.close();
  });

  test("a plain member is sent away from Part mapping", async ({ browser }) => {
    const { context } = await signIn(browser, MEMBER);
    const page = await context.newPage();
    await page.goto("/inventory/receiving");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Part mapping", exact: true })).toHaveCount(0);
    await context.close();
  });

  test("a signed-out visitor is sent away from Part mapping", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const path of ["/inventory/receiving", "/inventory/receiving/audit-log"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page, path).not.toHaveURL((url) => url.pathname === path);
    }
    await context.close();
  });
});
