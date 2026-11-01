/**
 * A household lead running a household on /my-household, and what the people added to it may do
 * (docs/rules/people-households.md). Every test mints its own family.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAs } from "../flow-tests/helpers";
import { asViewer, settledFamily } from "./support/families";
import { persona } from "./support/kiosk";
import { send } from "./support/seedState";

const KEYHOLDER = "keyholder1@example.com";
const YOUTH_AGE = 10;
const BOARD_ONLY_EMAIL = "can only be changed by the board";

const uniqueEmail = (label: string) => `${label}+${Date.now()}@example.com`;

function youthBirthDate(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() - YOUTH_AGE);
  return date.toISOString().slice(0, 10);
}

async function myHousehold(page: Page): Promise<void> {
  await page.goto("/my-household");
  await expect(page.getByRole("heading", { name: "Household Members" })).toBeVisible();
}

const memberCard = (page: Page, name: string): Locator => page.locator(".mantine-SimpleGrid-root > .mantine-Card-root").filter({ hasText: name });

test.describe("household lead in the browser", () => {
  test("H1: the lead adds an adult and a youth", async ({ browser }) => {
    const email = await settledFamily();
    const [adult, youth] = [`Added Adult ${Date.now()}`, `Added Youth ${Date.now()}`];

    await asViewer(browser, email, async (page) => {
      await myHousehold(page);

      await page.getByRole("button", { name: "+ Add Household Member" }).click();
      await page.getByLabel("Full Name").fill(adult);
      await page.getByLabel("Email (Optional)").fill(uniqueEmail("added.adult"));
      await page.getByLabel("Individual is over 25").check();
      await page.getByRole("button", { name: "Save / Invite" }).click();
      await expect(memberCard(page, adult)).toContainText("Adult");

      await page.getByRole("button", { name: "+ Add Household Member" }).click();
      await page.getByLabel("Full Name").fill(youth);
      await page.getByLabel("Date of Birth").fill(youthBirthDate());
      await page.getByRole("button", { name: "Save / Invite" }).click();
      await expect(memberCard(page, youth)).toContainText(`Age (${YOUTH_AGE})`);
    });
  });

  test("H2: the lead's address, emergency contact and allergies persist", async ({ browser }) => {
    const email = await settledFamily();
    const { name } = await persona(email);

    await asViewer(browser, email, async (page) => {
      await myHousehold(page);
      await page.getByLabel("Street Address").fill("500 Workshop Way");
      await page.getByLabel("City").fill("Austin");
      await page.getByLabel("State").fill("TX");
      await page.getByLabel("ZIP").fill("78702");
      await page.getByRole("button", { name: "Save household details" }).click();
      await expect(page.getByText("Settings updated successfully!")).toBeVisible();

      await page.getByRole("button", { name: "+ Add Contact" }).click();
      await page.getByLabel("Contact Name").fill("Sam Neighbor");
      await page.getByLabel("Phone", { exact: true }).fill("555-222-3333");
      await page.getByRole("button", { name: "Add Contact", exact: true }).click();
      await expect(page.getByText("Emergency contact added.")).toBeVisible();

      const own = memberCard(page, name);
      await own.getByRole("button", { name: "Edit" }).click();
      await page.getByLabel("Individual is over 25").check();
      await page.getByLabel("Allergies (optional)").fill("peanuts");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(own).toContainText("Allergies: peanuts");

      await myHousehold(page);
      await expect(page.getByLabel("Street Address")).toHaveValue("500 Workshop Way");
      await expect(page.getByLabel("ZIP")).toHaveValue("78702");
      await expect(page.getByText("Sam Neighbor")).toBeVisible();
      await expect(own).toContainText("Allergies: peanuts");
    });
  });

  test("H3: an adult who is not a lead edits only themselves", async ({ browser }) => {
    const lead = await loginAs(await settledFamily());
    const [adult, adultEmail, youth] = [`Partner ${Date.now()}`, uniqueEmail("partner"), `Their Youth ${Date.now()}`];
    const added = [
      { memberName: adult, memberEmail: adultEmail, memberOver25: true, memberPhone: "555-333-4444" },
      { memberName: youth, memberDob: youthBirthDate() },
    ];
    for (const member of added) expect((await send(lead, "PATCH", "/api/household", member)).status).toBe(200);

    await asViewer(browser, adultEmail, async (page) => {
      await myHousehold(page);
      await expect(memberCard(page, adult).getByRole("button", { name: "Edit" })).toBeVisible();
      await expect(memberCard(page, youth)).toBeVisible();
      await expect(memberCard(page, youth).getByRole("button", { name: "Edit" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "+ Add Household Member" })).toHaveCount(0);
    });
  });

  test("H4: the lead adds and removes a trusted adult", async ({ browser }) => {
    const email = await settledFamily();
    const trusted = `Trusted Friend ${Date.now()}`;

    await asViewer(browser, email, async (page) => {
      await page.goto("/trusted-adults");
      await page.getByRole("button", { name: "Add a trusted adult" }).click();
      const form = page.getByRole("dialog");
      await form.getByLabel("Trusted adult's name").fill(trusted);
      await form.getByLabel("Their phone").fill("555-444-5555");
      await form.getByLabel(/^For the board/).fill("A family friend who may pick up our kids.");
      await form.getByRole("button", { name: "Submit for board review" }).click();

      const listed = page.locator(".mantine-Card-root").filter({ hasText: trusted });
      await expect(listed).toContainText("Awaiting board review");

      await listed.getByRole("button", { name: "Withdraw" }).click();
      await expect(listed).toContainText("Withdrawn");
      await listed.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
      await expect(listed).toHaveCount(0);

      await page.reload();
      await expect(page.getByText("No trusted adults added yet.")).toBeVisible();
    });
  });

  test("H5: a trusted person's email is locked", async ({ browser }) => {
    const { name } = await persona(KEYHOLDER);
    const changed = uniqueEmail("keyholder1.other");

    await asViewer(browser, KEYHOLDER, async (page) => {
      await myHousehold(page);
      const own = memberCard(page, name);
      await own.getByRole("button", { name: "Edit" }).click();
      await page.getByLabel("Email").fill(changed);
      // The seeded keyholder has no date of birth, which the form requires before it will send.
      await page.getByLabel("Individual is over 25").check();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText(BOARD_ONLY_EMAIL)).toBeVisible();

      await myHousehold(page);
      await expect(own).toContainText(KEYHOLDER);
      await expect(own).not.toContainText(changed);
    }, new RegExp(`${BOARD_ONLY_EMAIL}|400 /api/household/member`));
  });
});
