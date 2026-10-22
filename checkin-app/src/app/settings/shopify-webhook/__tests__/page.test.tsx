type Rtl = typeof import("@/test-helpers/rtl");
jest.mock("next/navigation", () => jest.requireActual<Rtl>("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual<Rtl>("@/test-helpers/rtl").authMock());

import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, setSession, resetRtl } from "@/test-helpers/rtl";
import ShopifyWebhookSettingsPage from "../page";

const receipt = {
    id: 1,
    receivedAt: "2026-10-01T12:00:00Z",
    topic: "orders/paid",
    shopDomain: "store.test",
    hmacValid: false,
    test: true,
    orderId: null,
    deliveryId: null,
    triggeredAt: null,
    retry: null,
    outcome: "rejected: bad signature",
};

beforeEach(() => resetRtl());

describe("ShopifyWebhookSettingsPage", () => {
    it("shows the failure message when the status load fails", async () => {
        setSession({ id: 1, isSysadmin: true });
        mockFetchJson({});
        renderWithProviders(<ShopifyWebhookSettingsPage />);

        expect(await screen.findByText("Failed to load webhook status.")).toBeInTheDocument();
    });

    it("Refresh re-fetches and shows the new deliveries", async () => {
        setSession({ id: 1, isSysadmin: true });
        let receipts: (typeof receipt)[] = [];
        const fetchMock = mockFetchJson({
            "/api/settings/shopify-webhook": () => ({ webhookUrl: "https://app.test/api/webhooks/shopify", storeDomain: null, receipts }),
        });
        renderWithProviders(<ShopifyWebhookSettingsPage />);

        expect(await screen.findByText(/No deliveries recorded/)).toBeInTheDocument();

        const loadsBefore = fetchMock.mock.calls.length;
        receipts = [receipt];
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

        expect(await screen.findByText("rejected: bad signature")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(loadsBefore + 1);
    });

    it("shows the delivery id and flags a retried delivery", async () => {
        setSession({ id: 1, isSysadmin: true });
        mockFetchJson({
            "/api/settings/shopify-webhook": () => ({
                webhookUrl: "https://app.test/api/webhooks/shopify",
                storeDomain: null,
                receipts: [{ ...receipt, id: 2, hmacValid: true, deliveryId: "delivery-1", triggeredAt: "2026-10-01T11:59:58Z", retry: true, outcome: "already settled" }],
            }),
        });
        renderWithProviders(<ShopifyWebhookSettingsPage />);

        expect(await screen.findByText("delivery-1")).toBeInTheDocument();
        expect(screen.getByText("retry")).toBeInTheDocument();
    });

    it("shows a malformed trigger time raw instead of Invalid Date", async () => {
        setSession({ id: 1, isSysadmin: true });
        mockFetchJson({
            "/api/settings/shopify-webhook": () => ({
                webhookUrl: "https://app.test/api/webhooks/shopify",
                storeDomain: null,
                receipts: [{ ...receipt, id: 3, deliveryId: "delivery-2", triggeredAt: "not-a-date" }],
            }),
        });
        renderWithProviders(<ShopifyWebhookSettingsPage />);

        expect(await screen.findByText("delivery-2")).toHaveAttribute("title", "Triggered at not-a-date");
    });
});
