jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());

import { fireEvent, screen, within } from "@testing-library/react";
import { ItemReferencesModal, type ItemReferenceRow, type ItemRow } from "@checkin/global-catalog/components";
import { mockFetchJson, renderWithProviders, resetRtl } from "@/test-helpers/rtl";

const ITEM: ItemRow = {
  gtin13: "2000000000015", name: "Bolt", categoryId: 1, subcategoryId: 1, sequence: 1, usageBehavior: "Durable",
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", archivedAt: null,
  category: { name: "Fasteners", letter: "F" }, subcategory: { name: "Bolts", number: 1 },
};
const ref = (id: number, partNumber: string, retailer: string | null, manufacturer: string | null): ItemReferenceRow => ({
  id, gtin13: ITEM.gtin13, partNumber, descriptionNormalized: null, manufacturer,
  retailer, url: null, conversionFactor: 1, conversionVersion: 1, archivedAt: null,
});
const REFS = [
  ref(1, "STORE-1", "Hardware Co", null),
  ref(2, "MFR-1", null, "Acme"),
  ref(3, "BOTH-1", "Hardware Co", "Acme"),
  ref(4, "BARE-1", null, null),
];

const cellOf = (partNumber: string) => screen.getByText(partNumber).closest("td");

beforeEach(() => {
  resetRtl();
  mockFetchJson({ "/item-references": REFS });
});

describe("the References dialog names which number a part number is", () => {
  it("labels each row by the key it pairs with, retailer first", async () => {
    renderWithProviders(<ItemReferencesModal item={ITEM} opened onClose={() => {}} canEdit={false} />);
    await screen.findByText("STORE-1");
    expect(cellOf("STORE-1")).toHaveTextContent(/^Store part #STORE-1$/);
    expect(cellOf("MFR-1")).toHaveTextContent(/^Mfr part #MFR-1$/);
    expect(cellOf("BOTH-1")).toHaveTextContent(/^Store part #BOTH-1$/);
    expect(cellOf("BARE-1")).toHaveTextContent(/^Part #BARE-1$/);
  });

  it("labels the part number field the same way while editing a row", async () => {
    renderWithProviders(<ItemReferencesModal item={ITEM} opened onClose={() => {}} canEdit />);
    await screen.findByText("MFR-1");
    const row = cellOf("MFR-1")!.closest("tr")!;
    const edit = within(row).getAllByRole("button").find((b) => b.querySelector(".tabler-icon-edit"));
    fireEvent.click(edit!);
    expect(await screen.findByLabelText("Mfr part #")).toHaveValue("MFR-1");
  });
});
