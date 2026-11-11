import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SettingsPage from "@checkin/expense/pages/settings";

const mockRoles = { isFinance: false, isBoard: true };

jest.mock("@checkin/expense/components/api", () => ({
  useRoles: () => mockRoles,
  useLoad: () => ({
    data: {
      boardReviewTotalCents: 200_000,
      capitalTotalThresholdCents: 0,
      capitalLineItemThresholdCents: 0,
    },
    error: null,
    reload: () => {},
  }),
  send: jest.fn(),
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
    expect(screen.getByLabelText("Capital review: receipt total over")).toBeInTheDocument();
    expect(screen.getByLabelText("Capital review: unit price over")).toBeInTheDocument();
    expect(screen.queryByText(/0 = off/)).not.toBeInTheDocument();
  });
});

describe("What FINANCE may change on the expense settings page", () => {
  afterEach(() => Object.assign(mockRoles, { isFinance: false, isBoard: true }));

  it("shows FINANCE the capital thresholds read-only, saying the Board sets them", () => {
    Object.assign(mockRoles, { isFinance: true, isBoard: false });
    render(<MantineProvider><SettingsPage /></MantineProvider>);
    expect(screen.getByLabelText("Capital review: receipt total over")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Capital review: unit price over")).toHaveAttribute("readonly");
    expect(screen.getAllByText("The Board sets this.")).toHaveLength(2);
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
    expect(screen.getByLabelText("Capital review: receipt total over")).not.toHaveAttribute("readonly");
    expect(screen.queryByText("The Board sets this.")).not.toBeInTheDocument();
  });
});
