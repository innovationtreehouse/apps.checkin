/**
 * Help text under a signed-in person's locked email on their profile. `boardReplyTo`
 * is one entry of BoardSettings.emailReplyToAddress (bare or `Name <addr>`); unset
 * falls back to "contact the board".
 */
export function signInEmailHelp(boardReplyTo?: string | null): string {
    return `This is the address you sign in with. To change it, ${howToReachBoard(boardReplyTo)}.`;
}

/** Shown under a household member's locked email, and the 400 the household member edit returns for it. */
export function lockedEmailHelp(boardAddress?: string | null): string {
    const address = bareAddress(boardAddress);
    return address ? `To change this email, contact the Board at ${address}.` : "To change this email, contact the Board.";
}

/** "email the board at <addr>", or "contact the board" when no reply-to is set. */
export function howToReachBoard(boardReplyTo?: string | null): string {
    const address = bareAddress(boardReplyTo);
    return address ? `email the board at ${address}` : "contact the board";
}

function bareAddress(entry?: string | null): string | undefined {
    return entry?.match(/<([^>]*)>\s*$/)?.[1] ?? (entry?.trim() || undefined);
}
