type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock({ followUrl: true }));

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl, setSearchParams } from "@/test-helpers/rtl";
import { readsOf, reconnectAfterDedupe, unrelatedWrite } from "@/test-helpers/loadReads";
import { PastPaymentPlanDecisions } from "../PastPaymentPlanDecisions";

beforeEach(() => resetRtl());
afterEach(() => jest.useRealTimers());

const ENDPOINT = "/api/finance-ops/membership-payment-plans/past";
const FIRST = `${ENDPOINT}?page=0`;
const render = () => renderWithProviders(<PastPaymentPlanDecisions endpoint={ENDPOINT} identityColumns={[]} />);

describe("PastPaymentPlanDecisions", () => {
  it("hides archived families by default", async () => {
    const fetchMock = mockFetchJson({ [ENDPOINT]: [] });
    render();
    const box = await screen.findByLabelText("Show archived families");
    expect(box).not.toBeChecked();
    await waitFor(() => expect(readsOf(fetchMock, FIRST)).toHaveLength(1));
  });

  it("asks for archived families once ticked, and keeps it in the URL from page 1", async () => {
    setSearchParams("page=3");
    const fetchMock = mockFetchJson({ [ENDPOINT]: [] });
    render();
    await waitFor(() => expect(readsOf(fetchMock, `${ENDPOINT}?page=2`)).toHaveLength(1));

    fireEvent.click(await screen.findByLabelText("Show archived families"));

    await waitFor(() => expect(readsOf(fetchMock, `${ENDPOINT}?page=0&archived=1`)).toHaveLength(1));
    expect(screen.getByLabelText("Show archived families")).toBeChecked();
  });

  it("reads the page once on mount and not again on reconnect", async () => {
    jest.useFakeTimers();
    const fetchMock = mockFetchJson({ [ENDPOINT]: [] });
    render();
    await screen.findByText("No decided requests.");

    await reconnectAfterDedupe();
    expect(readsOf(fetchMock, FIRST)).toHaveLength(1);
  });

  it("does not re-read after another page's write", async () => {
    const fetchMock = mockFetchJson({ [ENDPOINT]: [], "/api/unrelated": {} });
    render();
    await screen.findByText("No decided requests.");

    await unrelatedWrite();
    expect(readsOf(fetchMock, FIRST)).toHaveLength(1);
  });

  it("shows a failed load in place of the table, not an empty list", async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ error: "Server down" }), { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    render();

    expect(await screen.findByText(/Server down/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("No decided requests.")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
