import type { ScholarshipRequestKind } from "@/generated/prisma/client";

/**
 * The one wording for each ask, shared by the request form, the board's two
 * review queues and the review-team notification, so a family picks the same
 * words the board later reads.
 *
 * `import type` only: both request forms are "use client", and pulling the enum
 * in as a value would drag the Prisma runtime into the browser bundle.
 */
export const SCHOLARSHIP_REQUEST_KIND_OPTIONS = [
    {
        value: "SCHOLARSHIP",
        label: "Scholarship",
        description: "We need the amount reduced.",
    },
    {
        value: "PAYMENT_PLAN",
        label: "Payment plan",
        description: "We can pay the full amount, but need to spread it out.",
    },
    {
        value: "UNSURE",
        label: "Not sure",
        description: "We would like to talk it through.",
    },
] as const satisfies ReadonlyArray<{ value: ScholarshipRequestKind; label: string; description: string }>;

/**
 * Null is a request made before the kind was recorded, not a family who declined
 * to say — UNSURE is that, and it is a stated answer.
 *
 * Takes a plain string because that is what a JSON response carries; an
 * unrecognised value falls back rather than throwing, so a board queue never
 * blanks out over a value this build does not know.
 */
export function scholarshipRequestKindLabel(kind: ScholarshipRequestKind | string | null | undefined): string {
    return SCHOLARSHIP_REQUEST_KIND_OPTIONS.find((o) => o.value === kind)?.label ?? "Not stated";
}
