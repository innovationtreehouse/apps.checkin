/**
 * Intake field profiles — one declarative source of truth for "which fields
 * each intake context shows / requires."
 *
 * Four surfaces (membership intake, public program register, household add,
 * household edit) each hand-rolled their own field list + required-ness and
 * drifted apart (allergies present in edit paths but not create; parent phone
 * required in one, absent in another). A profile keyed by context fixes that:
 * adding/renaming a field is a one-line edit every surface inherits.
 *
 * Field keys stay aligned with the intake form keys used by IntakeError.fields
 * ("address", "emergencyContact", "primaryName") so the client can highlight
 * the offending inputs unchanged.
 */

export type FieldKey = "address" | "emergencyContact" | "primaryName" | "participantDob" | "notes";

export interface IntakeProfile {
    context: string;
    /** Fields the form renders for this context. */
    shown: FieldKey[];
    /** Fields validated at submit; order drives the "Please complete: …" message. */
    requiredAtSubmit: FieldKey[];
}

/**
 * The state a submit is validated against. Built by the caller (e.g.
 * submitIntake) from the loaded household; profile-agnostic so any surface can
 * reuse it.
 */
export interface IntakeSubmitContext {
    addressLine1?: string | null;
    addressCity?: string | null;
    addressState?: string | null;
    addressPostalCode?: string | null;
    emergencyContacts: { conflictParticipantId: number | null; name: string; phone: string }[];
    primaryName?: string | null;
    /** Enrollees whose DOB gates an age-restricted program (program-first-time). */
    participants?: { dob?: string | Date | null; ageGated?: boolean }[];
}

/**
 * Per-field label + satisfied-predicate. The label reproduces the exact human
 * text membership submit has always used, so the IntakeError message is
 * unchanged.
 */
const FIELD_RULES: Record<FieldKey, { label: string; isSatisfied: (ctx: IntakeSubmitContext) => boolean }> = {
    address: {
        label: "home address (street, city, state, ZIP)",
        isSatisfied: (ctx) =>
            !!ctx.addressLine1?.trim() &&
            !!ctx.addressCity?.trim() &&
            !!ctx.addressState?.trim() &&
            !!ctx.addressPostalCode?.trim(),
    },
    emergencyContact: {
        // A household must keep >= 1 valid (non-member, complete) emergency contact.
        label: "a valid emergency contact (someone outside the household)",
        isSatisfied: (ctx) => ctx.emergencyContacts.some((c) => c.conflictParticipantId === null && c.name.trim() && c.phone.trim()),
    },
    primaryName: {
        label: "primary parent name",
        isSatisfied: (ctx) => !!ctx.primaryName?.trim(),
    },
    participantDob: {
        label: "date of birth for each enrolled participant",
        // Only age-gated enrollees need a DOB; no age-gated enrollees → satisfied.
        isSatisfied: (ctx) => (ctx.participants ?? []).filter((p) => p.ageGated).every((p) => !!p.dob),
    },
    // "Anything else we should know?" — always optional, never gates a submit, so
    // it lives only in `shown`. Rule present to satisfy the FieldKey map.
    notes: {
        label: "anything else we should know",
        isSatisfied: () => true,
    },
};

export const INTAKE_PROFILES = {
    "membership-initial": {
        context: "membership-initial",
        shown: ["address", "emergencyContact", "primaryName", "notes"],
        requiredAtSubmit: ["address", "emergencyContact", "primaryName"],
    },
    "program-first-time": {
        context: "program-first-time",
        // Address is shown (collected if offered) but not required — a non-member
        // enrolling in one workshop is not a membership application.
        shown: ["primaryName", "emergencyContact", "participantDob", "address", "notes"],
        requiredAtSubmit: ["primaryName", "emergencyContact", "participantDob"],
    },
} satisfies Record<string, IntakeProfile>;

export type IntakeContext = keyof typeof INTAKE_PROFILES;

/**
 * The profile's required fields not yet satisfied by `ctx`, in profile order,
 * each with its form key + human label. Empty array = complete.
 */
export function missingRequiredFields(profile: IntakeProfile, ctx: IntakeSubmitContext): { field: FieldKey; label: string }[] {
    return profile.requiredAtSubmit
        .filter((field) => !FIELD_RULES[field].isSatisfied(ctx))
        .map((field) => ({ field, label: FIELD_RULES[field].label }));
}
