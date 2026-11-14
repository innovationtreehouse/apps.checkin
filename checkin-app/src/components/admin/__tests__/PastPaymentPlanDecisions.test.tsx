// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories run hoisted, before imports exist
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock({ followUrl: true }));

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl, setSearchParams } from "@/test-helpers/rtl";
import { PastPaymentPlanDecisions } from "../PastPaymentPlanDecisions";

beforeEach(() => resetRtl());

const ENDPOINT = "/api/finance-ops/membership-payment-plans/past";
const render = () => renderWithProviders(<PastPaymentPlanDecisions endpoint={ENDPOINT} identityColumns={[]} />);

describe("PastPaymentPlanDecisions", () => {
  it("hides archived families by default", async () => {
    const fetchMock = mockFetchJson({ [ENDPOINT]: [] });
    render();
    const box = await screen.findByLabelText("Show archived families");
    expect(box).not.toBeChecked();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${ENDPOINT}?page=0`));
  });

  it("asks for archived families once ticked, and keeps it in the URL from page 1", async () => {
    setSearchParams("page=3");
    const fetchMock = mockFetchJson({ [ENDPOINT]: [] });
    render();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${ENDPOINT}?page=2`));

    fireEvent.click(await screen.findByLabelText("Show archived families"));

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(`${ENDPOINT}?page=0&archived=1`));
    expect(screen.getByLabelText("Show archived families")).toBeChecked();
  });
});
