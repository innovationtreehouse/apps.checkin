import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import { AuditLogPanel } from "../AuditLogPanel";

beforeEach(() => resetRtl());

const page1 = {
  logs: [
    {
      id: 1,
      timestamp: "2026-06-01T12:00:00Z",
      actorId: 5,
      actorName: "Jo Admin",
      action: "EDIT" as const,
      tableName: "Household",
      affectedEntityId: 42,
      secondaryAffectedEntity: null,
      oldData: { name: "old" },
      newData: { name: "new" },
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
  tables: ["Household", "Person"],
};

describe("AuditLogPanel", () => {
  it("renders loaded rows and the total count", async () => {
    mockFetchJson({ "/api/system-status/audit-log": page1 });
    renderWithProviders(<AuditLogPanel />);
    expect(await screen.findByText("EDIT")).toBeInTheDocument();
    expect(screen.getByText("Household #42")).toBeInTheDocument();
    expect(screen.getByText("Jo Admin")).toBeInTheDocument();
    expect(screen.getByText("1 change — forensic trail, read-only.")).toBeInTheDocument();
  });

  it("shows the empty message when no logs match the filters", async () => {
    mockFetchJson({ "/api/system-status/audit-log": { ...page1, logs: [], total: 0 } });
    renderWithProviders(<AuditLogPanel />);
    expect(await screen.findByText("No audit entries match these filters.")).toBeInTheDocument();
  });

  it("shows a failure message when the fetch fails", async () => {
    mockFetchJson({});
    renderWithProviders(<AuditLogPanel />);
    expect(await screen.findByText("Couldn't load the audit log")).toBeInTheDocument();
    expect(screen.queryByText("No audit entries match these filters.")).not.toBeInTheDocument();
  });

  it("refetches with the from-date filter and resets to page 1", async () => {
    const fetchFn = mockFetchJson({ "/api/system-status/audit-log": page1 });
    const { container } = renderWithProviders(<AuditLogPanel />);
    await screen.findByText("EDIT");

    const [fromInput] = container.querySelectorAll('input[type="date"]');
    fireEvent.change(fromInput, { target: { value: "2026-01-01" } });

    await waitFor(() => {
      const lastUrl = fetchFn.mock.calls.at(-1)?.[0] as string;
      expect(lastUrl).toContain("from=2026-01-01");
      expect(lastUrl).toContain("page=1");
    });
  });
});
