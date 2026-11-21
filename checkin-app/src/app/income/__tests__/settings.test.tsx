import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import IncomeSettingsPage from "@checkin/income/pages/settings";

const SAVED = { maxCreatesPerRun: 25, maxCreateCentsPerRun: 2_500_000, benevityMaxCreateCentsPerRun: 1_000_000, benevityMatchWindowDays: 7 };
const mockState: { isBoard: boolean; data: typeof SAVED | null; error: string | null } = { isBoard: false, data: SAVED, error: null };
const mockApi = jest.fn();
const mockReload = jest.fn();

jest.mock("@checkin/income/components/api", () => ({
  useIsBoard: () => mockState.isBoard,
  useLoad: () => ({ data: mockState.data, error: mockState.error, reload: mockReload }),
  api: (...args: unknown[]) => mockApi(...args),
  refusalMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn(), update: jest.fn() } }));

beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList);
});

afterEach(() => {
  Object.assign(mockState, { isBoard: false, data: SAVED, error: null });
  jest.clearAllMocks();
});

const COUNT = "QuickBooks deposits created per run, all sources together (at most 100)";
const CENTS = "Dollars booked per run, each source other than Benevity";
const BENEVITY_CENTS = "Dollars booked per run from Benevity";
const WINDOW = "Benevity match window: days either side of the payout date";
const RAISE_NOTE = "You can lower this. Only the Board can raise it.";

const renderPage = () => render(<MantineProvider><IncomeSettingsPage /></MantineProvider>);
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));
const sentPatch = (): unknown => JSON.parse((mockApi.mock.calls[0][1] as { body: string }).body);

describe("Income settings for FINANCE", () => {
  it("shows the saved values, with each cap noted as lower-only and the window not", () => {
    renderPage();
    expect(screen.getByLabelText(COUNT)).toHaveValue("25");
    expect(screen.getByLabelText(CENTS)).toHaveValue("$25000");
    expect(screen.getByLabelText(BENEVITY_CENTS)).toHaveValue("$10000");
    expect(screen.getByLabelText(WINDOW)).toHaveValue("7");
    expect(screen.getAllByText(RAISE_NOTE)).toHaveLength(3);
  });

  it("lowers a cap, sending cents", async () => {
    mockApi.mockResolvedValue({});
    renderPage();
    fireEvent.change(screen.getByLabelText(CENTS), { target: { value: "$12000" } });
    save();
    await waitFor(() => expect(mockReload).toHaveBeenCalled());
    expect(mockApi).toHaveBeenCalledWith("/settings", expect.objectContaining({ method: "PATCH" }));
    expect(sentPatch()).toEqual({ maxCreateCentsPerRun: 1_200_000 });
  });

  it("shows the server's refusal as written when a raise is saved", async () => {
    mockApi.mockRejectedValue(new Error("Raising maxCreatesPerRun takes the board"));
    renderPage();
    fireEvent.change(screen.getByLabelText(COUNT), { target: { value: "40" } });
    save();
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: "Raising maxCreatesPerRun takes the board", color: "red" })),
    );
    expect(mockReload).not.toHaveBeenCalled();
  });

  it.each([3, 14])("moves the match window to %i days", async (days) => {
    mockApi.mockResolvedValue({});
    renderPage();
    fireEvent.change(screen.getByLabelText(WINDOW), { target: { value: String(days) } });
    save();
    await waitFor(() => expect(mockReload).toHaveBeenCalled());
    expect(sentPatch()).toEqual({ benevityMatchWindowDays: days });
  });
});

describe("Income settings for the Board", () => {
  it("raises a cap, with no lower-only note", async () => {
    mockState.isBoard = true;
    mockApi.mockResolvedValue({});
    renderPage();
    expect(screen.queryByText(RAISE_NOTE)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(BENEVITY_CENTS), { target: { value: "$30000" } });
    fireEvent.change(screen.getByLabelText(WINDOW), { target: { value: "2" } });
    save();
    await waitFor(() => expect(mockReload).toHaveBeenCalled());
    expect(sentPatch()).toEqual({ benevityMaxCreateCentsPerRun: 3_000_000, benevityMatchWindowDays: 2 });
  });
});

describe("A failed load of the income settings", () => {
  it("shows the error with a Retry that reloads, and no Save", () => {
    Object.assign(mockState, { data: null, error: "Server error" });
    renderPage();
    expect(screen.getByText("Couldn't load income settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockReload).toHaveBeenCalled();
  });
});
