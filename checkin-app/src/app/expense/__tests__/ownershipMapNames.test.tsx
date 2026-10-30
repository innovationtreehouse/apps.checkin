import { render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import OwnershipMapPage from "@checkin/expense/pages/ownershipMap";

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
      Item: [{ gtin13: "0012345678905", name: "Hex bolt M6" }],
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
});
