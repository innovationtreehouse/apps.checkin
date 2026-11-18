import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SettingsPage from "@checkin/expense/pages/settings";

const mockRoles = { isFinance: false, isBoard: true };
const mockData: Record<string, number | boolean | null> = {};
const mockSend = jest.fn();

jest.mock("@checkin/expense/components/api", () => ({
  useRoles: () => mockRoles,
  useLoad: () => ({
    data: {
      boardReviewTotalCents: 200_000,
      capitalTotalThresholdCents: 0,
      capitalLineItemThresholdCents: 0,
      everydayTotalLimitCents: 50_000,
      everydayItemLimitCents: 25_000,
      ...mockData,
    },
    error: null,
    reload: () => {},
  }),
  send: (...args: unknown[]) => mockSend(...args),
}));

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

describe("Capital review labels on the expense settings page", () => {
  it("name what each threshold compares, with no 0 = off", () => {
    render(<MantineProvider><SettingsPage /></MantineProvider>);
    expect(screen.getByLabelText("Capital review: receipt total at or over")).toBeInTheDocument();
    expect(screen.getByLabelText("Capital review: unit price at or over")).toBeInTheDocument();
    expect(screen.queryByText(/0 = off/)).not.toBeInTheDocument();
  });
});

describe("What FINANCE may change on the expense settings page", () => {
  afterEach(() => Object.assign(mockRoles, { isFinance: false, isBoard: true }));

  it("shows FINANCE the capital thresholds and Everyday limits read-only, saying the Board sets them", () => {
    Object.assign(mockRoles, { isFinance: true, isBoard: false });
    render(<MantineProvider><SettingsPage /></MantineProvider>);
    expect(screen.getByLabelText("Capital review: receipt total at or over")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Capital review: unit price at or over")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Everyday card charge: total under")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Everyday card charge: no single item over")).toHaveAttribute("readonly");
    expect(screen.getAllByText("The Board sets this.")).toHaveLength(4);
  });

  it("leaves FINANCE the Board review threshold to lower, and a Save button for it", () => {
    Object.assign(mockRoles, { isFinance: true, isBoard: false });
    render(<MantineProvider><SettingsPage /></MantineProvider>);
    expect(screen.getByLabelText(/Board review: receipt total at or over/)).not.toHaveAttribute("readonly");
    expect(screen.getByText("You can lower this. Only the Board can raise it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("leaves every threshold editable for the Board", () => {
    render(<MantineProvider><SettingsPage /></MantineProvider>);
    expect(screen.getByLabelText("Capital review: receipt total at or over")).not.toHaveAttribute("readonly");
    expect(screen.queryByText("The Board sets this.")).not.toBeInTheDocument();
  });

  it("lets the Board edit both Everyday limits and saves them in cents", () => {
    render(<MantineProvider><SettingsPage /></MantineProvider>);
    const total = screen.getByLabelText("Everyday card charge: total under");
    const item = screen.getByLabelText("Everyday card charge: no single item over");
    expect(total).toHaveValue("$500");
    expect(item).toHaveValue("$250");
    fireEvent.change(total, { target: { value: "$400" } });
    fireEvent.change(item, { target: { value: "$300" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mockSend).toHaveBeenCalledWith(
      "/org-settings",
      "PUT",
      { everydayTotalLimitCents: 40_000, everydayItemLimitCents: 30_000 },
      "Settings saved",
    );
  });
});

describe("The capital review switch on the expense settings page", () => {
  afterEach(() => {
    for (const k of Object.keys(mockData)) delete mockData[k];
    Object.assign(mockRoles, { isFinance: false, isBoard: true });
  });

  it("disables both capital thresholds while capital review is off", () => {
    Object.assign(mockData, { capitalReviewEnabled: false, capitalTotalThresholdCents: 500_000, capitalLineItemThresholdCents: 250_000 });
    render(<MantineProvider><SettingsPage /></MantineProvider>);
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(screen.getByLabelText("Capital review: receipt total at or over")).toBeDisabled();
    expect(screen.getByLabelText("Capital review: unit price at or over")).toBeDisabled();
  });

  it("saves the switch change without the capital thresholds edited before turning review off", () => {
    mockSend.mockClear();
    Object.assign(mockData, { capitalReviewEnabled: true, capitalTotalThresholdCents: 500_000, capitalLineItemThresholdCents: 250_000 });
    render(<MantineProvider><SettingsPage /></MantineProvider>);
    fireEvent.change(screen.getByLabelText("Capital review: receipt total at or over"), { target: { value: "$6000" } });
    fireEvent.change(screen.getByLabelText("Capital review: unit price at or over"), { target: { value: "$3000" } });
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mockSend).toHaveBeenCalledWith("/org-settings", "PUT", { capitalReviewEnabled: false }, "Settings saved");
  });

  it("warns that every expense waits at capital review while review is on and a threshold is unset", () => {
    Object.assign(mockData, { capitalReviewEnabled: true, capitalTotalThresholdCents: null, capitalLineItemThresholdCents: 250_000 });
    render(<MantineProvider><SettingsPage /></MantineProvider>);
    expect(screen.getByText(/capital review thresholds are not set/)).toBeInTheDocument();
    expect(screen.getByLabelText("Capital review: receipt total at or over")).toHaveValue("");
  });

  it("does not let FINANCE turn capital review off", () => {
    Object.assign(mockRoles, { isFinance: true, isBoard: false });
    Object.assign(mockData, { capitalReviewEnabled: true });
    render(<MantineProvider><SettingsPage /></MantineProvider>);
    expect(screen.getByRole("switch")).toBeDisabled();
  });
});
