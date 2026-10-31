import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import OrgItemsPage from "@checkin/local-inventory/pages/orgItems";

const mockApi = jest.fn();
const LOADED = {
  id: 1, gtin13: "0000000000017", existingQuantity: 2, desiredQuantity: 4,
  locationId: 7, backstockLocationId: null, location: { id: 7, name: "Bin" }, backstockLocation: null,
};

jest.mock("@checkin/local-inventory/components/api", () => ({
  ...jest.requireActual("@checkin/local-inventory/components/api"),
  api: (...args: unknown[]) => mockApi(...args),
  useCanManage: () => true,
  useCatalogNames: () => new Map(),
  useLoad: (path: string) => ({
    data: path.startsWith("/org-items/count") ? { total: 1 } : path === "/locations" ? [{ id: 7, name: "Bin" }] : [LOADED],
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

function openEdit() {
  render(<MantineProvider><OrgItemsPage /></MantineProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
}
const desired = async () => screen.findByLabelText("Desired quantity");
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));
const putBody = () => {
  const put = mockApi.mock.calls.find(([, init]) => init?.method === "PUT");
  return JSON.parse(put?.[1].body);
};

describe("Org item edit form", () => {
  beforeEach(() => mockApi.mockReset());

  it("sends only the changed field, with the value it was loaded with", async () => {
    mockApi.mockResolvedValue(LOADED);
    openEdit();
    fireEvent.change(await desired(), { target: { value: "9" } });
    save();

    await waitFor(() => expect(putBody()).toEqual({ desiredQuantity: 9, expectedDesiredQuantity: 4 }));
  });

  it("after a refused save shows the other manager's value and checks against it", async () => {
    mockApi.mockRejectedValueOnce(new Error("This item changed since you loaded it"));
    mockApi.mockResolvedValue({ ...LOADED, desiredQuantity: 6 });
    openEdit();
    fireEvent.change(await desired(), { target: { value: "9" } });
    save();
    await waitFor(async () => expect(await desired()).toHaveValue("6"));

    mockApi.mockClear();
    fireEvent.change(await desired(), { target: { value: "8" } });
    save();

    await waitFor(() => expect(putBody()).toEqual({ desiredQuantity: 8, expectedDesiredQuantity: 6 }));
  });
});
