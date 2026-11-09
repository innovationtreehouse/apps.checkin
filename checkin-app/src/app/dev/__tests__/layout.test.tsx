import { screen } from "@testing-library/react";
import { renderWithProviders, resetRtl, setCheckinEnv, setDevMocks } from "@/test-helpers/rtl";
import type { DevMocks } from "@/lib/nav/sections/devTools";
import DevToolsLayout from "../layout";

jest.mock("next/navigation", () => ({
  usePathname: () => "/dev/sent-mail",
  useRouter: () => ({ push: jest.fn() }),
}));

function renderLayout(mocks: DevMocks) {
  setCheckinEnv("dev");
  setDevMocks(mocks);
  renderWithProviders(<DevToolsLayout>page</DevToolsLayout>);
}

afterEach(() => resetRtl());

describe("dev tools tabs", () => {
  it("hides the Shopify and BG Check tabs when their mocks are off", () => {
    renderLayout({ shopify: false, bgConsent: false });
    expect(screen.getByRole("tab", { name: "Email" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Shopify" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "BG Check" })).not.toBeInTheDocument();
  });

  it("shows the Shopify tab when the Shopify mock is active", () => {
    renderLayout({ shopify: true, bgConsent: false });
    expect(screen.getByRole("tab", { name: "Shopify" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "BG Check" })).not.toBeInTheDocument();
  });

  it("shows the BG Check tab when the background-check mock is active", () => {
    renderLayout({ shopify: false, bgConsent: true });
    expect(screen.getByRole("tab", { name: "BG Check" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Shopify" })).not.toBeInTheDocument();
  });
});
