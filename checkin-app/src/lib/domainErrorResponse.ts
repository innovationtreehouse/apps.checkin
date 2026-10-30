import { NextResponse } from "next/server";
import type { ExternalError } from "@/lib/membership/external";
import type { PaymentError } from "@/lib/membership/payment";
import type { RenewalError } from "@/lib/membership/renewal";
import type { ReviewError } from "@/lib/membership/review";
import type { TrustedAdultError } from "@/lib/trusted-adult/service";

export const REVIEW_ERROR_STATUS: Record<ReviewError["code"], number> = {
    not_reviewer: 403,
    not_found: 404,
    wrong_phase: 409,
    same_household_applicant: 403,
    same_household_reviewer: 403,
    already_attested: 409,
    not_undoable: 409,
    invalid_subject: 400,
};

export const PAYMENT_ERROR_STATUS: Record<PaymentError["code"], number> = {
    not_found: 404,
    wrong_phase: 409,
    forbidden: 403,
};

export const EXTERNAL_ERROR_STATUS: Record<ExternalError["code"], number> = {
    not_configured: 503,
    agreement_unavailable: 503,
    not_found: 404,
    no_household: 404,
    not_lead: 403,
    wrong_phase: 409,
    signing_in_progress: 409,
};

export const RENEWAL_ERROR_STATUS: Record<RenewalError["code"], number> = {
    not_found: 404,
    not_lead: 403,
    wrong_phase: 409,
    denied: 409,
    blocked: 409,
};

export const TRUSTED_ADULT_ERROR_STATUS: Record<TrustedAdultError["code"], number> = {
    not_found: 404,
    bad_input: 400,
    wrong_phase: 409,
    forbidden: 403,
    already_open: 409,
};

function codedResponse<C extends string>(error: { message: string; code: C }, statusFor: Record<C, number>) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: statusFor[error.code] });
}

export const reviewErrorResponse = (error: ReviewError) => codedResponse(error, REVIEW_ERROR_STATUS);
export const paymentErrorResponse = (error: PaymentError) => codedResponse(error, PAYMENT_ERROR_STATUS);
export const externalErrorResponse = (error: ExternalError) => codedResponse(error, EXTERNAL_ERROR_STATUS);
export const renewalErrorResponse = (error: RenewalError) => codedResponse(error, RENEWAL_ERROR_STATUS);
export const trustedAdultErrorResponse = (error: TrustedAdultError) => codedResponse(error, TRUSTED_ADULT_ERROR_STATUS);
