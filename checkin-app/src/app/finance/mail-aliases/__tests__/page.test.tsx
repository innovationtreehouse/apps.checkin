type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { mockFetchJson, renderWithProviders, resetRtl, router, setSession } from "@/test-helpers/rtl";
import MailAliasesPage from "../page";

const ROUTE = "/api/finance/mail-aliases";
const alias = { id: 5, address: "old@example.com", approvedAt: null, person: { name: "Pat Lee", email: "pat@example.com" } };

beforeEach(() => resetRtl());

describe("mail aliases page", () => {
  it("re-reads the list after a write and keeps the same route", async () => {
    setSession({ id: 1, isFinance: true });
    const fetchMock = mockFetchJson({ [ROUTE]: { PersonMailAlias: [alias] } });
    renderWithProviders(<MailAliasesPage />);
    expect(await screen.findByText("old@example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${ROUTE}/5/approve`, { method: "POST" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => url === ROUTE && !init?.method)).toHaveLength(2));
  });

  it("shows the failure, not an empty list, when the load fails", async () => {
    setSession({ id: 1, isFinance: true });
    mockFetchJson({});
    renderWithProviders(<MailAliasesPage />);

    expect(await screen.findByText("Couldn't load mail aliases")).toBeInTheDocument();
    expect(screen.queryByText("No aliases yet.")).not.toBeInTheDocument();
  });

  it("fetches nothing for anyone else", () => {
    setSession({ id: 2, isKeyholder: true });
    const fetchMock = mockFetchJson({});
    renderWithProviders(<MailAliasesPage />);

    expect(router.push).toHaveBeenCalledWith("/");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
