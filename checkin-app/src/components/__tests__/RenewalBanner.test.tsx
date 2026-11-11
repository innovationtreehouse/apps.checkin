// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());

import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import { ViewerProvider } from "@checkin/component-ui";
import RenewalBanner from "../RenewalBanner";

const TITLE = "Membership renewal due";
const DUE = "2027-01-01";

beforeEach(() => {
  resetRtl();
  sessionStorage.clear();
  setSession({ id: 1 });
});

describe("RenewalBanner", () => {
  it("renders the yellow renewal alert with the due date when renewalDue", async () => {
    mockFetchJson({ "/api/membership/renewal-status": { renewalDue: true, dueDate: DUE } });
    renderWithProviders(<RenewalBanner />);

    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`up for renewal by ${DUE}`))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Renew now/i })).toBeInTheDocument();
  });

  it("renders nothing when renewalDue is false", async () => {
    mockFetchJson({ "/api/membership/renewal-status": { renewalDue: false } });
    renderWithProviders(<RenewalBanner />);

    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument());
  });

  it("fetches nothing for a signed-out visitor", () => {
    setSession(null);
    const fetchSpy = mockFetchJson({});
    renderWithProviders(<RenewalBanner />);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a 401 stays silent: no redirect, no retry, no banner", async () => {
    const fetchSpy = jest.fn(async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: "Unauthorized" }) }) as Response);
    global.fetch = fetchSpy as unknown as typeof fetch;
    const expired = jest.fn();
    renderWithProviders(
      <ViewerProvider viewer={null} onSessionExpired={expired}>
        <RenewalBanner />
      </ViewerProvider>,
    );

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(expired).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stays hidden when dismissed for the session, even if renewalDue", async () => {
    sessionStorage.setItem("renewal_banner_dismissed", "true");
    mockFetchJson({ "/api/membership/renewal-status": { renewalDue: true, dueDate: DUE } });
    renderWithProviders(<RenewalBanner />);

    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument());
  });

  it("dismissing records the skip in sessionStorage and hides the banner", async () => {
    mockFetchJson({ "/api/membership/renewal-status": { renewalDue: true, dueDate: DUE } });
    renderWithProviders(<RenewalBanner />);

    const alert = await screen.findByText(TITLE);
    // Mantine's Alert close button has no accessible name; grab it by its class.
    fireEvent.click(alert.closest(".mantine-Alert-root")!.querySelector(".mantine-Alert-closeButton")!);

    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument());
    expect(sessionStorage.getItem("renewal_banner_dismissed")).toBe("true");
  });
});
