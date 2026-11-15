import { KVA_SIGN_FIELDS, SIGN_FIELDS, toZohoFields } from "@/lib/membership/contract/signFields";

describe("signFields", () => {
    it("ports the five fields from the source-of-truth script", () => {
        expect(SIGN_FIELDS.map((f) => f.field_name)).toEqual([
            "Signature",
            "DateSigned",
            "PrintedName",
            "InsuranceCo",
            "PolicyNumber",
        ]);
    });

    it("gives the Key Volunteer Agreement name, signature and date only, all mandatory", () => {
        expect(KVA_SIGN_FIELDS.map((f) => f.field_name)).toEqual(["PrintedName", "Signature", "DateSigned"]);
        expect(KVA_SIGN_FIELDS.every((f) => f.is_mandatory)).toBe(true);
    });

    it("keeps every Key Volunteer field on the page and clear of the others", () => {
        for (const f of KVA_SIGN_FIELDS) {
            expect(f.x_pct + f.w_pct).toBeLessThanOrEqual(100);
            expect(f.y_pct + f.h_pct).toBeLessThanOrEqual(100);
        }
        const [name, sig, date] = KVA_SIGN_FIELDS;
        expect(name.y_pct + name.h_pct).toBeLessThanOrEqual(sig.y_pct);
        expect(sig.x_pct + sig.w_pct).toBeLessThanOrEqual(date.x_pct);
    });

    it("converts percentage coords to absolute (pct/100 × page size, rounded)", () => {
        const fields = toZohoFields(SIGN_FIELDS, "doc-1", 2, 612, 792);
        const sig = fields.find((f) => f.field_name === "Signature")!;
        // x 2% of 612 = 12.24 → 12 ; y 76% of 792 = 601.92 → 602
        expect(sig.x_coord).toBe(12);
        expect(sig.y_coord).toBe(602);
        expect(sig.abs_width).toBe(Math.round(0.54 * 612));
        expect(sig.abs_height).toBe(Math.round(0.08 * 792));
        expect(sig.document_id).toBe("doc-1");
        expect(sig.page_no).toBe(2);
    });

    it("emits only the fields of the layout it is given", () => {
        const fields = toZohoFields(KVA_SIGN_FIELDS, "d", 1, 612, 792);
        expect(fields.map((f) => f.field_name)).toEqual(["PrintedName", "Signature", "DateSigned"]);
        // Signature line on the KVA's page 2: x 21.9% of 612 = 134.03 → 134 ; y 84.1% of 792 = 666.07 → 666
        const sig = fields.find((f) => f.field_name === "Signature")!;
        expect(sig.x_coord).toBe(134);
        expect(sig.y_coord).toBe(666);
    });

    it("tags text fields with field_category and leaves sign/date untagged", () => {
        const fields = toZohoFields(SIGN_FIELDS, "d", 0, 600, 800);
        expect(fields.find((f) => f.field_name === "PrintedName")!.field_category).toBe("Textfield");
        expect(fields.find((f) => f.field_name === "Signature")!.field_category).toBeUndefined();
    });

    it("applies prefill as a field default_value only where provided", () => {
        const fields = toZohoFields(SIGN_FIELDS, "d", 0, 600, 800, { PrintedName: "Ada Lovelace" });
        expect(fields.find((f) => f.field_name === "PrintedName")!.default_value).toBe("Ada Lovelace");
        expect(fields.find((f) => f.field_name === "InsuranceCo")!.default_value).toBeUndefined();
    });
});
