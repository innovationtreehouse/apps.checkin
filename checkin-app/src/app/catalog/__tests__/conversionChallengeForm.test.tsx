jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { notifications, notificationsStore } from "@mantine/notifications";
import { ItemReferencesModal, type ItemReferenceRow, type ItemRow } from "@checkin/global-catalog/components";
import { mockFetchJson, renderWithProviders, resetRtl } from "@/test-helpers/rtl";

const ITEM: ItemRow = {
  gtin13: "2000000000015", name: "Bolt", categoryId: 1, subcategoryId: 1, sequence: 1, usageBehavior: "Durable",
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", archivedAt: null,
  category: { name: "Fasteners", letter: "F" }, subcategory: { name: "Bolts", number: 1 },
};
const REF: ItemReferenceRow = {
  id: 42, gtin13: ITEM.gtin13, partNumber: "B-1", descriptionNormalized: null, manufacturer: null,
  retailer: "Hardware Co", url: null, conversionFactor: 1, conversionVersion: 1, archivedAt: null,
};

function renderModal(canEdit: boolean, refs: ItemReferenceRow[] = [REF]) {
  const fetchMock = mockFetchJson({ "/conversion-challenges": { id: 1 }, "/item-references": refs });
  renderWithProviders(<ItemReferencesModal item={ITEM} opened onClose={() => {}} canEdit={canEdit} />);
  return fetchMock;
}

beforeEach(() => resetRtl());
afterEach(() => act(() => notifications.clean()));

describe("filing a conversion challenge from the References dialog", () => {
  it("posts the proposed factor and trimmed reason, then confirms", async () => {
    const fetchMock = renderModal(true);
    fireEvent.click(await screen.findByRole("button", { name: "Challenge" }));

    const submit = await screen.findByRole("button", { name: "File challenge" });
    fireEvent.change(screen.getByLabelText("Proposed factor"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "  Sold in 4-packs  " } });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Proposed factor"), { target: { value: "4" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(notificationsStore.getState().notifications[0]).toMatchObject({ message: "Challenge filed for review" }));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(String(post?.[0])).toContain("/api/catalog/conversion-challenges");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ itemReferenceId: 42, proposedFactor: 4, reason: "Sold in 4-packs" });
  });

  it("offers no Challenge to a viewer who can't manage the catalog", async () => {
    renderModal(false);
    await screen.findByText("Hardware Co");
    expect(screen.queryByRole("button", { name: "Challenge" })).toBeNull();
  });

  it("offers no Challenge on an archived reference", async () => {
    renderModal(true, [{ ...REF, archivedAt: "2026-10-01T00:00:00Z" }]);
    await screen.findByText("Hardware Co");
    expect(screen.queryByRole("button", { name: "Challenge" })).toBeNull();
  });
});
