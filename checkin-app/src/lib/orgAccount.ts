import { ORG_DOMAIN } from './config';

/**
 * True when the acting user is an internal @innovationtreehouse.org staff account
 * rather than a real member family. Prefer the verified Google hosted-domain (`hd`)
 * claim; fall back to the email suffix when `hd` isn't present (e.g. credential login).
 *
 * A Treehouse account's household holds only that account: nobody, the Board and
 * sysadmins included, adds, moves or merges anyone into it (lib/household/treehouseAccount.ts).
 */
export function isOrgAccount(user: { hd?: string | null; email?: string | null }): boolean {
    if (user.hd === ORG_DOMAIN) return true;
    return !!user.email && user.email.toLowerCase().endsWith(`@${ORG_DOMAIN}`);
}
