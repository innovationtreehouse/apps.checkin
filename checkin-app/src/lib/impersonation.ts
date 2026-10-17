import { ORG_DOMAIN, type CheckinEnv } from './config';

/**
 * Impersonation = mint the session AS the persona (docs/ops/dev-instance.md, "Impersonation").
 *
 * This module holds the pure policy that decides whether a persona-mint is allowed and what
 * provenance to stamp on the resulting session. It reads no I/O so it can be unit-tested
 * exhaustively; the next-auth provider wires it to getToken + the participant lookup.
 *
 * The cardinal rule: the minted JWT carries an INERT `impersonatedBy` claim for display/audit
 * only — no authorization path (including the middleware gate) ever reads it. So that the dev
 * middleware still passes for an impersonating org member, minted dev sessions instead carry the
 * normal org gate claims (`hd` / `email_verified`), which is what `carryGateClaims` signals.
 *
 * Three modes:
 *  - `impersonate` — become an existing @example.com persona.
 *  - `return`      — go back to the real human in `impersonatedBy`.
 *  - `logout`      — mint a synthetic *guest* session (no participant): authz sees a logged-out
 *                    visitor (no id/roles), but the session still carries the gate claims +
 *                    `impersonatedBy`, so an org member can preview the signed-out UX on the gated
 *                    dev instance and click "Return to me" — without dropping their Google session.
 */
export type MintMode = 'impersonate' | 'return' | 'logout';

/** The caller's *current* session claims (decoded JWT), or null if not signed in. */
export interface CallerClaims {
    email?: string | null;
    hd?: string | null;
    emailVerified?: boolean;
    impersonatedBy?: string | null;
}

export type MintDecision =
    | { allowed: false }
    | {
          allowed: true;
          /**
           * 'return' → the real email to become (impersonatedBy is cleared).
           * 'impersonate' → null; the target persona is chosen by the caller (personaId).
           */
          targetEmail: string | null;
          /** Inert provenance to stamp. null = a plain, non-impersonated login. */
          impersonatedBy: string | null;
          /** Stamp org gate claims (hd/email_verified) so the dev middleware still passes. */
          carryGateClaims: boolean;
          /**
           * `logout` mode → mint a guest session with NO target participant; the provider returns a
           * synthetic logged-out user instead of resolving `targetEmail`/`personaId`.
           */
          guest: boolean;
      };

export function evaluateMint(params: {
    checkinEnv: CheckinEnv;
    mode: MintMode;
    caller: CallerClaims | null;
}): MintDecision {
    const { checkinEnv, mode, caller } = params;

    // Minting can forge any session — dead in production by construction.
    if (checkinEnv === 'prod') return { allowed: false };

    const callerIsVerifiedOrg =
        !!caller && caller.hd === ORG_DOMAIN && caller.emailVerified === true;

    if (mode === 'return') {
        // Only meaningful while impersonating; go back to the real identity.
        const realEmail = caller?.impersonatedBy;
        if (!realEmail) return { allowed: false };
        return {
            allowed: true,
            targetEmail: realEmail,
            impersonatedBy: null,
            carryGateClaims: checkinEnv === 'dev',
            guest: false,
        };
    }

    // `impersonate` and `logout` share one caller gate: on the publicly-reachable cloud dev
    // instance, only a verified org member may mint. (On local there is no Google identity, so this
    // is relaxed — any session, or none, may mint.)
    if (checkinEnv === 'dev' && !callerIsVerifiedOrg) return { allowed: false };

    // The real identity behind the session: preserve the original if the caller is already
    // impersonating (so nested "become X then become Y", or "become X then view logged out", still
    // credits the real human), else the caller's own email, else null (local first-login = a plain
    // login, not an impersonation).
    const realIdentity = caller ? caller.impersonatedBy ?? caller.email ?? null : null;

    if (mode === 'logout') {
        // Guest session: no target participant. authz sees a logged-out visitor; the gate claims +
        // inert impersonatedBy keep the dev instance reachable and "Return to me" working.
        return {
            allowed: true,
            targetEmail: null,
            impersonatedBy: realIdentity,
            carryGateClaims: checkinEnv === 'dev',
            guest: true,
        };
    }

    // mode === 'impersonate'
    return {
        allowed: true,
        targetEmail: null,
        impersonatedBy: realIdentity,
        carryGateClaims: checkinEnv === 'dev',
        guest: false,
    };
}
