/**
 * Finance review in the browser: FINANCE and the Board open every tab of /finance/review, the
 * receipt tabs (the "More" states included), the expense tabs and the Board tab, and each must
 * show no error (support/pageErrors). The tab list is read off the page itself.
 */
import { expect, test, type Page } from "@playwright/test";
import { watchPage } from "./support/pageErrors";
import { BOARD, FINANCE, MEMBER, releaseLibraries, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

const undo: Undo[] = [];
test.beforeAll(async () => {
  undo.push(await releaseLibraries());
});
test.afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

/** The tab buttons in the Receipts, Expenses and Board rows. */
const tabButtons = (page: Page) => page.locator("button[aria-pressed]");
/** The "More" picker's input; its listbox carries the same label. */
const moreStates = (page: Page) => page.getByRole("textbox", { name: "More receipt states" });

async function settled(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
}

for (const email of [FINANCE, BOARD]) {
  test(`${email} opens every Finance review tab without an error`, async ({ browser }) => {
    const { context } = await signIn(browser, email);
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto("/finance/review");
    await expect(page.getByRole("heading", { name: "Finance review" })).toBeVisible();
    await settled(page);

    const labels = (await tabButtons(page).allInnerTexts()).map((t) => t.replace(/\s*\d+\s*$/, "").trim());
    expect(labels).toEqual(expect.arrayContaining(["Expenses", "To sign", "Account holds", "QuickBooks", "Board"]));
    const failures: string[] = [];
    for (const [i, label] of labels.entries()) {
      await test.step(label, async () => {
        await tabButtons(page).nth(i).click();
        await expect(tabButtons(page).nth(i)).toHaveAttribute("aria-pressed", "true");
        await settled(page);
        failures.push(...(await watch.problems()).map((p) => `${label}: ${p}`));
      });
    }

    await moreStates(page).click();
    const options = await page.getByRole("option").allInnerTexts();
    await page.keyboard.press("Escape");
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      const name = option.replace(/\s*\d+\s*$/, "").trim();
      await test.step(`More › ${name}`, async () => {
        await moreStates(page).click();
        await page.getByRole("option").filter({ hasText: name }).first().click();
        await settled(page);
        failures.push(...(await watch.problems()).map((p) => `More › ${name}: ${p}`));
      });
    }
    await context.close();
    expect(failures).toEqual([]);
  });
}

test("a plain member is sent away from Finance review", async ({ browser }) => {
  const { context } = await signIn(browser, MEMBER);
  const page = await context.newPage();
  await page.goto("/finance/review");
  // The Finance section's role gate sends a viewer it refuses to the home page.
  await expect(page).toHaveURL((url) => url.pathname === "/");
  await expect(page.getByRole("heading", { name: "Finance review" })).toHaveCount(0);
  await context.close();
});
