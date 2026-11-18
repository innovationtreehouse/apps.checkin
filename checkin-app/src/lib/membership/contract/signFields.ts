/**
 * Signature-field layouts for the agreements sent to Zoho Sign. Each layout
 * matches the blank lines printed on its PDF's LAST page.
 *
 * Coordinates are PERCENTAGES of the page (0–100); Zoho needs absolutes, so
 * `toZohoFields()` multiplies by the actual page width/height (read from the PDF).
 */

/** Zoho field_type_name values used by the agreement. */
export type ZohoFieldType = "Signature" | "Date" | "Textfield";

export interface SignFieldSpec {
    field_type_name: ZohoFieldType;
    field_name: string;
    field_label: string;
    is_mandatory: boolean;
    x_pct: number;
    y_pct: number;
    w_pct: number;
    h_pct: number;
}

/**
 * Membership agreement, ported from `signature_fields()` in
 * innovationtreehouse/sign-script (send_for_signature.py):
 *
 *   [        Signature        ]   [        Date Signed        ]      y≈76%
 *   [ Printed Name ] [ Insurance Company ] [ Policy # (N/A) ]       y≈87%
 */
export const SIGN_FIELDS: SignFieldSpec[] = [
    { field_type_name: "Signature", field_name: "Signature", field_label: "Signature", is_mandatory: true, x_pct: 2, y_pct: 76, w_pct: 54, h_pct: 8 },
    { field_type_name: "Date", field_name: "DateSigned", field_label: "Date", is_mandatory: true, x_pct: 59, y_pct: 76, w_pct: 39, h_pct: 8 },
    { field_type_name: "Textfield", field_name: "PrintedName", field_label: "Printed Name", is_mandatory: true, x_pct: 2, y_pct: 87, w_pct: 29, h_pct: 5 },
    { field_type_name: "Textfield", field_name: "InsuranceCo", field_label: "Insurance Company", is_mandatory: true, x_pct: 33, y_pct: 87, w_pct: 33, h_pct: 5 },
    { field_type_name: "Textfield", field_name: "PolicyNumber", field_label: "Policy # (N/A if none)", is_mandatory: true, x_pct: 68, y_pct: 87, w_pct: 30, h_pct: 5 },
];

/**
 * Key Volunteer Agreement (key-volunteer-agreement.pdf), each box on its printed line:
 *
 *   Full Name: [              Printed Name              ]              y≈79%
 *   Signature: [        Signature        ]  Date: [ Date ]             y≈84–86%
 */
export const KVA_SIGN_FIELDS: SignFieldSpec[] = [
    { field_type_name: "Textfield", field_name: "PrintedName", field_label: "Full Name", is_mandatory: true, x_pct: 22.2, y_pct: 79.4, w_pct: 63.9, h_pct: 2.8 },
    { field_type_name: "Signature", field_name: "Signature", field_label: "Signature", is_mandatory: true, x_pct: 21.9, y_pct: 84.1, w_pct: 44.5, h_pct: 4.5 },
    { field_type_name: "Date", field_name: "DateSigned", field_label: "Date", is_mandatory: true, x_pct: 72.8, y_pct: 85.8, w_pct: 14.9, h_pct: 2.8 },
];

/** A field as Zoho's `submit` endpoint expects it (absolute coords on one document). */
export interface ZohoSubmitField {
    field_name: string;
    field_type_name: ZohoFieldType;
    field_label: string;
    field_category?: string;
    document_id: string;
    page_no: number;
    x_coord: number;
    y_coord: number;
    abs_width: number;
    abs_height: number;
    is_mandatory: boolean;
    default_value?: string;
}

/** Optional per-field prefill values, keyed by field_name (e.g. PrintedName). */
export type FieldPrefill = Partial<Record<string, string>>;

/**
 * Convert the percentage layout to Zoho's absolute submit fields for a given
 * document/page, mirroring the script's coordinate math (pct/100 × page size,
 * rounded). Textfields carry `field_category: "Textfield"` as in the source.
 */
export function toZohoFields(
    specs: readonly SignFieldSpec[],
    documentId: string,
    pageNo: number,
    pageWidth: number,
    pageHeight: number,
    prefill: FieldPrefill = {},
): ZohoSubmitField[] {
    return specs.map((f) => {
        const entry: ZohoSubmitField = {
            field_name: f.field_name,
            field_type_name: f.field_type_name,
            field_label: f.field_label,
            document_id: documentId,
            page_no: pageNo,
            x_coord: Math.round((f.x_pct / 100) * pageWidth),
            y_coord: Math.round((f.y_pct / 100) * pageHeight),
            abs_width: Math.round((f.w_pct / 100) * pageWidth),
            abs_height: Math.round((f.h_pct / 100) * pageHeight),
            is_mandatory: f.is_mandatory,
        };
        if (f.field_type_name === "Textfield") entry.field_category = "Textfield";
        const value = prefill[f.field_name];
        if (value) entry.default_value = value;
        return entry;
    });
}
