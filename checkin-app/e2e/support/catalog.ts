/** The global catalog's item form, as the inventory manager fills it on /catalog/items. */
import type { Locator, Page } from "@playwright/test";

/** Seeded by packages/global-catalog/prisma/seed.ts. */
export const SEEDED_ITEM = "Roborio v2";
export const SEEDED_CATEGORY = "N — Electronics";
export const SEEDED_SUBCATEGORY = "10 — Control System";

/** A form field by its label; a required field's label also carries the asterisk. */
export const field = (scope: Locator, label: string) => scope.getByRole("textbox", { name: label, exact: true });

export async function choose(page: Page, scope: Locator, label: string, option: string): Promise<void> {
  await field(scope, label).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** Submits the Add Item form for `name` in the seeded category; a name already taken is refused with a red chip. */
export async function addItem(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Add Item" }).click();
  const dialog = page.getByRole("dialog");
  await field(dialog, "Name").fill(name);
  await choose(page, dialog, "Usage Behavior", "Durable");
  await choose(page, dialog, "Category", SEEDED_CATEGORY);
  await choose(page, dialog, "Subcategory", SEEDED_SUBCATEGORY);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
}
