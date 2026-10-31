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
    expect(await problemFor({ ...base, reconcileFailed: 3 })).toEqual({ problem: "could not apply the catalog's decision to 3 provisional item(s)" });
    expect(await problemFor({ ...base, unreadable: true, reconcileFailed: 1 })).toEqual({
      problem: "could not read the catalog's events and could not apply the catalog's decision to 1 provisional item(s)",
    });
  });
});
