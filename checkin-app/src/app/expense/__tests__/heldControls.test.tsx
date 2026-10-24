import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MantineProvider } from "@mantine/core";
import FlagsPage from "@checkin/expense/pages/flags";

let mockLoads: Record<string, unknown> = {};

jest.mock("@checkin/expense/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useRoles: () => ({ isFinance: false, isBoard: false }),
  useBuckets: () => [],
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

const wrap = (ui: ReactElement) => render(<MantineProvider>{ui}</MantineProvider>);

describe("Check off on the flags page", () => {
  it("is disabled with a reason for REIMBURSEE_UNKNOWN and enabled for other kinds", () => {
    mockLoads = {
      "/flags": [
        { id: 1, expenseId: "e1", kind: "REIMBURSEE_UNKNOWN", audience: "FINANCE", detail: null, raisedAt: "2026-10-01T00:00:00Z" },
        { id: 2, expenseId: "e2", kind: "TAX_ATTACHED", audience: "FINANCE", detail: null, raisedAt: "2026-10-01T00:00:00Z" },
      ],
    };
    wrap(<FlagsPage />);
    const [held, open] = screen.getAllByRole("button", { name: "Check off" });
    expect(held).toBeDisabled();
    expect(open).toBeEnabled();
    expect(screen.getByText("Set the reimbursee to clear this flag")).toBeInTheDocument();
  });
});
