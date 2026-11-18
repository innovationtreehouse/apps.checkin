jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock({ followUrl: true }));
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { paged } from "@checkin/component-ui";
import AccountMapPage from "@checkin/bulk-donation/pages/accountMap";
import { resetRtl } from "@/test-helpers/rtl";

let mockLoads: Record<string, unknown> = {};

jest.mock("@checkin/bulk-donation/components/api", () => ({
  useLoad: (path: string | null) => ({ data: path ? mockLoads[path] ?? null : null, error: null, reload: () => {} }),
  useCanWrite: () => true,
  paged: jest.requireActual("@checkin/component-ui").paged,
  api: jest.fn(),
  act: jest.fn(),
}));

beforeAll(() => {
  window.matchMedia ||= ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }) as unknown as MediaQueryList);
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ||= () => {};
});

beforeEach(() => {
  resetRtl();
  mockLoads = {
    [paged("/account-map", 1)]: [{
      id: 3, companyName: "*", corporatePeerCampaign: "*", donationMethod: null, donationType: null,
      donationAccount: "", matchAccount: "", donationAccountId: "601", matchAccountId: null,
    }],
    "/api/books-map/quickbooks-accounts": [
      { id: "600", name: "Donations:Benevity", accountType: "Income", active: true },
      { id: "601", name: "Donations:Old drive", accountType: "Income", active: false },
    ],
  };
});

describe("Donation account map: inactive QuickBooks accounts", () => {
  it("offers no inactive account, and warns beside the picker holding one", async () => {
    render(<MantineProvider><AccountMapPage /></MantineProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const warning = within(dialog).getByText("Donations:Old drive is inactive in QuickBooks. Pick an active one.").closest<HTMLElement>("[role=alert]")!;
    expect(within(warning).getByRole("button", { name: "Update now" })).toBeInTheDocument();
    const picker = within(dialog).getByRole("textbox", { name: "Donation account" });
    expect(picker).toHaveValue("");
    fireEvent.click(picker);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Donations:Benevity"]);
  });
});
