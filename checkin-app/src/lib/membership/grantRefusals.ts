/** Why the Board's grant control is refused; the server throws these and the households page shows them on the disabled control. */

export function renewalProductMissingMessage(yearLabel: string): string {
    return `No membership product is set for ${yearLabel}, so the family couldn't pay. Set it in membership settings before opening a renewal.`;
}

export function applicationNotAtPaymentMessage(step: string): string {
    return `The household's application is at ${step}; it can be granted once it reaches payment.`;
}
