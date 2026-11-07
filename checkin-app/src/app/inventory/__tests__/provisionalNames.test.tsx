import { render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import OrgItemsPage from "@checkin/local-inventory/pages/orgItems";
import ReceiveQueuePage from "@checkin/local-inventory/pages/receiveQueue";

const PROVISIONAL = "0200000000011";
const provisionals = [{ provisionalGtin13: PROVISIONAL, name: "Widget" }];
let gtin13 = PROVISIONAL;
const orgItem = () => ({
  id: 1, gtin13, existingQuantity: 2, desiredQuantity: 0,
  locationId: null, backstockLocationId: null, location: null, backstockLocation: null,
});
const queueLine = () => ({
  id: 7, gtin13, quantity: 3, retailer: "Acme", queuedAt: "2026-10-01T00:00:00Z",
  fulfilledAt: null, cancelledAt: null, cancelReason: null,
});

jest.mock("@checkin/local-inventory/components/api", () => ({
  ...jest.requireActual("@checkin/local-inventory/components/api"),
  useCanManage: () => false,
  useLoad: (path: string) => ({
    data: path.startsWith("/org-items/count") ? { total: 1 }
      : path.startsWith("/org-items") ? { OrgItem: [orgItem()], InventoryProvisionalItem: provisionals }
      : path.startsWith("/receive-queue") ? { ReceiveQueue: [queueLine()], InventoryProvisionalItem: provisionals }
      : [],
    error: null,
    reload: jest.fn(),
  }),
}));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const BANNER = "Item names couldn't be loaded from the catalog. Showing part numbers.";

/** Answers each catalog item read with the given status; 200 carries a name. */
const catalogAnswers = (status: number) =>
  jest.spyOn(global, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify(status === 200 ? { gtin13, name: "Wood glue" } : { error: "nope" }), { status }));

afterEach(() => {
  jest.restoreAllMocks();
  gtin13 = PROVISIONAL;
});

describe.each([
  ["org items", OrgItemsPage],
  ["the receive queue", ReceiveQueuePage],
])("%s", (_, Page) => {
  const wrap = () => render(<MantineProvider><Page /></MantineProvider>);

  it("names a provisional part the catalog doesn't know, with no banner", async () => {
    const fetch = catalogAnswers(404);
    wrap();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText("Widget")).toBeInTheDocument();
    expect(screen.queryByText("Not in catalog")).not.toBeInTheDocument();
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it("shows the catalog's name", async () => {
    gtin13 = "4006381333931";
    catalogAnswers(200);
    wrap();
    expect(await screen.findByText("Wood glue")).toBeInTheDocument();
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it("says Not in catalog for a part the catalog answers 404 for, with no banner", async () => {
    gtin13 = "4006381333931";
    catalogAnswers(404);
    wrap();
    expect(await screen.findByText("Not in catalog")).toBeInTheDocument();
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it("says Name unavailable and shows the banner when the catalog read fails", async () => {
    gtin13 = "4006381333931";
    catalogAnswers(500);
    wrap();
    expect(await screen.findByText("Name unavailable")).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();
  });
});

describe("the catalog names banner across pages", () => {
  const FAILS = "4006381333931";
  const LOADS = "4006381333948";
  const page = () => <MantineProvider><OrgItemsPage /></MantineProvider>;

  beforeEach(() => {
    jest.spyOn(global, "fetch").mockImplementation(async (input) => {
      const g = String(input).split("/").pop();
      return g === FAILS
        ? new Response(JSON.stringify({ error: "down" }), { status: 500 })
        : new Response(JSON.stringify({ gtin13: g, name: `Part ${g}` }), { status: 200 });
    });
  });

  it("drops the banner once every name on the next page has loaded", async () => {
    gtin13 = FAILS;
    const view = render(page());
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    gtin13 = LOADS;
    view.rerender(page());
    expect(await screen.findByText(`Part ${LOADS}`)).toBeInTheDocument();
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it("still names a part from an earlier page", async () => {
    gtin13 = LOADS;
    const view = render(page());
    expect(await screen.findByText(`Part ${LOADS}`)).toBeInTheDocument();
    gtin13 = FAILS;
    view.rerender(page());
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    gtin13 = LOADS;
    view.rerender(page());
    await waitFor(() => expect(screen.queryByText(BANNER)).not.toBeInTheDocument());
    expect(screen.getByText(`Part ${LOADS}`)).toBeInTheDocument();
  });
});
