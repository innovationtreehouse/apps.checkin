/**
 * Help text shown wherever a signed-in person's email is locked, and the 400 the
 * household member edit returns for it. `boardReplyTo` is one entry of
 * BoardSettings.emailReplyToAddress (bare or `Name <addr>`); unset falls back to
 * "contact the board".
 */
export function signInEmailHelp(boardReplyTo?: string | null): string {
    return `This is the address you sign in with. To change it, ${howToReachBoard(boardReplyTo)}.`;
}

/** "email the board at <addr>", or "contact the board" when no reply-to is set. */
export function howToReachBoard(boardReplyTo?: string | null): string {
    const address = boardReplyTo?.match(/<([^>]*)>\s*$/)?.[1] ?? boardReplyTo?.trim();
    return address ? `email the board at ${address}` : "contact the board";
}
