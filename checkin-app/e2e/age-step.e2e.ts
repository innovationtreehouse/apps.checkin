/**
 * A person with no age on file meets one step, their date of birth or "over 25", before any page,
 * and carries on to the page they asked for once it is saved.
 */
import { expect, test } from "@playwright/test";
import { api, loginAs } from "../flow-tests/helpers";
import { asViewer, mintFamily } from "./support/families";
import { send } from "./support/seedState";

test.describe("age step", () => {
  test("A1: a first sign-in gives an age before reaching the page asked for", async ({ browser }) => {
    const email = await mintFamily();
    const contact = { phone: "555-123-4567", emergencyContactName: "Pat Outside", emergencyContactPhone: "555-987-6543" };
    expect((await send(await loginAs(email), "POST", "/api/profile/onboarding", contact)).status).toBe(200);

    await asViewer(browser, email, async (page) => {
      await page.goto("/my-household");
      await expect(page.getByRole("heading", { name: "Your date of birth" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Household Members" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

      await page.getByLabel("I am over 25").check();
      await page.getByRole("button", { name: "Save & continue" }).click();

      await expect(page.getByRole("heading", { name: "Household Members" })).toBeVisible();
      await expect(page).toHaveURL(/\/my-household$/);
    });

    const { json } = await api<{ profile: { isDeclaredAdult: boolean } }>(await loginAs(email), "/api/profile");
    expect(json.profile.isDeclaredAdult).toBe(true);
  });
});
