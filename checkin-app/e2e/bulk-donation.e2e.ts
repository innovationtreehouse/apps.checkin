/**
 * Donations (giving-platform batches) in the browser. Finance and the Board see donations and
 * finance manages them (docs/rules/revenue.md → Donations). A batch is finished only once every
 * gift has a place in the books, so a gift with no matching account rule holds its batch until
 * the rule exists and the batch is resubmitted. Errors are red chips that stay until dismissed.
 */
import { expect, test, type Page } from "@playwright/test";
import { watchPage, type PageWatch } from "./support/pageErrors";
import { BOARD, FINANCE, MEMBER, releaseLibraries, type Undo } from "./support/seedState";
import { signIn } from "./support/session";

const HEADER =
  "Company Name,Corporate / Peer Campaign,Disbursement ID,Disbursement Date,Transaction ID,Donation Date,Donation Amount,Match Amount,Merchant Fee,Donor First Name,Donor Last Name,Donor Comment";
/** A bucket in the seed (checkin-app/prisma/seed). */
const SEEDED_BUCKET = "Facility";
/** Longer than Mantine's default auto-close, so a chip that closes itself is gone by then. */
const CHIP_STAYS_MS = 6_000;

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

interface Batch { company: string; disbursement: string; comment: string; name: string; csv: string }

/** A two-gift batch: one with no comment (general money), one whose comment needs an owner. */
function batch(): Batch {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const company = `E2E Co ${stamp}`;
  const disbursement = `E2E-${stamp}`;
  const comment = `robotics ${stamp}`;
  const csv = [
    HEADER,
    `${company},Spring,${disbursement},2026-09-10,${stamp}-1,2026-09-01,40.00,40.00,1.00,Org,Level,`,
    `${company},Spring,${disbursement},2026-09-10,${stamp}-2,2026-09-02,60.00,0,1.50,Rosa,Parks,${comment}`,
  ].join("\n");
  return { company, disbursement, comment, name: `e2e-${stamp}.csv`, csv };
}

async function uploadCsv(page: Page, name: string, csv: string): Promise<void> {
  await page.goto("/donations/uploads");
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
}

const row = (page: Page, text: string) => page.getByRole("row").filter({ hasText: text });

test.describe("donations in the browser", () => {
  test("FINANCE imports a batch, places its gift, and clears the batch's hold", async ({ browser }) => {
    const b = batch();
    const { context } = await signIn(browser, FINANCE);
    const page = await context.newPage();
    const watch = watchPage(page);

    await uploadCsv(page, b.name, b.csv);
    await expect(row(page, b.name).getByRole("cell")).toHaveText([/.+/, b.name, "2", "2", "0", /.*/]);

    await page.goto("/donations/transactions");
    await expect(row(page, "Rosa Parks").filter({ hasText: b.company })).toContainText("$60.00");

    await page.goto("/donations/unassigned");
    const waiting = row(page, b.comment);
    await waiting.getByPlaceholder("Owner").click();
    await page.getByRole("option", { name: SEEDED_BUCKET, exact: true }).click();
    await waiting.getByRole("button", { name: "Assign", exact: true }).click();
    await expect(waiting).toHaveCount(0);

    await page.goto("/donations/holds");
    await expect(page.getByText(`Disbursement ${b.disbursement}`)).toBeVisible();

    await page.goto("/donations/account-map");
    await page.getByRole("button", { name: "Add rule" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Company (* for any)").fill(b.company);
    await dialog.getByLabel("Campaign (* for any)").fill("*");
    await dialog.getByLabel("Donation account").fill("Contributions:Corporate Giving");
    await dialog.getByLabel("Match account").fill("Contributions:Corporate Match");
    await dialog.getByLabel("Fees account").fill("Fees:Merchant");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row(page, b.company)).toBeVisible();

    await page.goto("/donations/holds");
    const hold = page.getByText(`Disbursement ${b.disbursement}`);
    await page.locator(".mantine-Paper-root").filter({ has: hold }).getByRole("button", { name: "Resubmit" }).click();
    await expect(hold).toHaveCount(0);
    await noProblems(watch, "import, place and clear a batch");
    await context.close();
  });

  test("re-uploading the same file adds nothing", async ({ browser }) => {
    const b = batch();
    const { context } = await signIn(browser, FINANCE);
    const page = await context.newPage();
    const watch = watchPage(page);

    await uploadCsv(page, b.name, b.csv);
    await expect(row(page, b.name)).toBeVisible();
    const again = `again-${b.name}`;
    await uploadCsv(page, again, b.csv);
    await expect(row(page, again).getByRole("cell")).toHaveText([/.+/, again, "2", "0", "2", /.*/]);
    await noProblems(watch, "duplicate upload");
    await context.close();
  });

  test("a file that is not a giving-platform CSV is refused with an error chip that stays", async ({ browser }) => {
    const { context } = await signIn(browser, FINANCE);
    const page = await context.newPage();
    await uploadCsv(page, "not-benevity.csv", "this,is,not\na,benevity,report");
    const chip = page.locator('.mantine-Notification-root[style*="--mantine-color-red"]');
    await expect(chip).toBeVisible();
    await page.waitForTimeout(CHIP_STAYS_MS);
    await expect(chip).toBeVisible();
    await context.close();
  });

  test("the Board sees donations but cannot manage them", async ({ browser }) => {
    const { context } = await signIn(browser, BOARD);
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto("/donations/uploads");
    await expect(page.getByRole("heading", { name: "Benevity uploads" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload", exact: true })).toHaveCount(0);
    await page.goto("/donations/account-map");
    await expect(page.getByRole("heading", { name: "Account map" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add rule" })).toHaveCount(0);
    await page.goto("/donations/unassigned");
    await expect(page.getByRole("button", { name: "Assign", exact: true })).toHaveCount(0);
    await noProblems(watch, "Board views donations");
    await context.close();
  });

  test("a plain member is sent away from donations", async ({ browser }) => {
    const { context } = await signIn(browser, MEMBER);
    const page = await context.newPage();
    await page.goto("/donations/uploads");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Benevity uploads" })).toHaveCount(0);
    await context.close();
  });

  test("a signed-out visitor is sent away from donations", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const path of ["/donations/uploads", "/donations/transactions"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page, path).not.toHaveURL((url) => url.pathname === path);
    }
    await context.close();
  });
});
