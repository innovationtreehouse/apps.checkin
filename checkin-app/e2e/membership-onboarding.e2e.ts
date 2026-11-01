/**
 * A family joining, in the browser: the family, the reviewers and the Board each see their part
 * of an application (docs/rules/membership.md). Every test mints its own family, so a rerun on the
 * same stack starts clean. The dev mocks stand in for signing, consent and payment.
 */
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { api, loginAs } from "../flow-tests/helpers";
import { applicationAtIntake, applicationAtPayment, asViewer, newFamily, REVIEWER, review, settledFamily, submittedApplication } from "./support/families";
import { persona } from "./support/kiosk";
import { BOARD, send } from "./support/seedState";
import { signIn } from "./support/session";

const NEEDS_ATTENTION = "Your application needs attention.";
const STILL_REVIEWING = "Your background check is being reviewed in the background";
/** A blocked application carries a red alert for the family and the Board, by design. */
const BLOCKED_ALERT = /blocked|needs attention/i;
const HOUSEHOLD_FILTER = "Filter by household or participant name, email, or ID";

const heading = (page: Page, name: string) => page.getByRole("heading", { name });
const card = (page: Page, text: string): Locator => page.locator(".mantine-Card-root").filter({ hasText: text });
const dialog = (page: Page) => page.getByRole("dialog");

async function membership(page: Page): Promise<void> {
  await page.goto("/membership");
  await expect(heading(page, "Treehouse Membership")).toBeVisible();
}

/**
 * Opens the Board's closed applications. The page keeps whichever list answers last, so an open
 * list still loading when the switch flips would replace the closed one.
 */
async function closedApplications(page: Page): Promise<void> {
  const isOpenList = (request: Request) => new URL(request.url()).pathname === "/api/membership-ops/applications" && !request.url().includes("archived");
  let [started, finished] = [0, 0];
  page.on("request", (request) => { if (isOpenList(request)) started++; });
  page.on("requestfinished", (request) => { if (isOpenList(request)) finished++; });
  await page.goto("/membership-ops/applications");
  await expect.poll(() => started > 0 && finished === started).toBe(true);
  await page.getByText("Show closed applications").click();
}

test.describe("membership onboarding in the browser", () => {
  test("M1: a new family becomes an active member", async ({ browser }) => {
    const email = await newFamily();
    const { name } = await persona(email);

    await asViewer(browser, email, async (page) => {
      await membership(page);
      await page.getByRole("button", { name: "Ask me next time" }).click();
      await expect(heading(page, "Become a member")).toBeVisible();
      await page.getByRole("button", { name: "Start application" }).click();

      await expect(heading(page, "Your household")).toBeVisible();
      await page.getByLabel("Street address").fill("123 Maker Lane");
      await page.getByLabel("City").fill("Austin");
      await page.getByLabel("State").fill("TX");
      await page.getByLabel("ZIP").fill("78701");
      await page.getByLabel("Emergency contact name").fill("Pat Outside");
      await page.getByLabel("Emergency contact phone").fill("555-987-6543");
      await page.getByRole("button", { name: "Submit & continue" }).click();

      await expect(heading(page, "Sign & start your background check")).toBeVisible();
      await page.getByRole("button", { name: "Sign your membership agreement →" }).click();
      await page.getByRole("button", { name: "Complete signing (DEV)" }).click();
      await expect(page.getByText(/^Signed/)).toBeVisible();

      const [averity] = await Promise.all([page.waitForEvent("popup"), page.getByRole("link", { name: "Consent on Averity →" }).click()]);
      await averity.close();
      await page.getByLabel("I submitted my consent on Averity").check();
      await expect(heading(page, "Membership fee")).toBeVisible();
      await expect(page.getByText(STILL_REVIEWING)).toBeVisible();
    });

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/membership-ops/review");
      const application = card(page, email);
      await application.getByRole("radio", { name }).check();
      await application.getByRole("button", { name: "Attest — approve this person" }).click();
      await dialog(page).getByRole("button", { name: "Attest", exact: true }).click();
      await expect(page.getByText("Attestation recorded — thank you.")).toBeVisible();
      await expect(application).toHaveCount(0);
    });

    const family = await loginAs(email);
    const { json } = await api<{ process: { id: number } }>(family, "/api/membership");
    await review(REVIEWER, json.process.id, email);

    await asViewer(browser, email, async (page) => {
      await membership(page);
      await page.getByRole("button", { name: "Ask me next time" }).click();
      await expect(heading(page, "Membership fee")).toBeVisible();
      await expect(page.getByText(STILL_REVIEWING)).toHaveCount(0);

      expect((await send(family, "POST", "/api/dev/shopify/orders-paid", { processId: json.process.id })).status).toBe(200);
      await membership(page);
      await expect(heading(page, "You're a member")).toBeVisible();
      await page.goto("/");
      await expect(page.getByText(/Welcome back/)).toBeVisible();
      await expect(page.getByText("Join the Treehouse")).toHaveCount(0);
      await page.goto("/my-household");
      await expect(page.getByText(/✓ Member/)).toBeVisible();
      await expect(page.getByText("Pat Outside")).toBeVisible();
    });
  });

  test("M2: the Board records signing and consent for a family", async ({ browser }) => {
    const email = await settledFamily();
    await submittedApplication(email);
    const { name } = await persona(email);

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/membership-ops/applications");
      const application = card(page, name);
      await application.getByRole("button", { name: "Confirm contract signed" }).click();
      await expect(application.getByText("✓ Signed")).toBeVisible();
      await application.getByRole("button", { name: "Confirm BG consent" }).click();
      await expect(application.getByText("Awaiting payment.")).toBeVisible();
    }, BLOCKED_ALERT);

    await asViewer(browser, email, async (page) => {
      await membership(page);
      await expect(heading(page, "Membership fee")).toBeVisible();
    });
  });

  test("M3: a rejection blocks, and only the reviewer who rejected can change it", async ({ browser }) => {
    const email = await settledFamily();
    await applicationAtPayment(email);
    const { name } = await persona(email);
    const rejectedList = "Show blocked reviews I rejected";

    await asViewer(browser, REVIEWER, async (page) => {
      await page.goto("/membership-ops/review");
      const application = card(page, email);
      await application.getByLabel("Notes").fill("The report needs a second look.");
      await application.getByRole("button", { name: "Reject" }).click();
      await dialog(page).getByRole("button", { name: "Reject" }).click();
      await expect(page.getByText("Recorded. The board has been notified.")).toBeVisible();
    });

    await asViewer(browser, email, async (page) => {
      await membership(page);
      await expect(page.getByText(NEEDS_ATTENTION)).toBeVisible();
    }, BLOCKED_ALERT);

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/membership-ops/review");
      await page.getByText(rejectedList).click();
      await expect(page.getByText(/no blocked review carries your rejection|You rejected this/).first()).toBeVisible();
      await expect(card(page, name)).toHaveCount(0);
    });

    await asViewer(browser, REVIEWER, async (page) => {
      await page.goto("/membership-ops/review");
      await page.getByText(rejectedList).click();
      await card(page, name).getByRole("button", { name: "Change to approve" }).click();
      await dialog(page).getByRole("radio", { name }).check();
      await dialog(page).getByRole("button", { name: "Change to approve" }).click();
      await expect(page.getByText(/^Your answer is now an approval\./)).toBeVisible();
    });

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/membership-ops/review");
      await expect(card(page, email)).toContainText("1/2 approvals so far.");
      await expect(card(page, email)).toContainText(`This review is for ${name}`);
    });

    await asViewer(browser, email, async (page) => {
      await membership(page);
      await expect(heading(page, "Membership fee")).toBeVisible();
      await expect(page.getByText(NEEDS_ATTENTION)).toHaveCount(0);
    });
  });

  test("M4: a Board reset needs two new approvals", async ({ browser }) => {
    const email = await settledFamily();
    const processId = await applicationAtPayment(email);
    const { name } = await persona(email);
    await review(BOARD, processId, email);
    await review(REVIEWER, processId, email, "REJECT");

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/membership-ops/applications");
      await card(page, name).getByRole("button", { name: "Reset for re-review" }).click();
      await expect(page.getByText("Sent back for re-review.")).toBeVisible();

      await page.goto("/membership-ops/review");
      await expect(card(page, email)).toContainText("0/2 approvals so far.");
      await expect(card(page, email).getByRole("radio", { name })).toBeVisible();
    });

    await review(BOARD, processId, email);
    await asViewer(browser, email, async (page) => {
      await membership(page);
      await expect(heading(page, "Membership fee")).toBeVisible();
      await expect(page.getByText(STILL_REVIEWING)).toBeVisible();

      await review(REVIEWER, processId, email);
      await membership(page);
      await expect(heading(page, "Membership fee")).toBeVisible();
      await expect(page.getByText(STILL_REVIEWING)).toHaveCount(0);
    });
  });

  test("M5: the Board closes an application and reopens it at its step", async ({ browser }) => {
    const email = await settledFamily();
    await applicationAtIntake(email);
    const { name } = await persona(email);

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/membership-ops/applications");
      await card(page, name).getByRole("button", { name: "Close application" }).click();
      await dialog(page).getByRole("button", { name: "Close application" }).click();
      await expect(page.getByText("Application closed.")).toBeVisible();
    }, BLOCKED_ALERT);

    await asViewer(browser, email, async (page) => {
      await membership(page);
      await expect(heading(page, "Become a member")).toBeVisible();
    });

    await asViewer(browser, BOARD, async (page) => {
      await closedApplications(page);
      await card(page, name).getByRole("button", { name: "Reopen" }).click();
      await expect(page.getByText("Application reopened.")).toBeVisible();
    });

    await asViewer(browser, email, async (page) => {
      await membership(page);
      await expect(heading(page, "Your household")).toBeVisible();
      await expect(page.getByLabel("Street address")).toHaveValue("123 Maker Lane");
    });
  });

  test("M6: a payment-plan request reaches the Board, and approving it activates the family", async ({ browser }) => {
    const email = await settledFamily();
    const processId = await applicationAtPayment(email);
    await review(BOARD, processId, email);
    await review(REVIEWER, processId, email);

    await asViewer(browser, email, async (page) => {
      await membership(page);
      await page.getByRole("button", { name: /^Request a scholarship or payment plan/ }).click();
      await dialog(page).getByRole("radio", { name: "Payment plan" }).check();
      await dialog(page).getByRole("button", { name: "Send request" }).click();
      await expect(page.getByText(/^Scholarship or payment plan requested/)).toBeVisible();
    });

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/finance-ops/membership-payment-plan");
      const request = page.getByRole("row").filter({ hasText: email });
      await expect(request).toContainText("Payment plan");
      await request.getByRole("button", { name: "Approve & Activate" }).click();
      await dialog(page).getByLabel("Reason").fill("The plan is agreed with the family.");
      await dialog(page).getByRole("button", { name: "Approve & Activate" }).click();
      await expect(request).toHaveCount(0);
    });

    await asViewer(browser, email, async (page) => {
      await membership(page);
      await expect(heading(page, "You're a member")).toBeVisible();
    });
  });

  test("M7: a denied household is shut out, and a restore closes its application", async ({ browser }) => {
    const email = await settledFamily();
    await submittedApplication(email);
    const { name } = await persona(email);
    const household = (page: Page) => page.getByRole("row").filter({ hasText: name });

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/membership-ops/households");
      await page.getByPlaceholder(HOUSEHOLD_FILTER).fill(name);
      await household(page).getByRole("button", { name: "Deny Membership" }).click();
      await dialog(page).getByRole("button", { name: "Deny Membership" }).click();
      await expect(household(page)).toContainText("Denied");
    });

    // Not through asViewer, which reports the bounce this asserts.
    const denied = await signIn(browser, email);
    const shutOut = await denied.context.newPage();
    await shutOut.goto("/");
    await expect(shutOut).toHaveURL(/\/access-denied$/);
    await expect(heading(shutOut, "Access Denied")).toBeVisible();
    await denied.context.close();

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/membership-ops/households");
      await page.getByPlaceholder(HOUSEHOLD_FILTER).fill(name);
      await household(page).getByRole("button", { name: "Restore Access" }).click();
      await expect(page.getByText("Membership restored.")).toBeVisible();

      await closedApplications(page);
      await expect(card(page, name).getByRole("button", { name: "Reopen" })).toBeVisible();
    });

    await asViewer(browser, email, async (page) => {
      await membership(page);
      await expect(heading(page, "Become a member")).toBeVisible();
    });
  });
});
