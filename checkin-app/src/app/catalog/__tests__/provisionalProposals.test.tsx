jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { ProvisionalProposalsClient } from "@checkin/global-catalog/components";
import { renderWithProviders, resetRtl, setSession } from "@/test-helpers/rtl";

const PROPOSAL = {
  id: 9,
  provisionalGtin13: "2990000000123",
  orgId: "org-1",
  orgName: "Treehouse",
  proposedName: "Hex bolt",
  proposedCategoryId: 1,
  proposedSubcategoryId: 2,
  proposedUsageBehavior: "consumable",
  partNumber: "HB-10",
  manufacturer: "Acme",
  retailer: "Hardware Co",
  proposedAt: "2026-10-01T00:00:00Z",
  status: "pending",
  resultGtin13: null,
  conversionFactor: 12,
};
const ITEM = {
  gtin13: "0200030200427",
  name: "Hex bolt M6",
  category: { name: "Fasteners", letter: "B" },
  subcategory: { name: "Bolts", number: 3 },
};

function serve() {
  const calls: { url: string; init?: RequestInit }[] = [];
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    calls.push({ url: path, init });
    if (init?.method === "POST") return new Response("{}", { status: 200 });
    if (path.includes("/provisional-items?")) return new Response(JSON.stringify([PROPOSAL]), { status: 200 });
    if (path.includes("/items?")) return new Response(JSON.stringify([ITEM]), { status: 200 });
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => resetRtl());
afterEach(() => act(() => notifications.clean()));

describe("provisional items queue", () => {
  it("shows the proposal's part number, manufacturer, retailer and factor on its row", async () => {
    setSession({ id: 3, isInventoryManager: true });
    serve();
    renderWithProviders(<ProvisionalProposalsClient />);
    const row = (await screen.findByText("Hex bolt")).closest("tr")!;
    expect(within(row).getByText(/HB-10/)).toBeInTheDocument();
    expect(within(row).getByText(/Acme/)).toBeInTheDocument();
    expect(within(row).getByText("Hardware Co")).toBeInTheDocument();
    expect(within(row).getByText("×12")).toBeInTheDocument();
  });

  it("links to an item picked from a catalog search prefilled with the proposed name", async () => {
    setSession({ id: 3, isInventoryManager: true });
    const calls = serve();
    renderWithProviders(<ProvisionalProposalsClient />);
    fireEvent.click(await screen.findByRole("button", { name: "Map to existing item" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("textbox", { name: /Search the catalog/ })).toHaveValue("Hex bolt");
    expect(within(dialog).getByText(/HB-10/)).toBeInTheDocument();
    const choice = await within(dialog).findByRole("radio", { name: /Hex bolt M6 · Fasteners \/ Bolts · 03B0042/ });
    expect(calls.some((c) => c.url.includes("/api/catalog/items?q=Hex%20bolt"))).toBe(true);

    const mapButton = within(dialog).getByRole("button", { name: "Map Item" });
    expect(mapButton).toBeDisabled();
    fireEvent.click(choice);
    fireEvent.click(mapButton);

    await waitFor(() => expect(calls.find((c) => c.init?.method === "POST")).toBeDefined());
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toContain("/api/catalog/provisional-items/9/map-to-existing");
    expect(JSON.parse(String(post.init?.body))).toEqual({ realGtin13: ITEM.gtin13 });
  });

  it.each([
    ["Approve", "Approve & Create Item", null],
    ["Reject", "Reject", "Duplicate"],
    ["Map to existing item", "Map Item", null],
  ])("reloads the queue and the nav counts after %s", async (action, confirm, reason) => {
    setSession({ id: 3, isInventoryManager: true });
    const calls = serve();
    const refreshed = jest.fn();
    window.addEventListener("nav-counts-mutated", refreshed);
    renderWithProviders(<ProvisionalProposalsClient />);
    fireEvent.click(await screen.findByRole("button", { name: action }));
    const dialog = await screen.findByRole("dialog");
    if (reason) fireEvent.change(within(dialog).getByRole("textbox", { name: /Reason/ }), { target: { value: reason } });
    if (action === "Map to existing item") fireEvent.click(await within(dialog).findByRole("radio", { name: /Hex bolt M6/ }));
    const listLoads = () => calls.filter((c) => c.url.includes("/provisional-items?")).length;
    const before = listLoads();
    fireEvent.click(within(dialog).getByRole("button", { name: confirm }));

    await waitFor(() => expect(listLoads()).toBeGreaterThan(before));
    expect(refreshed).toHaveBeenCalled();
    window.removeEventListener("nav-counts-mutated", refreshed);
  });

  it("offers no actions to a viewer who cannot manage the catalog", async () => {
    setSession({ id: 4 });
    serve();
    renderWithProviders(<ProvisionalProposalsClient />);
    const row = (await screen.findByText("Hex bolt")).closest("tr")!;
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument();
  });
});
