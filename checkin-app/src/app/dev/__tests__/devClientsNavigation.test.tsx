import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { notifications, notificationsStore } from "@mantine/notifications";
import DevBgConsentClient from "../bg-consent/DevBgConsentClient";
import DevShopifyClient from "../shopify/DevShopifyClient";
import DevZohoSignClient from "../zoho-sign/DevZohoSignClient";

const push = jest.fn();
const refresh = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

const okFetch = () =>
  jest.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

const refuse = (error: string) =>
  jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error }), { status: 409 }));

const shownError = () => notificationsStore.getState().notifications[0];

afterEach(() => {
  push.mockClear();
  refresh.mockClear();
  jest.restoreAllMocks();
  act(() => notifications.clean());
});

describe("dev mock clients navigate back to /membership", () => {
  it("bg-consent lands on /membership after recording consent", async () => {
    okFetch();
    render(<DevBgConsentClient />);
    fireEvent.click(screen.getByRole("button", { name: /Consent to background check/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/membership"));
  });

  it("zoho-sign complete lands on /membership?signed=1", async () => {
    okFetch();
    render(<DevZohoSignClient rid="r1" />);
    fireEvent.click(screen.getByRole("button", { name: /Complete signing/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/membership?signed=1"));
  });

  it("zoho-sign decline lands on /membership?declined=1", () => {
    render(<DevZohoSignClient rid="r1" />);
    fireEvent.click(screen.getByRole("button", { name: /Decline/ }));
    expect(push).toHaveBeenCalledWith("/membership?declined=1");
  });
});

describe("dev mock clients show a refused write as an error message", () => {
  it("zoho-sign complete stays put", async () => {
    refuse("No such signing request");
    render(<DevZohoSignClient rid="r1" />);
    fireEvent.click(screen.getByRole("button", { name: /Complete signing/ }));
    await waitFor(() => expect(shownError()).toMatchObject({ message: "No such signing request", color: "red" }));
    expect(push).not.toHaveBeenCalled();
  });

  it("zoho-sign start stays put", async () => {
    refuse("No application in flight");
    render(<DevZohoSignClient rid={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Start \/ resume signing/ }));
    await waitFor(() => expect(shownError()).toMatchObject({ message: "No application in flight", color: "red" }));
    expect(screen.getByRole("button", { name: /Start \/ resume signing/ })).toBeEnabled();
  });

  it("shopify keeps the row and refreshes nothing", async () => {
    refuse("Process 5 is not awaiting payment");
    render(<DevShopifyClient hasVariant processes={[{ id: 5, household: "The Smiths", isVolunteerFamily: false }]} enrollments={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Fire orders/paid" }));
    await waitFor(() => expect(shownError()).toMatchObject({ message: "Process 5 is not awaiting payment", color: "red" }));
    expect(refresh).not.toHaveBeenCalled();
  });
});
