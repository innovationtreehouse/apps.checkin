import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DevBgConsentClient from "../bg-consent/DevBgConsentClient";
import DevZohoSignClient from "../zoho-sign/DevZohoSignClient";

const push = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const okFetch = () =>
  jest.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

afterEach(() => {
  push.mockClear();
  jest.restoreAllMocks();
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
