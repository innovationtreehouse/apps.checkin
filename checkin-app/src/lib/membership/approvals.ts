/**
 * Background-check approval counting — pure and client-safe, so the review service
 * and the pages that display progress count the same way.
 *
 * `result` absent means APPROVE: the reviewer queue's attestations carry no result
 * (an awaiting review only ever holds approvals, and the field is internal-tier).
 */
type Attestation = { result?: string; subjectPersonId: number | null };

const isApprove = (a: Attestation) => (a.result ?? "APPROVE") === "APPROVE";

/**
 * The adult a household review is about, fixed by whoever approved first. A review
 * covers ONE adult: the second reviewer confirms that person's report rather than
 * choosing again, so two reviewers can never split across different people. A
 * second adult with their own check is a separate obligation on the PERSON_BG
 * track, not a competing subject here.
 *
 * Null when nothing is settled yet, or on a subject-less attestation — a REJECT, a
 * PERSON_BG, or a legacy row attested before per-adult subjects existed.
 */
export function establishedSubject(attestations: Attestation[]): number | null {
    return attestations.find((a) => isApprove(a) && a.subjectPersonId !== null)?.subjectPersonId ?? null;
}

/**
 * Approvals standing behind `subject` — NAMED ones only. An approval that named
 * nobody counts toward nobody: nothing records whose report it read, so counting it
 * would date a clearance on a single reviewer's reading. A review carrying one takes
 * a board reset and two fresh attestations, which is what the two-reviewer rule asks.
 */
export function approvalsForSubject(attestations: Attestation[], subject: number): number {
    return attestations.filter((a) => isApprove(a) && a.subjectPersonId === subject).length;
}

/**
 * Approvals that count toward clearing the review — the number attest() decides on.
 * A PERSON_BG counts every approval; a household counts only those naming its
 * settled subject, so an unnamed legacy approval or one naming a different adult
 * is recorded but does not bring the review closer to clearing.
 */
export function clearingApprovals(attestations: Attestation[], isPersonBg: boolean): number {
    if (isPersonBg) return attestations.filter(isApprove).length;
    const subject = establishedSubject(attestations);
    return subject === null ? 0 : approvalsForSubject(attestations, subject);
}
