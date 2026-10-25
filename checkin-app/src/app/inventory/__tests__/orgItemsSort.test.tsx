import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import OrgItemsPage from "@checkin/local-inventory/pages/orgItems";

const loaded: string[] = [];

jest.mock("@checkin/local-inventory/components/api", () => ({
  ...jest.requireActual("@checkin/local-inventory/components/api"),
  useCanManage: () => false,
  useCatalogNames: () => new Map(),
  useLoad: (path: string | null) => {
    if (path) loaded.push(path);
    return { data: path?.startsWith("/org-items/count") ? { total: 0 } : [], error: null, reload: jest.fn() };
  },
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

/** The sortBy/sortDir of the last org-items list request. */
function lastOrder() {
  const list = loaded.filter((p) => p.startsWith("/org-items?")).at(-1) ?? "";
  const sp = new URLSearchParams(list.split("?")[1]);
  return [sp.get("sortBy"), sp.get("sortDir"), sp.get("page")];
}

const header = (name: string) => screen.getByRole("columnheader", { name });

describe("Org inventory table sort", () => {
  beforeEach(() => { loaded.length = 0; });

  it("lists by part number ascending until a header is clicked", () => {
    render(<MantineProvider><OrgItemsPage /></MantineProvider>);
    expect(lastOrder()).toEqual(["gtin13", "asc", "1"]);
    expect(header("Part No.")).toHaveAttribute("aria-sort", "ascending");
  });

  it("sorts by a clicked column, and reverses on a second click", () => {
    render(<MantineProvider><OrgItemsPage /></MantineProvider>);
    fireEvent.click(header("Location"));
    expect(lastOrder()).toEqual(["location", "asc", "1"]);
    expect(header("Location")).toHaveAttribute("aria-sort", "ascending");
    expect(header("Part No.")).toHaveAttribute("aria-sort", "none");

    fireEvent.click(header("Location"));
    expect(lastOrder()).toEqual(["location", "desc", "1"]);
    expect(header("Location")).toHaveAttribute("aria-sort", "descending");

    fireEvent.click(header("Backstock"));
    expect(lastOrder()).toEqual(["backstock", "asc", "1"]);
  });

  it("leaves Name, Have and Desired unsortable", () => {
    render(<MantineProvider><OrgItemsPage /></MantineProvider>);
    for (const name of ["Name", "Have", "Desired"]) expect(header(name)).not.toHaveAttribute("aria-sort");
  });
});
