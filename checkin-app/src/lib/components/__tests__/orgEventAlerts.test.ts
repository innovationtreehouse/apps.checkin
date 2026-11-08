import { orgEventAlerts } from "../orgEventAlerts";

const mockEmail = jest.fn(async () => {});
jest.mock("@/lib/emailRecipients", () => ({ emailBoardMembers: (...args: unknown[]) => mockEmail(...(args as [])) }));

const problemFor = async (event: Parameters<ReturnType<typeof orgEventAlerts>["orgEventsStuck"]>[0]) => {
  mockEmail.mockClear();
  await orgEventAlerts("board.receiptMappingEventsStuck", "label").orgEventsStuck(event);
  return (mockEmail.mock.calls[0] as unknown[])[1];
};

describe("orgEventAlerts", () => {
  it("counts failed and unprocessed events", async () => {
    expect(await problemFor({ failed: 1, unprocessed: 2, unreadable: false })).toEqual({ problem: "found 1 newly failed and 2 unprocessed catalog event(s)" });
  });

  it("says when the catalog can't be read", async () => {
    expect(await problemFor({ failed: 0, unprocessed: 0, unreadable: true })).toEqual({ problem: "could not read the catalog's events" });
  });
});
