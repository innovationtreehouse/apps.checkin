import {
    EXTERNAL_ERROR_STATUS,
    PAYMENT_ERROR_STATUS,
    RENEWAL_ERROR_STATUS,
    REVIEW_ERROR_STATUS,
    TRUSTED_ADULT_ERROR_STATUS,
    externalErrorResponse,
    paymentErrorResponse,
    renewalErrorResponse,
    reviewErrorResponse,
    trustedAdultErrorResponse,
} from "@/lib/domainErrorResponse";
import { ExternalError } from "@/lib/membership/external";
import { PaymentError } from "@/lib/membership/payment";
import { RenewalError } from "@/lib/membership/renewal";
import { ReviewError } from "@/lib/membership/review";
import { TrustedAdultError } from "@/lib/trusted-adult/service";

// The S3 client it loads does not parse under jsdom.
jest.mock("@/lib/membership/contract/agreementDocument", () => ({}));

describe("domain error status maps", () => {
    it.each([
        ["ReviewError", REVIEW_ERROR_STATUS, {
            not_reviewer: 403, not_found: 404, wrong_phase: 409, same_household_applicant: 403,
            same_household_reviewer: 403, already_attested: 409, not_undoable: 409, invalid_subject: 400, shopify_unavailable: 503,
        }],
        ["PaymentError", PAYMENT_ERROR_STATUS, { not_found: 404, wrong_phase: 409, forbidden: 403 }],
        ["ExternalError", EXTERNAL_ERROR_STATUS, {
            not_configured: 503, agreement_unavailable: 503, not_found: 404, no_household: 404,
            not_lead: 403, wrong_phase: 409, signing_in_progress: 409,
        }],
        ["RenewalError", RENEWAL_ERROR_STATUS, { not_found: 404, not_lead: 403, wrong_phase: 409, denied: 409, blocked: 409 }],
        ["TrustedAdultError", TRUSTED_ADULT_ERROR_STATUS, { not_found: 404, bad_input: 400, wrong_phase: 409, forbidden: 403, already_open: 409 }],
    ])("%s", (_name, map, expected) => {
        expect(map).toEqual(expected);
    });
});

describe("domain error responses", () => {
    it.each([
        ["ReviewError", () => reviewErrorResponse(new ReviewError("already_attested", "m")), '{"error":"m","code":"already_attested"}', 409],
        ["PaymentError", () => paymentErrorResponse(new PaymentError("forbidden", "m")), '{"error":"m","code":"forbidden"}', 403],
        ["ExternalError", () => externalErrorResponse(new ExternalError("not_configured", "m")), '{"error":"m","code":"not_configured"}', 503],
        ["RenewalError", () => renewalErrorResponse(new RenewalError("not_lead", "m")), '{"error":"m","code":"not_lead"}', 403],
        ["TrustedAdultError", () => trustedAdultErrorResponse(new TrustedAdultError("bad_input", "m")), '{"error":"m","code":"bad_input"}', 400],
    ])("%s keeps its body bytes and status", async (_name, respond, body, status) => {
        const res = respond();
        expect(res.status).toBe(status);
        expect(await res.text()).toBe(body);
    });
});
