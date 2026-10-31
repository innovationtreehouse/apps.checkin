import { orgEventAlerts } from "../orgEventAlerts";

const mockEmail = jest.fn(async () => {});
jest.mock("@/lib/emailRecipients", () => ({ emailBoardMembers: (...args: unknown[]) => mockEmail(...(args as [])) }));

const problemFor = async (event: Parameters<ReturnType<typeof orgEventAlerts>["orgEventsStuck"]>[0]) => {
  mockEmail.mockClear();
  await orgEventAlerts("board.inventoryEventsStuck", "label").orgEventsStuck(event);
  return (mockEmail.mock.calls[0] as unknown[])[1];
};

describe("orgEventAlerts", () => {
  it("names events and provisionals, only those that apply", async () => {
    const base = { failed: 0, unprocessed: 0, unreadable: false };
    expect(await problemFor({ ...base, failed: 1, unprocessed: 2 })).toEqual({ problem: "found 1 newly failed and 2 unprocessed catalog event(s)" });
    const widget = { gtin13: "2000000000015", name: "Widget" };
    const gadget = { gtin13: "2000000000022", name: "Gadget" };
    expect(await problemFor({ ...base, stuckProvisionals: [widget, gadget] })).toEqual({
      problem: "could not apply the catalog's decision to 2 provisional item(s): Widget (2000000000015), Gadget (2000000000022)",
    });
    expect(await problemFor({ ...base, unreadable: true, stuckProvisionals: [widget] })).toEqual({
      problem: "could not read the catalog's events and could not apply the catalog's decision to 1 provisional item(s): Widget (2000000000015)",
    });
  });

  it("shortens a long provisional name to 80 characters", async () => {
    const stuckProvisionals = [{ gtin13: "2000000000015", name: "x".repeat(81) }];
    expect(await problemFor({ failed: 0, unprocessed: 0, unreadable: false, stuckProvisionals })).toEqual({
      problem: `could not apply the catalog's decision to 1 provisional item(s): ${"x".repeat(80)} (2000000000015)`,
    });
  });

  it("names at most 20 provisionals and counts the rest", async () => {
    const stuckProvisionals = Array.from({ length: 23 }, (_, i) => ({ gtin13: `gtin${i}`, name: `Item ${i}` }));
    const { problem } = (await problemFor({ failed: 0, unprocessed: 0, unreadable: false, stuckProvisionals })) as { problem: string };
    expect(problem).toContain("23 provisional item(s)");
    expect(problem).toContain("Item 19 (gtin19), and 3 more");
    expect(problem).not.toContain("Item 20");
  });
});
