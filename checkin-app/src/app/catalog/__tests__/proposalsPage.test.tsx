jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());
jest.mock("@/hooks/useTodoCounts", () => ({ useTodoCounts: jest.fn(() => null) }));

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders, setSession, resetRtl } from "@/test-helpers/rtl";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import Proposals from "../proposals/page";

beforeEach(() => {
  resetRtl();
  setSession({ id: 3, isInventoryManager: true });
  global.fetch = jest.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
});

describe("proposals page writes", () => {
  it("refreshes the nav counts after a proposal is approved", async () => {
    (useTodoCounts as jest.Mock).mockReturnValue(null);
    global.fetch = jest.fn(async (url: string) => new Response(
      JSON.stringify(url.includes("/proposals/item-references?")
        ? [{ id: 1, gtin13: "2000000000015", partNumber: "P-1", status: "pending", proposedAt: "2026-11-01T00:00:00Z", orgName: "Org", item: { name: "Saw" } }]
        : []),
      { status: 200 },
    )) as unknown as typeof fetch;
    const refreshed = jest.fn();
    window.addEventListener("nav-counts-mutated", refreshed);
    const { container } = renderWithProviders(<Proposals />);
    await screen.findByText("P-1");
    fireEvent.click(container.querySelector("table tbody button")!);
    await waitFor(() => expect(refreshed).toHaveBeenCalled());
    window.removeEventListener("nav-counts-mutated", refreshed);
  });
});

describe("proposals page tabs", () => {
  it("shows each queue's own pending count on its tab", () => {
    (useTodoCounts as jest.Mock).mockReturnValue({
      libraries: { catalog: { pendingProvisionalItems: 3, pendingItemReferences: 2 } },
    });
    renderWithProviders(<Proposals />);
    expect(screen.getByRole("tab", { name: /Provisional Items/ })).toContainElement(screen.getByLabelText("3 to review"));
    expect(screen.getByRole("tab", { name: /Item References/ })).toContainElement(screen.getByLabelText("2 to review"));
  });

  it("shows no pill for an empty queue or before the counts arrive", () => {
    (useTodoCounts as jest.Mock).mockReturnValue({ libraries: { catalog: { pendingProvisionalItems: 0 } } });
    const { unmount } = renderWithProviders(<Proposals />);
    expect(screen.queryByLabelText(/to review/)).not.toBeInTheDocument();
    unmount();
    (useTodoCounts as jest.Mock).mockReturnValue(null);
    renderWithProviders(<Proposals />);
    expect(screen.queryByLabelText(/to review/)).not.toBeInTheDocument();
  });
});
