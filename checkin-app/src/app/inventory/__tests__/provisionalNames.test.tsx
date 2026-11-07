import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import OrgItemsPage from "@checkin/local-inventory/pages/orgItems";
import ReceiveQueuePage from "@checkin/local-inventory/pages/receiveQueue";

const PROVISIONAL = "0200000000011";
const provisionals = [{ provisionalGtin13: PROVISIONAL, name: "Widget" }];
const orgItem = {
  id: 1, gtin13: PROVISIONAL, existingQuantity: 2, desiredQuantity: 0,
  locationId: null, backstockLocationId: null, location: null, backstockLocation: null,
};
const queueLine = {
  id: 7, gtin13: PROVISIONAL, quantity: 3, retailer: "Acme", queuedAt: "2026-10-01T00:00:00Z",
  fulfilledAt: null, cancelledAt: null, cancelReason: null,
};

jest.mock("@checkin/local-inventory/components/api", () => ({
  ...jest.requireActual("@checkin/local-inventory/components/api"),
  useCanManage: () => false,
  useCatalogNames: () => new Map(),
  useLoad: (path: string) => ({
    data: path.startsWith("/org-items/count") ? { total: 1 }
      : path.startsWith("/org-items") ? { OrgItem: [orgItem], InventoryProvisionalItem: provisionals }
      : path.startsWith("/receive-queue") ? { ReceiveQueue: [queueLine], InventoryProvisionalItem: provisionals }
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

it.each([
  ["org items", OrgItemsPage],
  ["the receive queue", ReceiveQueuePage],
])("%s names a provisional part the catalog doesn't know", (_, Page) => {
  render(<MantineProvider><Page /></MantineProvider>);
  expect(screen.getByText("Widget")).toBeInTheDocument();
});
