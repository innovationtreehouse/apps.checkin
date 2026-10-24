import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpensesPage from "@checkin/expense/pages/expenses";

let mockSearch = new URLSearchParams();
const mockReplace = jest.fn();
const mockLoaded: string[] = [];

jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock("@checkin/expense/components/api", () => ({
  PAGE_SIZE: 50,
  useLoad: (path: string) => {
    mockLoaded.push(path);
    return { data: null, error: null, reload: () => {} };
  },
}));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  mockLoaded.length = 0;
  mockReplace.mockClear();
});

function renderList(search: string) {
  mockSearch = new URLSearchParams(search);
  render(<MantineProvider><ExpensesPage /></MantineProvider>);
}

describe("Only show active on the expense list", () => {
  it("is on by default and asks the server for active expenses only", () => {
    renderList("");
    expect(screen.getByRole("checkbox", { name: "Only show active" })).toBeChecked();
    expect(mockLoaded).toContain("/expenses?view=all&active=1&page=1&limit=50");
    expect(mockLoaded).toContain("/expenses/count?view=all&active=1");
  });

  it("turned off, lists every expense and keeps the choice in the URL", () => {
    renderList("view=all&page=3");
    fireEvent.click(screen.getByRole("checkbox", { name: "Only show active" }));
    expect(mockReplace).toHaveBeenCalledWith("/expense/expenses?view=all&page=1&active=0", { scroll: false });
  });

  it("off in the URL, loads closed expenses too", () => {
    renderList("view=all&active=0");
    expect(screen.getByRole("checkbox", { name: "Only show active" })).not.toBeChecked();
    expect(mockLoaded).toContain("/expenses?view=all&page=1&limit=50");
    expect(mockLoaded).toContain("/expenses/count?view=all");
  });

  it("is not offered on a work view", () => {
    renderList("view=owner_approval");
    expect(screen.queryByRole("checkbox", { name: "Only show active" })).not.toBeInTheDocument();
    expect(mockLoaded).toContain("/expenses?view=owner_approval&page=1&limit=50");
  });
});

describe("View descriptions on the expense list", () => {
  it.each([
    ["all", "Every expense you can see, newest first. Open one to act on it."],
    ["assign_ownership", "Expenses with lines that have no owner yet. FINANCE assigns each line an owner."],
    ["resolve_ownership", "Lines the submitter marked as owner unknown. FINANCE picks an owner for each."],
    ["owner_approval", "Lines waiting on their bucket's approval. The bucket owner or a treasurer approves each or raises an exception."],
    ["owner_exception", "Lines an approver raised an exception on. FINANCE settles each one."],
    ["capital_review", "Expenses at or over the capital thresholds. FINANCE decides which lines are capital assets."],
    ["set_depreciation_cycle", "Capital expenses with no depreciation schedule yet. FINANCE sets the cycle and owner bucket."],
    ["qb_pending", "Signed-off expenses waiting for the app to post them to QuickBooks. Nobody needs to act."],
  ])("the %s view says what it lists and who acts", (view, description) => {
    renderList(`view=${view}`);
    expect(screen.getByText(description)).toBeInTheDocument();
  });
});
