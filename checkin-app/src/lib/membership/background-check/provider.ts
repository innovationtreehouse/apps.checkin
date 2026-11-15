/**
 * Background-check provider abstraction.
 *
 * Averity (VERITY / Verity Secure) exposes NO public API — only a hosted
 * consent page (a deep link) and email notifications to a human. So the
 * provider's job is narrow: hand applicants the right consent link. That a
 * check was started, and its outcome, are recorded by people marking them in our
 * system (markCheckStarted, then the two-reviewer review). The system never sees background-check
 * results — only whether a board member has attested to them.
 *
 * Keeping this behind an interface means a future provider with a real API can
 * drop in without touching the flow.
 */
export interface BackgroundCheckProvider {
    /** The hosted consent deep link to show an applicant, or null if unconfigured. */
    getConsentDeepLink(): Promise<string | null>;
}
