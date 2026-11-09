jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders, setSession, resetRtl } from "@/test-helpers/rtl";
import Items from "../items/page";
import LearnedReferences from "../learned-references/page";
import ReferenceConflicts from "../reference-conflicts/page";
import ItemReferenceProposals from "../item-reference-proposals/page";
import ProvisionalItems from "../provisional-items/page";

const fetched = () => (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url));

beforeEach(() => {
  resetRtl();
  setSession({ id: 3, isInventoryManager: true });
  global.fetch = jest.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
});

describe("catalog pages", () => {
  it("shows Items without inner tabs: references and conflicts have their own subtabs", async () => {
    renderWithProviders(<Items />);
    expect(await screen.findByLabelText("Search items")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(fetched().some((u) => u.includes("/reference-conflicts"))).toBe(false);
  });

  it("lists the learned references on their own page", async () => {
    renderWithProviders(<LearnedReferences />);
    expect(await screen.findByText("No references found.")).toBeInTheDocument();
    expect(fetched().some((u) => u.includes("/item-references?"))).toBe(true);
  });

  it("lists the reference conflicts on their own page", async () => {
    renderWithProviders(<ReferenceConflicts />);
    expect(await screen.findByText("No unresolved conflicts.")).toBeInTheDocument();
    expect(fetched().some((u) => u.includes("/reference-conflicts?"))).toBe(true);
  });

  it("lists the provisional item proposals on their own page", async () => {
    renderWithProviders(<ProvisionalItems />);
    await waitFor(() => expect(fetched().some((u) => u.includes("/provisional-items?"))).toBe(true));
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("refreshes the nav counts after an item reference proposal is approved", async () => {
    global.fetch = jest.fn(async (url: string) => new Response(
      JSON.stringify(url.includes("/proposals/item-references?")
        ? [{ id: 1, gtin13: "2000000000015", partNumber: "P-1", status: "pending", proposedAt: "2026-11-01T00:00:00Z", orgName: "Org", item: { name: "Saw" } }]
        : []),
      { status: 200 },
    )) as unknown as typeof fetch;
    const refreshed = jest.fn();
    window.addEventListener("nav-counts-mutated", refreshed);
    const { container } = renderWithProviders(<ItemReferenceProposals />);
    await screen.findByText("P-1");
    fireEvent.click(container.querySelector("table tbody button")!);
    await waitFor(() => expect(refreshed).toHaveBeenCalled());
    window.removeEventListener("nav-counts-mutated", refreshed);
  });
});
