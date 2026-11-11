import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ExpenseDetailPage from "@checkin/expense/pages/expenseDetail";

let mockLoads: Record<string, unknown> = {};
const mockSend = jest.fn(async () => true);

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => ({ isFinance: true, isBoard: false }),
  send: (...args: unknown[]) => mockSend(...(args as [])),
}));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // jsdom has no scrollIntoView, which Mantine's combobox calls on open.
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  mockSend.mockClear();
  mockLoads = {
    "/expenses/e1": {
      id: "e1", vendorName: "Acme", receiptDate: null, receiptTotalCents: 1000, currency: "USD", state: "pending_approval",
      needsReimbursement: true, reimburseePersonId: null, backfill: false, lineItems: [], approvals: [],
    },
    "/expenses/e1/line-item-approvals": [],
    "/expenses/e1/signoffs": [],
    "/expenses/e1/reimbursee/options?q=sam": [{ personId: 42, name: "Sam Lee" }],
  };
});

const wrap = () => render(<MantineProvider><ExpenseDetailPage id="e1" /></MantineProvider>);

describe("setting the reimbursee", () => {
  it("offers no box for a typed person id", () => {
    wrap();
    expect(screen.queryByPlaceholderText("Person id")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set reimbursee" })).toBeDisabled();
  });

  it("sets someone picked from the name search", async () => {
    wrap();
    const picker = screen.getByRole("textbox", { name: /Reimburse/ });
    fireEvent.click(picker);
    fireEvent.change(picker, { target: { value: "sam" } });
    fireEvent.click(await screen.findByRole("option", { name: "Sam Lee" }));
    fireEvent.click(screen.getByRole("button", { name: "Set reimbursee" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith("/expenses/e1/reimbursee", "PUT", { personId: 42 }, "Reimbursee set"));
  });

  it("adds a non-member by name once they are declared an adult", async () => {
    wrap();
    fireEvent.click(screen.getByLabelText("Not a member / not in the list"));
    expect(screen.queryByRole("textbox", { name: /Reimburse/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Their full name/), { target: { value: " Dana Field " } });
    expect(screen.getByRole("button", { name: "Set reimbursee" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("They are an adult (18 or over)"));
    fireEvent.click(screen.getByRole("button", { name: "Set reimbursee" }));
    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith("/expenses/e1/reimbursee", "PUT", { newPerson: { name: "Dana Field", isAdult: true } }, "Reimbursee set"),
    );
  });
});
