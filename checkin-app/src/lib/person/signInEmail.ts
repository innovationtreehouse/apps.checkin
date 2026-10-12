/**
 * Help text shown wherever a signed-in person's email is locked, and the 400 the
 * household member edit returns for it. `boardReplyTo` is one entry of
 * BoardSettings.emailReplyToAddress (bare or `Name <addr>`); unset falls back to
 * "contact the board".
 */
export function signInEmailHelp(boardReplyTo?: string | null): string {
    const address = boardReplyTo?.match(/<([^>]*)>\s*$/)?.[1] ?? boardReplyTo?.trim();
    const how = address ? `email the board at ${address}` : "contact the board";
    return `This is the address you sign in with. To change it, ${how}.`;
}
