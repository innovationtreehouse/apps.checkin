/** Expense detail lines in the browser. */
import { expect, type Locator, type Page } from "@playwright/test";

/** The expense line whose description contains `description`. */
export const lineRow = (page: Page, description: string): Locator => page.getByRole("row").filter({ hasText: description });

/** Takes a line act: the row's main button when it is that act, else the row's More menu. */
export async function lineAct(page: Page, description: string, label: string): Promise<void> {
  const row = lineRow(page, description);
  await expect(row.getByRole("button").first()).toBeVisible();
  // The act buttons draw from the sign-off load, but a click does nothing until the approvals load too.
  await page.waitForLoadState("networkidle");
  const main = row.getByRole("button", { name: label, exact: true });
  if (await main.count()) await main.click();
  else {
    await row.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  }
}
