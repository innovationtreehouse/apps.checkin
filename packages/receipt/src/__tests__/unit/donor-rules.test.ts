import { describe, expect, it } from "vitest";
import { DONOR_NAME_MAX, InKindDonorSchema } from "@checkin/receipt-types";
import { DonorInputSchema } from "../../lib/schemas";
import { InKindDonorSchema as SentDonorSchema } from "../../contract";

const long = "x".repeat(DONOR_NAME_MAX + 1);
const donors = [
  { firstName: "Jane", lastName: "Doe", companyName: null },
  { firstName: " Jane ", lastName: "Doe", companyName: " Acme " },
  { firstName: "", lastName: "Doe", companyName: null },
  { firstName: "Jane", lastName: "   ", companyName: null },
  { firstName: long, lastName: "Doe", companyName: null },
  { firstName: "Jane", lastName: "Doe", companyName: "c".repeat(201) },
];

describe("X13 donor rules", () => {
  it("the sender checks the donor with the shared schema", () => {
    expect(SentDonorSchema).toBe(InKindDonorSchema);
  });

  it.each(donors)("upload accepts a typed donor exactly when donations would: %o", (donor) => {
    const atInput = DonorInputSchema.safeParse(donor);
    const atCallee = InKindDonorSchema.safeParse(donor);
    expect(atInput.success).toBe(atCallee.success);
    if (atInput.success && atCallee.success) expect(atInput.data).toEqual(atCallee.data);
  });
});
