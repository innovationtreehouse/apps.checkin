/**
 * A person merge carrying a valid background check onto a family whose application is in review
 * (docs/rules/membership.md, the person-merge ruling of 2026-10-30). The check comes from a second
 * family cleared by two reviewers; the Board merges that family's lead into the applicant's. The
 * carryover counts only under a set re-check interval, which the fresh seed leaves unset, so the
 * suite sets one and puts it back in afterAll. Every test mints its own families, so a rerun on the
 * same stack starts clean.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { api, loginAs } from "../flow-tests/helpers";
import { applicationAtPayment, asViewer, checkReviewOf, REVIEWER, review, settledFamily } from "./support/families";
import { persona } from "./support/kiosk";
import { BOARD, send } from "./support/seedState";

const STILL_REVIEWING = "Your background check is being reviewed in the background";
const NEEDS_ATTENTION = "Your application needs attention.";
/** A blocked application carries a red alert for the family, by design. */
const BLOCKED_ALERT = /blocked|needs attention/i;
const RECHECK_MONTHS = 24;
/** Whether a Board reset refuses the merge itself is open, so either answer passes. */
const MERGE_REFUSED = /merge/i;

type Settings = { settings: { BoardSettings: { bgRecheckMonths: number } } };
type Application = { id: number; status: string; bgClearedAt: string | null };

let originalRecheckMonths = 0;

const setRecheckMonths = async (months: number) => {
  const saved = await send(await loginAs(BOARD), "PUT", "/api/settings/membership", { perYearVariantClient: true, bgRecheckMonths: months });
  if (saved.status !== 200) throw new Error(`set re-check interval: ${saved.status}`);
};

const heading = (page: Page, name: string) => page.getByRole("heading", { name });
const card = (page: Page, text: string): Locator => page.locator(".mantine-Card-root").filter({ hasText: text });

async function membership(page: Page): Promise<void> {
  await page.goto("/membership");
  await expect(heading(page, "Treehouse Membership")).toBeVisible();
}

/** A family whose lead two reviewers cleared, so the lead holds a valid check; returns its email. */
async function clearedFamily(): Promise<string> {
  const email = await settledFamily();
  const processId = await applicationAtPayment(email);
  await review(BOARD, processId, email);
  await review(REVIEWER, processId, email);
  return email;
}

/** The Board's view of one application. */
async function application(processId: number): Promise<Application> {
  const { json } = await api<{ processes: Application[] }>(await loginAs(BOARD), "/api/membership-ops/applications");
  const found = json.processes.find((p) => p.id === processId);
  if (!found) throw new Error(`application ${processId} not in the Board's list`);
  return found;
}

async function pickPerson(page: Page, label: string, id: number): Promise<void> {
  await page.getByLabel(label).fill(String(id));
  await page.getByText(`(ID: ${id})`, { exact: true }).click();
}

/**
 * The Board asks to merge `mergedEmail`'s lead into `keptEmail`'s, the preview naming the
 * carried-in check, and waits for the answer without judging it.
 */
async function requestMerge(page: Page, keptEmail: string, mergedEmail: string): Promise<void> {
  const kept = await persona(keptEmail);
  const merged = await persona(mergedEmail);
  await page.goto("/membership-ops/participants/merge");
  await pickPerson(page, "Participant 1", kept.id);
  await pickPerson(page, "Participant 2", merged.id);
  await expect(card(page, "Keep and augment")).toContainText(`(ID: ${kept.id})`);
  await page.getByRole("button", { name: "Proceed to Preview" }).click();

  const notice = page.locator(".mantine-Alert-root").filter({ hasText: "Background-check date will change" });
  await expect(notice).toBeVisible();
  const answered = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/membership-ops/participants/merge");
  await page.getByRole("button", { name: "Confirm Merge & Delete" }).click();
  await answered;
}

/** The Board merges `mergedEmail`'s lead into `keptEmail`'s. */
async function mergeInCheck(page: Page, keptEmail: string, mergedEmail: string): Promise<void> {
  await requestMerge(page, keptEmail, mergedEmail);
  await expect(heading(page, "Merge Successful!")).toBeVisible();
}

test.describe("person merge carrying a background check", () => {
  test.beforeAll(async () => {
    const { json } = await api<Settings>(await loginAs(BOARD), "/api/settings/membership");
    originalRecheckMonths = json.settings.BoardSettings.bgRecheckMonths;
    await setRecheckMonths(RECHECK_MONTHS);
  });

  test.afterAll(async () => {
    await setRecheckMonths(originalRecheckMonths);
  });

  test("P1: a merged-in check clears an application with approvals only", async ({ browser }) => {
    const source = await clearedFamily();
    const email = await settledFamily();
    const processId = await applicationAtPayment(email);
    await review(BOARD, processId, email);

    await asViewer(browser, BOARD, (page) => mergeInCheck(page, email, source));

    await asViewer(browser, email, async (page) => {
      await membership(page);
      await expect(heading(page, "Membership fee")).toBeVisible();
      await expect(page.getByText(STILL_REVIEWING)).toHaveCount(0);
    });
    expect((await application(processId)).bgClearedAt).not.toBeNull();
  });

  test("P2: a standing rejection refuses a merge that would carry in a check", async ({ browser }) => {
    const source = await clearedFamily();
    const email = await settledFamily();
    const processId = await applicationAtPayment(email);
    await review(BOARD, processId, email);
    const reviewId = await checkReviewOf(processId);
    await review(REVIEWER, processId, email, "REJECT");
    const [kept, merged] = [await persona(email), await persona(source)];

    const refusal = `Cannot merge: this person's background check is disputed by review #${reviewId}`;
    await asViewer(browser, BOARD, async (page) => {
      await requestMerge(page, email, source);
      await expect(page.locator(".mantine-Alert-root").filter({ hasText: refusal })).toBeVisible();
      await expect(heading(page, "Merge Successful!")).toHaveCount(0);
    }, new RegExp(`^error alert: ${refusal}\\b`));

    expect([await persona(email), await persona(source)]).toEqual([kept, merged]);
    await asViewer(browser, email, async (page) => {
      await membership(page);
      await expect(page.getByText(NEEDS_ATTENTION)).toBeVisible();
    }, BLOCKED_ALERT);
    const after = await application(processId);
    expect(after.status).toBe("BLOCKED");
    expect(after.bgClearedAt).toBeNull();
  });

  test("P3: after a Board reset a merged-in check does not stand in for the two new approvals", async ({ browser }) => {
    const source = await clearedFamily();
    const email = await settledFamily();
    const processId = await applicationAtPayment(email);
    await review(BOARD, processId, email);
    const reviewId = await checkReviewOf(processId);
    await review(REVIEWER, processId, email, "REJECT");
    expect((await send(await loginAs(BOARD), "POST", "/api/membership-ops/applications/review-override", { processId: reviewId, action: "reset", reason: "A second look." })).status).toBe(200);
    await review(BOARD, processId, email);

    await asViewer(browser, BOARD, (page) => requestMerge(page, email, source), MERGE_REFUSED);

    const lead = await persona(email);
    await asViewer(browser, REVIEWER, async (page) => {
      await page.goto("/membership-ops/review");
      await expect(card(page, `Background check for ${lead.name}`)).toContainText("1/2 approvals so far.");
    });

    await asViewer(browser, email, async (page) => {
      await membership(page);
      await expect(heading(page, "Membership fee")).toBeVisible();
      await expect(page.getByText(STILL_REVIEWING)).toBeVisible();
    });
    expect((await application(processId)).bgClearedAt).toBeNull();
  });

  // Owner ruling A (2026-11-08): a rejection changed to approve stays disputed until two
  // new approvals, including after the change is undone, so the merge is refused.
  test("P4: a rejection changed to approve and then undone still stands, so a merge is refused", async ({ browser }) => {
    const source = await clearedFamily();
    const email = await settledFamily();
    const processId = await applicationAtPayment(email);
    const reviewId = await checkReviewOf(processId);
    await review(REVIEWER, processId, email, "REJECT");
    await review(REVIEWER, processId, email);
    const undone = await send(await loginAs(REVIEWER), "POST", "/api/membership/reviews/undo", { processId: reviewId, reason: "Approved the wrong family." });
    expect(undone.status).toBe(200);

    await asViewer(browser, BOARD, (page) => requestMerge(page, email, source), MERGE_REFUSED);

    expect((await application(processId)).bgClearedAt).toBeNull();
  });
});
