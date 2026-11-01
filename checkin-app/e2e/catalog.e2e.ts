/**
 * The global catalog in the browser. The catalog audience reads it; only inventory managers
 * write it (docs/rules/inventory.md → Access). Errors are red chips that stay until dismissed.
 * Every page must show no error beyond the one a test provokes (support/pageErrors).
 */
import { expect, test, type Page } from "@playwright/test";
import { api, loginAs, type Session } from "../flow-tests/helpers";
import { addItem, field, SEEDED_CATEGORY, SEEDED_ITEM } from "./support/catalog";
import { watchPage, type PageWatch } from "./support/pageErrors";
import { inReceiving } from "./support/receipts";
import { FINANCE, INVENTORY_MANAGER, releaseLibraries, send, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

const MANAGER = INVENTORY_MANAGER;
/** Longer than Mantine's default auto-close, so a chip that closes itself is gone by then. */
const CHIP_STAYS_MS = 6_000;
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

const itemRow = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });

/** A letter no category holds, archived ones included: a category keeps its letter for good. */
async function freeLetter(manager: Session): Promise<string> {
  const categories = await api<Array<{ letter: string }>>(manager, "/api/catalog/categories?includeArchived=true");
  const taken = new Set(categories.json.map((c) => c.letter));
  const letter = [..."ZYXWVUTSRQPONMLKJIHGFEDCBA"].find((l) => !taken.has(l));
  if (!letter) throw new Error("every category letter is taken; reseed the stack");
  return letter;
}

/** Archives the category named `name`, which is as far as a category can be removed. */
const archiveCategory = (manager: Session, name: string): Undo => async () => {
  const categories = await api<Array<{ id: number; name: string }>>(manager, "/api/catalog/categories");
  const created = categories.json.find((c) => c.name === name);
  if (created) expect((await send(manager, "POST", `/api/catalog/categories/${created.id}/archive`)).status).toBe(200);
};

/** A pending provisional-item proposal, made by proposing a receipt line as a new item in Receiving. */
async function proposal(manager: Session, proposedName: string): Promise<void> {
  const categories = await api<Array<{ id: number; letter: string }>>(manager, "/api/catalog/categories");
  const category = categories.json.find((c) => c.letter === "N");
  const subcategories = await api<Array<{ id: number; categoryId: number; number: number }>>(manager, "/api/catalog/subcategories");
  const subcategory = subcategories.json.find((s) => s.categoryId === category?.id && s.number === 10);
  if (!category || !subcategory) throw new Error("seeded category N/10 not found");
  const { receivedId } = await inReceiving(manager, `E2E Catalog proposal ${stamp()}`, [{ description: proposedName, quantity: 1, unitPrice: 6 }]);
  const detail = await api<{ ReceivedReceiptLineStatus: Array<{ id: number }> }>(manager, `/api/workflow-mapping/receipts/${receivedId}`);
  const [line] = detail.json.ReceivedReceiptLineStatus;
  const proposed = await send(manager, "POST", `/api/workflow-mapping/receipts/${receivedId}/lines/${line.id}/propose`, {
    proposedName,
    proposedCategoryId: category.id,
    proposedSubcategoryId: subcategory.id,
    proposedUsageBehavior: "Durable",
    conversionFactor: 1,
  });
  expect(proposed.status).toBe(200);
}

test.describe("the catalog in the browser", () => {
  test("the inventory manager adds an item, archives it and restores it", async ({ browser }) => {
    const name = `E2E item ${stamp()}`;
    const { context } = await signIn(browser, MANAGER);
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto("/catalog/items");
    await addItem(page, name);
    await page.getByLabel("Search items").fill(name);
    await expect(itemRow(page, name)).toBeVisible();

    // The row's actions are View references, Edit, Archive.
    await itemRow(page, name).getByRole("button").nth(2).click();
    await page.getByRole("dialog").getByRole("button", { name: "Archive", exact: true }).click();
    await expect(itemRow(page, name)).toHaveCount(0);
    await page.getByLabel("Show archived parts").check();
    await expect(itemRow(page, name).getByText("Archived", { exact: true })).toBeVisible();
    // An archived row's actions are View references, Edit, Unarchive.
    await itemRow(page, name).getByRole("button").nth(2).click();
    await expect(itemRow(page, name).getByText("Archived", { exact: true })).toHaveCount(0);
    await noProblems(watch, "add, archive and restore an item");
    await context.close();
  });

  test("a duplicate item name is refused with an error chip that stays", async ({ browser }) => {
    const { context } = await signIn(browser, MANAGER);
    const page = await context.newPage();
    await page.goto("/catalog/items");
    await addItem(page, SEEDED_ITEM);
    const chip = page.locator(".mantine-Notification-root").filter({ hasText: "already exists" });
    await expect(chip).toBeVisible();
    await page.waitForTimeout(CHIP_STAYS_MS);
    await expect(chip).toBeVisible();
    await context.close();
  });

  test("the inventory manager adds a category", async ({ browser }) => {
    const name = `E2E category ${stamp()}`;
    const { context, session } = await signIn(browser, MANAGER);
    const letter = await freeLetter(session);
    undo.push(archiveCategory(session, name));
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto("/catalog/categories");
    await page.getByRole("button", { name: "Add", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await field(dialog, "Name").fill(name);
    await field(dialog, "Letter (A–Z)").fill(letter);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText(`${letter} — ${name}`)).toBeVisible();
    await noProblems(watch, "add a category");
    await context.close();
  });

  test("the inventory manager approves a proposed item into the catalog", async ({ browser }) => {
    const name = `E2E proposed ${stamp()}`;
    await proposal(await loginAs(MANAGER), name);
    const { context } = await signIn(browser, MANAGER);
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto("/catalog/proposals");
    await page.getByRole("tab", { name: "Provisional Items" }).click();
    // The row's actions are Approve, Map to existing item, Reject.
    await itemRow(page, name).getByRole("button").nth(0).click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve & Create Item" }).click();
    await expect(itemRow(page, name)).toHaveCount(0);

    await page.goto("/catalog/items");
    await page.getByLabel("Search items").fill(name);
    await expect(itemRow(page, name)).toBeVisible();
    await noProblems(watch, "approve a proposal");
    await context.close();
  });

  test("rejecting a proposed item needs a reason", async ({ browser }) => {
    const name = `E2E rejected ${stamp()}`;
    await proposal(await loginAs(MANAGER), name);
    const { context } = await signIn(browser, MANAGER);
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto("/catalog/proposals");
    await page.getByRole("tab", { name: "Provisional Items" }).click();
    await itemRow(page, name).getByRole("button").nth(2).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Reject", exact: true })).toBeDisabled();
    await dialog.getByLabel("Reason").fill("E2E: not a real part");
    await dialog.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(itemRow(page, name)).toHaveCount(0);
    await noProblems(watch, "reject a proposal");
    await context.close();
  });

  test("a catalog reader sees items and categories but cannot change them", async ({ browser }) => {
    const { context } = await signIn(browser, FINANCE);
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto("/catalog/items");
    await page.getByLabel("Search items").fill(SEEDED_ITEM);
    await expect(itemRow(page, SEEDED_ITEM)).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Item" })).toHaveCount(0);
    await expect(itemRow(page, SEEDED_ITEM).getByRole("button")).toHaveCount(0);
    await page.goto("/catalog/categories");
    await expect(page.getByText(SEEDED_CATEGORY)).toBeVisible();
    await expect(page.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
    await noProblems(watch, "catalog reader");
    await context.close();
  });

  test("a signed-out visitor is sent away from the catalog", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const path of ["/catalog/items", "/catalog/categories", "/catalog/proposals"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page, path).not.toHaveURL((url) => url.pathname === path);
    }
    await context.close();
  });
});
