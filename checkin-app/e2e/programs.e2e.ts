/**
 * Programs in the browser: the Board creating one, families claiming, paying and asking for a
 * scholarship, the leader's roster and attendance, and the Board's removals
 * (docs/rules/programs.md). Every test makes its own program and families, so a rerun on the same
 * stack starts clean. The local dev mock pays the checkout in place of Shopify.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { addYouth, asViewer, settledFamily } from "./support/families";
import { persona } from "./support/kiosk";
import { claim, inDays, LEADER, newProgram, newSession, paidYouth, PROGRAM_DATES } from "./support/programs";
import { BOARD } from "./support/seedState";

const ONLY_BOARD_REMOVES = "Only the Board removes a paid place";
const REASON = "The family moved away.";

const dialog = (page: Page) => page.getByRole("dialog");
const card = (page: Page, text: string): Locator => page.locator(".mantine-Card-root").filter({ hasText: text });
/** The innermost card naming `name`: on the roster tab, that person's place. */
const place = (page: Page, name: string): Locator => card(page, name).last();

async function programPage(page: Page, id: number): Promise<void> {
  await page.goto(`/programs/${id}`);
  await expect(page.getByRole("heading", { name: "Details" })).toBeVisible();
}

async function roster(page: Page, id: number): Promise<void> {
  await page.goto(`/program-ops/programs/${id}`);
  await page.getByRole("tab", { name: "Roster" }).click();
  await expect(page.getByRole("heading", { name: /^Active Participants/ })).toBeVisible();
}

/** Opens the household picker from the program page and ticks the youth. */
async function pickYouth(page: Page, button: string, youth: string): Promise<void> {
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.getByRole("checkbox", { name: youth }).check();
}

async function requestScholarship(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Request a scholarship or payment plan/ }).click();
  await dialog(page).getByRole("radio", { name: "Scholarship" }).check();
  await dialog(page).getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText(/^Requested!/)).toBeVisible();
}

async function myPrograms(page: Page, program: string): Promise<Locator> {
  await page.goto("/my-activities/programs");
  await expect(page.getByRole("heading", { name: "My Programs" })).toBeVisible();
  return card(page, program);
}

/** The Board's audit trail for one person's rows; a place's entries are keyed by the person. */
async function auditOf(page: Page, personId: number): Promise<Locator> {
  await page.goto("/system-status/audit-log");
  await page.getByLabel("Entity #").fill(String(personId));
  const rows = page.getByRole("row").filter({ hasText: `ProgramParticipant #${personId}` });
  await expect(rows.first()).toBeVisible();
  return rows;
}

test.describe("programs in the browser", () => {
  test("P1: the Board creates a program", async ({ browser }) => {
    const name = `Browser Program ${Date.now()}`;
    const leader = await persona(LEADER);

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/program-ops/new");
      await page.getByLabel("Program Name").fill(name);
      await page.getByLabel("Program Leader").fill(leader.name);
      await page.getByText(LEADER, { exact: true }).click();
      await page.getByLabel("Start Date").fill(PROGRAM_DATES.startAt);
      await page.getByLabel("End Date").fill(PROGRAM_DATES.endAt);
      await page.getByLabel("This is a free program").uncheck();
      await page.getByLabel("Treehouse Member Price ($)").fill("40");
      await page.getByLabel("Non-Member Price ($)").fill("50");
      await page.getByLabel("Max Participants").fill("2");
      await page.getByRole("button", { name: "Create Program" }).click();
      await expect(page).toHaveURL(/\/program-ops\/programs\/\d+$/);
      await expect(page.getByRole("heading", { name })).toBeVisible();

      await page.goto("/program-ops/programs");
      await expect(page.getByRole("link", { name })).toBeVisible();

      await page.goto("/programs");
      const listed = card(page, name);
      await expect(listed).toContainText("0/2");
      await expect(listed).toContainText("Enrolled");
    });
  });

  test("P2: a family claims a seat and pays", async ({ browser }) => {
    const program = await newProgram();
    const email = await settledFamily();
    const youth = await addYouth(email);
    await claim(email, program.id, [youth.id]);

    await asViewer(browser, email, async (page) => {
      await programPage(page, program.id);
      await expect(page.getByText(`${youth.name} — Enrolled, not paid yet`)).toBeVisible();
      await pickYouth(page, "Continue enrollment", youth.name);
      await page.getByRole("button", { name: "Pay on Shopify" }).click();
      await expect(page.getByText("Payment mocked (local) — enrollment activated.")).toBeVisible();
      await expect(page.getByText(`${youth.name} — Enrolled`, { exact: true })).toBeVisible();
    });

    await asViewer(browser, LEADER, async (page) => {
      await roster(page, program.id);
      await expect(page.getByRole("heading", { name: "Active Participants (1)" })).toBeVisible();
      await expect(place(page, youth.name)).toBeVisible();
    });
  });

  test("P3: a scholarship is requested, denied, asked again and approved", async ({ browser }) => {
    const program = await newProgram();
    const email = await settledFamily();
    const youth = await addYouth(email);
    const request = (page: Page) => page.getByRole("row").filter({ hasText: youth.name });

    await asViewer(browser, email, async (page) => {
      await programPage(page, program.id);
      await pickYouth(page, "Enroll", youth.name);
      await requestScholarship(page);
      await expect(await myPrograms(page, program.name)).toContainText("Awaiting finance approval");
    });

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/finance-ops/payment-plan");
      await request(page).getByRole("button", { name: "Refuse" }).click();
      await dialog(page).getByRole("button", { name: "Refuse" }).click();
      await expect(page.getByText("Scholarship / payment plan refused.")).toBeVisible();
      await expect(request(page)).toHaveCount(0);
    });

    await asViewer(browser, email, async (page) => {
      const enrolled = await myPrograms(page, program.name);
      await expect(enrolled).toContainText("Not paid yet");
      await expect(enrolled.getByRole("link", { name: "Pay now" })).toBeVisible();

      await programPage(page, program.id);
      await expect(page.getByText(/Capacity:\s*1\/2/)).toBeVisible();
      await pickYouth(page, "Continue enrollment", youth.name);
      await requestScholarship(page);
    });

    await asViewer(browser, BOARD, async (page) => {
      await page.goto("/finance-ops/payment-plan");
      await request(page).getByRole("button", { name: "Approve & Mark Active" }).click();
      await dialog(page).getByRole("button", { name: "Approve & Mark Active" }).click();
      await expect(page.getByText("Scholarship / payment plan approved.")).toBeVisible();
    });

    await asViewer(browser, email, async (page) => {
      const enrolled = await myPrograms(page, program.name);
      await expect(enrolled).not.toContainText("Not paid yet");
      await expect(enrolled).not.toContainText("Awaiting finance approval");
      await programPage(page, program.id);
      await expect(page.getByText(`${youth.name} — Enrolled`, { exact: true })).toBeVisible();
    });
  });

  test("P4: a program leader cannot add participants; the Board can", async ({ browser }) => {
    const program = await newProgram();

    await asViewer(browser, LEADER, async (page) => {
      await roster(page, program.id);
      await expect(page.getByText(/Program Leads cannot manually enroll participants/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Enroll", exact: true })).toHaveCount(0);
    });

    await asViewer(browser, BOARD, async (page) => {
      await roster(page, program.id);
      await expect(page.getByRole("button", { name: "Enroll", exact: true })).toBeVisible();
    });
  });

  test("P5: only the Board removes a paid place, with a reason", async ({ browser }) => {
    const program = await newProgram();
    const { youth } = await paidYouth(program.id);

    await asViewer(browser, LEADER, async (page) => {
      await roster(page, program.id);
      const remove = place(page, youth.name).getByRole("button", { name: "Remove" });
      await expect(remove).toBeDisabled();
      await expect(remove).toHaveAttribute("title", ONLY_BOARD_REMOVES);
    });

    await asViewer(browser, BOARD, async (page) => {
      await roster(page, program.id);
      await place(page, youth.name).getByRole("button", { name: "Remove" }).click();
      const withdraw = dialog(page).getByRole("button", { name: "Withdrew: keep history" });
      await expect(withdraw).toBeDisabled();
      await expect(dialog(page).getByRole("button", { name: "Never took part: remove" })).toBeDisabled();
      await dialog(page).getByLabel("Reason").fill(REASON);
      await withdraw.click();
      await expect(page.getByRole("heading", { name: "Active Participants (0)" })).toBeVisible();

      const audit = await auditOf(page, youth.id);
      await expect(audit.filter({ hasText: "WITHDRAWN" })).toContainText(REASON);
    });
  });

  test("P6: withdraw keeps the place as history, remove deletes it", async ({ browser }) => {
    const program = await newProgram();
    const withdrawn = (await paidYouth(program.id)).youth;
    const removed = (await paidYouth(program.id)).youth;

    await asViewer(browser, BOARD, async (page) => {
      await roster(page, program.id);
      await expect(page.getByRole("heading", { name: "Active Participants (2)" })).toBeVisible();
      for (const [youth, act] of [[withdrawn, "Withdrew: keep history"], [removed, "Never took part: remove"]] as const) {
        await place(page, youth.name).getByRole("button", { name: "Remove" }).click();
        await dialog(page).getByLabel("Reason").fill(REASON);
        await dialog(page).getByRole("button", { name: act }).click();
        await expect(place(page, youth.name)).toHaveCount(0);
      }
      await expect(page.getByRole("heading", { name: "Active Participants (0)" })).toBeVisible();

      await programPage(page, program.id);
      await expect(page.getByText(/Capacity:\s*0\/2/)).toBeVisible();

      const kept = await auditOf(page, withdrawn.id);
      await expect(kept.filter({ hasText: "WITHDRAWN" })).toContainText("EDIT");
      await expect(kept.filter({ hasText: "DELETE" })).toHaveCount(0);
      await expect((await auditOf(page, removed.id)).filter({ hasText: "DELETE" })).toHaveCount(1);
    });
  });

  test("P7: a full program refuses new claims; the Board can comp", async ({ browser }) => {
    const program = await newProgram();
    await paidYouth(program.id);
    await paidYouth(program.id);
    const email = await settledFamily();
    const youth = await addYouth(email);
    const full = "Program has reached maximum capacity.";

    await asViewer(browser, email, async (page) => {
      await programPage(page, program.id);
      await expect(page.getByText(/Capacity:\s*2\/2/)).toBeVisible();
      await pickYouth(page, "Enroll", youth.name);
      await page.getByRole("button", { name: "Pay on Shopify" }).click();
      await expect(page.getByText(full)).toBeVisible();
    }, new RegExp(full));

    await asViewer(browser, BOARD, async (page) => {
      await roster(page, program.id);
      await page.getByLabel("Assign Participant").fill(youth.name);
      await page.getByText(youth.name, { exact: true }).click();
      await page.getByRole("button", { name: "Enroll", exact: true }).click();
      await dialog(page).getByRole("button", { name: "Add Participant" }).click();
      await expect(page.getByRole("heading", { name: "Active Participants (3)" })).toBeVisible();
      await expect(place(page, youth.name)).toBeVisible();
    });
  });

  test("P8: a leader marks attendance", async ({ browser }) => {
    const program = await newProgram();
    const { email, youth } = await paidYouth(program.id);
    const session = await newSession(program.id, -90, -30);
    const upcoming = await newSession(program.id, 24 * 60, 25 * 60);
    const visit = (page: Page) => page.getByRole("row").filter({ hasText: youth.name }).filter({ hasText: session.name });

    const mark = async (page: Page, status: "Present" | "Absent") => {
      const row = page.getByRole("row").filter({ hasText: youth.name });
      await row.getByRole("button", { name: "Manual Edit" }).click();
      await dialog(page).getByRole("textbox", { name: "Status" }).click();
      await page.getByRole("option", { name: status }).click();
      await dialog(page).getByRole("button", { name: "Save" }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(row).toContainText(status === "Present" ? "Arrived:" : "Absent");
    };
    const household = async (page: Page) => {
      await page.goto("/attendance/household");
      await expect(page.getByRole("heading", { name: "Household Check-ins" })).toBeVisible();
    };

    await asViewer(browser, LEADER, async (page) => {
      await page.goto(`/program-ops/sessions/${session.id}`);
      await mark(page, "Present");
    });
    await asViewer(browser, email, async (page) => {
      await household(page);
      await expect(visit(page)).toBeVisible();
    });

    await asViewer(browser, LEADER, async (page) => {
      await page.goto(`/program-ops/sessions/${session.id}`);
      await mark(page, "Absent");

      await page.goto(`/program-ops/sessions/${upcoming.id}`);
      await expect(page.getByRole("heading", { name: upcoming.name })).toBeVisible();
      await expect(page.getByRole("button", { name: "Manual Edit" })).toHaveCount(0);
    });
    await asViewer(browser, email, async (page) => {
      await household(page);
      await expect(visit(page)).toHaveCount(0);
    });
  });

  test("P9: the off-sale date closes enrollment at once", async ({ browser }) => {
    const program = await newProgram();
    const email = await settledFamily();
    const youth = await addYouth(email);
    const ended = "Sales for this program have ended.";

    await asViewer(browser, BOARD, async (page) => {
      await page.goto(`/program-ops/programs/${program.id}`);
      await page.getByLabel("Off-Sale Date").fill(inDays(-1));
      await page.getByRole("button", { name: "Save Settings" }).click();
      await expect(page.getByText("Saved.")).toBeVisible();
    });

    await asViewer(browser, email, async (page) => {
      await programPage(page, program.id);
      await pickYouth(page, "Enroll", youth.name);
      await page.getByRole("button", { name: "Pay on Shopify" }).click();
      await expect(page.getByText(ended)).toBeVisible();
      await expect(page.getByText("Already enrolled from your household")).toHaveCount(0);
    }, new RegExp(ended));
  });
});
