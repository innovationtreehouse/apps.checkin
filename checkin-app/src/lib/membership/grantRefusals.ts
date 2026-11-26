/** Why the Board's grant control is refused; the server throws these and the households page shows them on the disabled control. */

export function renewalProductMissingMessage(yearLabel: string): string {
    return `No membership product is set for ${yearLabel}, so the family couldn't pay. Set it in membership settings before opening a renewal.`;
}

/** An in-flight application that isn't at PENDING_PAYMENT can't be granted. */
export function applicationStepRefusal(step: string): string {
    if (step === "PENDING_BG_CLEARANCE") return "This application is already paid and is waiting for its background check.";
    return `The household's application is at ${step}; it can be granted once it reaches payment.`;
}
