import { screen } from "@testing-library/react";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import { renderWithProviders, resetRtl } from "@/test-helpers/rtl";
import ExternalActionPanel from "../ExternalActionPanel";

beforeEach(() => resetRtl());

const external = {
  contractSigned: true,
  contractStarted: true,
  signerName: "Pat",
  contractSignedAt: "2026-10-01T18:00:00Z",
  checkStarted: false,
  bgCleared: false,
  deepLinkUrl: null,
};

describe("ExternalActionPanel", () => {
  it("dates the signature in the org's configured zone", () => {
    renderWithProviders(
      <ExternalActionPanel external={external} isRenewal={false} saving={false} onSign={jest.fn()} onRefresh={jest.fn()} />,
      { wrapper: ({ children }) => <TimezoneProvider value="Asia/Tokyo">{children}</TimezoneProvider> },
    );
    expect(screen.getByText("Signed by Pat, Oct 2, 2026.")).toBeInTheDocument();
  });
});
