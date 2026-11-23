import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { HttpError } from "@checkin/component-ui";
import ReceiptMailQueuePage from "@checkin/receipt/pages/mail";

const mockReload = jest.fn();
const mockApi = jest.fn();

jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn(), hide: jest.fn() } }));
jest.mock("@checkin/receipt/components/MailCatchUp", () => ({ __esModule: true, default: () => <div /> }));
jest.mock("@checkin/receipt/components/api", () => ({
  ...jest.requireActual("@checkin/receipt/components/api"),
  api: (...args: unknown[]) => mockApi(...args),
  useLoad: (path: string) => ({ data: path === "/mail-messages" ? EMAILS : [], error: null, reload: mockReload }),
}));

const EMAILS = [
  { id: 3, receivedAt: "2026-08-01T09:00:00.000Z", capturedAt: "2026-08-01T09:05:00.000Z", expired: true },
  { id: 7, receivedAt: "2026-11-20T09:00:00.000Z", capturedAt: "2026-11-20T09:05:00.000Z", expired: false },
];

const show = jest.mocked(notifications.show);

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
});

beforeEach(() => {
  mockReload.mockClear();
  mockApi.mockReset();
  show.mockClear();
});

const page = () => render(<MantineProvider><ReceiptMailQueuePage /></MantineProvider>);

async function processAgain() {
  page();
  fireEvent.click(screen.getByRole("button", { name: "Process again" }));
  await waitFor(() => expect(show).toHaveBeenCalled());
}

describe("captured emails not yet processed on the mail page", () => {
  it("offers Process again only for an email inside retention, and marks the expired one", () => {
    page();
    expect(screen.getAllByRole("button", { name: "Process again" })).toHaveLength(1);
    expect(screen.getByText("Expired, can't be replayed")).toBeTruthy();
  });

  it("replays the email and refreshes the list on success", async () => {
    mockApi.mockResolvedValue({ status: "processed" });
    await processAgain();
    expect(mockApi).toHaveBeenCalledWith("/mail-messages/7/replay", { method: "POST" });
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: "Processed", color: "green" }));
    expect(mockReload).toHaveBeenCalled();
  });

  it.each<[string, () => Promise<unknown>, string]>([
    ["an expired outcome", async () => ({ status: "expired", message: "This email's stored copy expired 30 days after capture." }), "This email's stored copy expired 30 days after capture."],
    [
      "a waiting outcome",
      async () => ({ status: "waiting" }),
      "Processed again, but a file in it waits for a later run: a sender's daily upload limit or the held-mail limit put it off",
    ],
    ["a 404", async () => { throw new HttpError("No such captured email.", 404); }, "No such captured email."],
    ["a 409", async () => { throw new HttpError("The receipt mailbox is not set up.", 409); }, "The receipt mailbox is not set up."],
    [
      "a server failure",
      async () => { throw new HttpError("Internal Server Error", 500); },
      "Processing it again failed. The reason is recorded on the email, not shown here; try again later",
    ],
  ])("shows %s as a red chip that stays, with its own reason", async (_case, outcome, text) => {
    mockApi.mockImplementation(outcome);
    await processAgain();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't process this email again", message: text, color: "red", autoClose: false }));
    expect(mockReload).toHaveBeenCalled();
  });
});
