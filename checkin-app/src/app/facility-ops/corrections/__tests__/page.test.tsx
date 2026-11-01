type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { mockFetchJson, renderWithProviders, resetRtl, setSession } from "@/test-helpers/rtl";
import CorrectionsPage from "../page";

const ROUTE = "/api/facility/corrections";
const payload = {
  AuditLog: [{
    id: 1, timestamp: "2026-10-01T12:00:00.000Z", actorId: 3, actorSystem: null, action: "EDIT", tableName: "Visit",
    affectedEntityId: 8, secondaryAffectedEntity: 4, newData: { type: "staff_correction" },
  }],
  Person: [{ id: 3, name: "Pat Staff", mergedIntoId: null }, { id: 4, name: "Sam Subject", mergedIntoId: null }],
  Visit: [[null, null]],
};

beforeEach(() => resetRtl());

describe("facility-ops/corrections page", () => {
  it("lists corrections and re-reads when the period changes", async () => {
    setSession({ id: 1, isBoardMember: true });
    const fetchMock = mockFetchJson({ [ROUTE]: payload });
    renderWithProviders(<CorrectionsPage />);

    expect(await screen.findByText("Staff correction")).toBeInTheDocument();
    expect(screen.getByText("Sam Subject")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Week"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("period=week"), expect.anything()));
  });

  it("shows the failure, not a count of zero, when the load fails", async () => {
    setSession({ id: 1, isBoardMember: true });
    mockFetchJson({});
    renderWithProviders(<CorrectionsPage />);

    expect(await screen.findByText("Couldn't load corrections")).toBeInTheDocument();
    expect(screen.queryByText("No corrections in this range.")).not.toBeInTheDocument();
  });
});
