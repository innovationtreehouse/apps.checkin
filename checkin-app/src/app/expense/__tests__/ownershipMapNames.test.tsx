jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock({ followUrl: true }));
import { render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import OwnershipMapPage from "@checkin/expense/pages/ownershipMap";
import { resetRtl } from "@/test-helpers/rtl";

beforeEach(() => resetRtl());

const BANNER = "Item names couldn't be loaded from the catalog. Showing Part IDs.";
let catalogDown = false;

jest.mock("@checkin/expense/components/api", () => ({
  PAGE_SIZE: 50,
  paged: (path: string, page: number) => `${path}?page=${page}`,
  send: jest.fn(),
  useRoles: () => ({ isFinance: false }),
  useLoad: () => ({
    data: {
      PartOwnerMap: [
        { id: 1, gtin13: "0012345678905", ownerId: 7 },
        { id: 2, gtin13: "0098765432109", ownerId: 7 },
      ],
      Item: catalogDown ? [] : [{ gtin13: "0012345678905", name: "Hex bolt M6" }],
      ...(catalogDown && { ExpenseCatalogNames: { unavailable: true } }),
      ExpenseBucketView: [{ id: 7, name: "Woodshop", archivedAt: null }],
    },
    error: null,
    reload: () => {},
  }),
}));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
});

afterEach(() => { catalogDown = false; });

describe("part buckets", () => {
  it("names each part from the catalog, with its GTIN as secondary text", () => {
    render(<MantineProvider><OwnershipMapPage /></MantineProvider>);
    const named = screen.getByText("Hex bolt M6").closest("tr")!;
    expect(within(named).getByText("0012345678905")).toBeInTheDocument();
    expect(within(named).getByText("Woodshop")).toBeInTheDocument();
  });

  it("shows the GTIN alone for a part the catalog has no name for", () => {
    render(<MantineProvider><OwnershipMapPage /></MantineProvider>);
    const unnamed = screen.getByText("0098765432109").closest("tr")!;
    expect(within(unnamed).getAllByRole("cell")[0]).toHaveTextContent(/^0098765432109$/);
  });

  it("shows no banner while the catalog answers", () => {
    render(<MantineProvider><OwnershipMapPage /></MantineProvider>);
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it("shows the banner and Name unavailable on each row when the catalog couldn't be read", () => {
    catalogDown = true;
    render(<MantineProvider><OwnershipMapPage /></MantineProvider>);
    expect(screen.getByText(BANNER)).toBeInTheDocument();
    for (const gtin of ["0012345678905", "0098765432109"]) {
      const row = screen.getByText(gtin).closest("tr")!;
      expect(within(row).getAllByRole("cell")[0]).toHaveTextContent(`Name unavailable${gtin}`);
    }
  });
});
