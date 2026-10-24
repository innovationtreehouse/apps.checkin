import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { SectionTabs, activeTab } from "@/components/ui/SectionTabs";

const push = jest.fn();
let mockPathname = "/program-ops";
const confirmNav = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => mockPathname,
}));
jest.mock("@/components/UnsavedChangesProvider", () => ({
  useConfirmNav: () => confirmNav,
}));

beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList);
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ||
    (class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver);
});

const LINKS = [
  { name: "Programs", href: "/program-ops" },
  { name: "Events", href: "/program-ops/events" },
];

const renderTabs = () =>
  render(
    <MantineProvider>
      <SectionTabs links={LINKS} prefixMatch />
    </MantineProvider>,
  );

beforeEach(() => {
  push.mockClear();
  confirmNav.mockReset();
  mockPathname = "/program-ops";
});

describe("SectionTabs guarded onChange", () => {
  it("navigates when confirmNav allows it", () => {
    confirmNav.mockReturnValue(true);
    renderTabs();
    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    expect(confirmNav).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/program-ops/events");
  });

  it("blocks navigation when confirmNav returns false (unsaved changes)", () => {
    confirmNav.mockReturnValue(false);
    renderTabs();
    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    expect(confirmNav).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("no-ops (no confirm prompt) when clicking the already-active tab", () => {
    confirmNav.mockReturnValue(true);
    renderTabs();
    fireEvent.click(screen.getByRole("tab", { name: "Programs" }));
    expect(confirmNav).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

// #1155: without min-width:max-content the tab row shrinks to the ScrollArea instead of
// overflowing it, and the count Badge (overflow:hidden, so its automatic minimum size is
// 0) collapses to zero width — the pill renders as an empty capsule. jsdom does no
// layout, so this asserts the style that prevents it rather than the resulting width.
describe("SectionTabs tab row sizing", () => {
  it("sizes the tab list to its content so count pills can't be squeezed to zero", () => {
    confirmNav.mockReturnValue(true);
    const { container } = renderTabs();
    const list = container.querySelector(".mantine-Tabs-list") as HTMLElement;
    expect(list.style.minWidth).toBe("max-content");
    expect(list.style.flexWrap).toBe("nowrap");
  });
});

describe("activeTab", () => {
  const GROUPED = [
    { name: "Plans", href: "/finance-ops/payment-plan" },
    {
      name: "Shopify",
      href: "/finance-ops/shopify-holds",
      subLinks: [
        { name: "Holds", href: "/finance-ops/shopify-holds" },
        { name: "Payments", href: "/finance-ops/payments" },
      ],
    },
  ];

  it("selects a grouped tab from any of its sub-link pages", () => {
    expect(activeTab(GROUPED, "/finance-ops/payments", true)?.name).toBe("Shopify");
    expect(activeTab(GROUPED, "/finance-ops/payments/7", true)?.name).toBe("Shopify");
    expect(activeTab(GROUPED, "/finance-ops/payment-plan", true)?.name).toBe("Plans");
  });

  it("matches exactly without prefixMatch", () => {
    expect(activeTab(GROUPED, "/finance-ops/payments/7")).toBeUndefined();
    expect(activeTab(GROUPED, "/finance-ops/payments")?.name).toBe("Shopify");
  });

  it("prefers the longest matching href", () => {
    expect(activeTab(LINKS, "/program-ops/events/3", true)?.name).toBe("Events");
    expect(activeTab(LINKS, "/program-ops/other", true)?.name).toBe("Programs");
  });
});
