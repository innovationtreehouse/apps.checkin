import { NextAuthOptions } from "next-auth";
import type { JWT } from "next-auth/jwt";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { getToken } from "next-auth/jwt";
import { cookies as requestCookies } from "next/headers";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { AdapterAccount, AdapterUser } from "next-auth/adapters";
import prisma from "@/lib/prisma";
import { config, ORG_DOMAIN } from "@/lib/config";
import { evaluateMint, type MintMode } from "@/lib/impersonation";
import { recordLedger } from "@/lib/dev/ledger";
import { assignParticipantClaims } from "@/lib/authClaims";
import { isCatalogViewerClient } from "@/lib/catalogNav";
import { canonicalizeEmail } from "@/lib/emailNormalize";
import { ROLE_FLAGS, setRoleFlag } from "@/lib/roles";
import { addHouseholdLead } from "@/lib/household/leads";
import { withAuroraResumeRetry } from "@/lib/auroraResumeRetry";
import { normalizeEmail } from "@/lib/prismaEmailNormalize";
import { mintPersonId } from "@/lib/person/mintId";
import { nameWrite } from "@/lib/person/name";

// Stable id for the dev/local persona-mint credential flow.
export const PERSONA_MINT_PROVIDER_ID = "persona-mint";

// /signin?error= code for a first Google sign-in refused over an unverified email.
export const UNVERIFIED_EMAIL_SIGNIN_ERROR = "EmailNotVerified";

// ── NextAuth adapter: the Int ↔ string id boundary, in ONE place ─────────────
//
// NextAuth models every id as a string (its cuid default); our Person.id and
// Account.userId are Int, and the stock PrismaAdapter coerces nothing. That
// boundary has bitten twice: the Participant→Person rename (#708) fixed the
// model map for only the methods it happened to touch, and a later change left
// createUser returning a string id that then crashed linkAccount's Int `userId`
// column on every first Google sign-in. Both slipped past CI because these
// methods run ONLY inside the real Google OAuth callback — persona-mint /
// credentials sign-in (what flow tests exercise via loginAs) never touches the
// adapter, and the global prisma mock resolves any model name.
//
// The fix is structural, not another spot-patch: every user/account method the
// OAuth flow can reach is defined together below, and every id crosses through
// exactly one of the two converters — never an inline String()/parseInt(). A new
// adapter method that forgets them is the failure mode to guard against;
// auth-options-adapter.test.ts calls these directly (the only tier that reaches
// them) to hold that line.

// The stock adapter still backs the methods this flow never overrides (sessions,
// verification tokens); those operate on the real prisma client and touch no id
// boundary. `prisma.person` stays a plain, type-checked access on purpose — a
// cast is exactly how #708 kept a stale model name tsc-green.
const baseAdapter = PrismaAdapter({
    ...(prisma as unknown as Record<string, unknown>),
    user: prisma.person,
}) as unknown as Record<string, unknown>;

// Int (DB) → string (NextAuth), filling the non-null email an AdapterUser needs.
const toAdapterUser = (u: { id: number; email: string | null }): AdapterUser =>
    ({ ...u, id: String(u.id), email: u.email ?? "" }) as AdapterUser;
// string (NextAuth) → Int (DB). NaN-safe; callers treat NaN as "no such id".
const toDbId = (id: string | number): number => (typeof id === "number" ? id : parseInt(id, 10));

// Every participant must belong to a household (Participant.householdId is
// required), so new sign-ups get a single-person household they lead.
export async function createParticipantWithHousehold(data: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
    googleId?: string | null;
    emailVerified?: Date | null;
}) {
    return prisma.$transaction(async (tx) => {
        const household = await tx.household.create({
            data: { name: data.name?.trim() || data.email?.trim() || "Household" },
        });
        const participant = await tx.person.create({
            data: {
                ...data,
                id: await mintPersonId(tx),
                householdId: household.id,
                // ponytail: last manufactured name in the tree (Decision 4) — a
                // provider/flow that supplies no name must not block sign-in; the
                // member can fix it later in their profile.
                name: nameWrite(data.name) ?? nameWrite(data.email?.split("@")[0]) ?? "Member",
            },
        });
        await addHouseholdLead(tx, household.id, participant.id);
        return participant;
    });
}

// Every Person/Account id read or written by the OAuth flow lives in this one
// object, and every one of them goes through toAdapterUser / toDbId. Keep it that
// way: a method that touches an id without a converter is the bug this guards.
const patchedAdapter = {
    ...baseAdapter,

    // First Google sign-in also provisions the household (base createUser would
    // create only the Person). googleId rides along at runtime.
    createUser: async (user: Parameters<typeof createParticipantWithHousehold>[0]) =>
        toAdapterUser(await createParticipantWithHousehold(user)),

    getUser: async (id: string) => {
        const dbId = toDbId(id);
        if (isNaN(dbId)) return null;
        const user = await prisma.person.findUnique({ where: { id: dbId } });
        return user ? toAdapterUser(user) : null;
    },

    // NextAuth hands us the provider's email verbatim (Google's casing). The
    // stored value is lowercased on write, so the lookup key must be too — else
    // a differently-cased address misses the row and NextAuth mints a duplicate
    // (issue #292). Read normalization mirrors the write extension.
    getUserByEmail: async (email: string) => {
        const user = await prisma.person.findUnique({ where: { email: normalizeEmail(email) } });
        return user ? toAdapterUser(user) : null;
    },

    getUserByAccount: async (key: { provider: string; providerAccountId: string }) => {
        const account = await prisma.account.findUnique({
            where: { provider_providerAccountId: key },
            include: { user: true },
        });
        return account?.user ? toAdapterUser(account.user) : null;
    },

    updateUser: async ({ id, ...data }: { id: string; name?: string | null; email?: string | null; image?: string | null; emailVerified?: Date | null }) => {
        const user = await prisma.person.update({
            where: { id: toDbId(id) },
            // A provider that stops sending a name must not erase one already on file.
            data: { name: nameWrite(data.name), email: data.email ?? undefined, image: data.image, emailVerified: data.emailVerified },
        });
        return toAdapterUser(user);
    },

    deleteUser: async (id: string) => {
        await prisma.person.delete({ where: { id: toDbId(id) } });
    },

    // The crash this whole boundary exists to prevent: the stock linkAccount
    // writes NextAuth's string userId straight into Account.userId (Int). Coerce
    // it, and map only our own columns so a provider's extra token fields can't
    // reach prisma.account.create.
    linkAccount: async (account: AdapterAccount) => {
        await prisma.account.create({
            data: {
                userId: toDbId(account.userId),
                type: account.type,
                provider: account.provider,
                providerAccountId: account.providerAccountId,
                refresh_token: account.refresh_token,
                access_token: account.access_token,
                expires_at: account.expires_at,
                token_type: account.token_type,
                scope: account.scope,
                id_token: account.id_token,
                session_state: (account.session_state ?? null) as string | null,
            },
        });
        return account;
    },
};

// Bootstrap isSysadmin emails — comma-separated list from env.
// Any account matching these emails will be auto-promoted to isSysadmin on login.
const BOOTSTRAP_SYSADMINS = (process.env.BOOTSTRAP_SYSADMINS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

/**
 * Stamp the catalog-viewer volunteer leg (#1286) onto an already-claimed token.
 * Designations are keyed by email (no Person FK), so this can't ride the person
 * load. Matching canonicalizes both sides (Gmail dot/plus-insensitive), the same
 * rule as the dues path and the server gate. The lookup runs only when the leg
 * decides admission: a DENIED token or one another leg already admits skips it.
 */
async function stampVolunteerDesignation(token: JWT, email: string | null | undefined): Promise<void> {
    token.hasVolunteerDesignation = false;
    if (!email || token.denied || isCatalogViewerClient(token)) return;
    const key = canonicalizeEmail(email);
    // ponytail: full scan of a small board-maintained table so legacy non-canonical
    // rows still match; switch to findUnique on the key once every row is canonical.
    const designations = await withAuroraResumeRetry(() =>
        prisma.volunteerDesignation.findMany({ select: { email: true } }),
    );
    token.hasVolunteerDesignation = designations.some((d) => canonicalizeEmail(d.email) === key);
}

export const authOptions: NextAuthOptions = {
    debug: config.isDevInstance(),
    adapter: patchedAdapter,
    providers: [
        GoogleProvider({
            clientId: config.googleClientId(),
            clientSecret: config.googleClientSecret(),
            allowDangerousEmailAccountLinking: true,
            authorization: {
                params: {
                    prompt: "select_account",
                    access_type: "offline",
                    response_type: "code"
                }
            },
            profile(profile) {
                return {
                    id: profile.sub,
                    name: profile.name,
                    email: profile.email,
                    image: profile.picture,
                    googleId: profile.sub
                }
            }
        }),
        // Persona-mint — the unified impersonation flow for dev + local
        // (docs/ops/dev-instance.md, "Impersonation").
        // Dead in prod by construction. Mints a real session AS the chosen persona, stamping an
        // inert `impersonatedBy` claim (display/audit only — no authz path reads it). The policy
        // lives in evaluateMint(); this provider just supplies the caller's claims and the target.
        // (Replaces the old local-only "Offline Login" provider — local mints are the
        // unauthenticated-caller case in evaluateMint.)
        //
        // Registration gates on isDevInstance(), which fails safe to prod (unset CHECKIN_ENV
        // → 'prod'), matching the shared dev fence (lib/dev/guard.ts); evaluateMint
        // independently denies prod even if the provider somehow runs — both covered in
        // auth-options-authorize.test.ts.
        ...(config.isDevInstance() ? [
            CredentialsProvider({
                id: PERSONA_MINT_PROVIDER_ID,
                name: "Persona",
                credentials: {
                    personaId: { label: "Persona ID", type: "text" },
                    mode: { label: "Mode", type: "text" },
                },
                async authorize(credentials, req) {
                    const mode: MintMode =
                        credentials?.mode === "return" ? "return"
                        : credentials?.mode === "logout" ? "logout"
                        : "impersonate";

                    // The caller's *current* session — the security boundary. getToken decrypts the
                    // session cookie carried on this request; null when not signed in.
                    // The `req` NextAuth hands to a credentials authorize() has NO `cookies` field
                    // (only query/body/headers/method), and getToken reads req.cookies exclusively —
                    // it never parses the cookie header. Without the next/headers cookie store the
                    // caller always looks anonymous and every dev-instance mint is denied.
                    const callerToken = await getToken({
                        req: {
                            headers: req.headers,
                            cookies: await requestCookies(),
                        } as unknown as Parameters<typeof getToken>[0]["req"],
                        secret: config.nextAuthSecret(),
                    });

                    const decision = evaluateMint({
                        checkinEnv: config.checkinEnv(),
                        mode,
                        caller: callerToken
                            ? {
                                  email: callerToken.email,
                                  hd: callerToken.hd ?? null,
                                  emailVerified: callerToken.emailVerified ?? false,
                                  impersonatedBy: callerToken.impersonatedBy ?? null,
                              }
                            : null,
                    });
                    if (!decision.allowed) return null;

                    // Logged-out preview: mint a synthetic guest session with NO participant. authz
                    // sees a logged-out visitor (no id/roles via the jwt callback's email guard); the
                    // inert impersonatedBy still credits the real human so "Return to me" works.
                    if (decision.guest) {
                        await recordLedger(
                            "impersonate",
                            decision.impersonatedBy ?? "unknown",
                            "logged out",
                        );
                        return {
                            id: "guest",
                            email: null,
                            name: "Logged out",
                            impersonatedBy: decision.impersonatedBy,
                        };
                    }

                    // Resolve the target participant (fake data only — must already exist).
                    let dbParticipant;
                    if (mode === "return") {
                        dbParticipant = await prisma.person.findUnique({
                            where: { email: decision.targetEmail! },
                        });
                    } else {
                        const personaId = parseInt(String(credentials?.personaId ?? ""), 10);
                        if (isNaN(personaId)) return null;
                        // Restrict the mintable target to seeded @example.com personas (matches the
                        // dev-personas picker's filter) so a caller can never mint a real participant,
                        // even if one exists in the dev DB.
                        dbParticipant = await prisma.person.findFirst({
                            where: { id: personaId, email: { endsWith: "@example.com" } },
                        });
                    }
                    if (!dbParticipant) return null;

                    // Record the mint in the dev ledger (docs/ops/dev-instance.md, "The ledger"), attributed to
                    // the REAL human. impersonatedBy set → an impersonation (real human becomes a
                    // persona); null → a plain login (e.g. a local first-login as the persona).
                    const realActor = decision.impersonatedBy ?? dbParticipant.email ?? "unknown";
                    await recordLedger(
                        decision.impersonatedBy ? "impersonate" : "login",
                        realActor,
                        decision.impersonatedBy ? (dbParticipant.email ?? dbParticipant.name) : null,
                    );

                    return {
                        id: dbParticipant.id.toString(),
                        email: dbParticipant.email,
                        name: dbParticipant.name,
                        impersonatedBy: decision.impersonatedBy,
                    };
                }
            })
        ] : [])
    ],
    secret: config.nextAuthSecret(),
    // Use our styled sign-in screen instead of NextAuth's bare default page.
    pages: {
        signIn: "/signin",
    },
    session: {
        strategy: "jwt",
        // Bound token lifetime so a stale or forgotten session cannot live for the
        // 30-day NextAuth default. The jwt callback below also re-syncs role flags
        // from the DB on every request so revocations take effect promptly.
        maxAge: 60 * 60 * 8,   // 8 hours
        updateAge: 60 * 15,    // 15 minutes
    },
    callbacks: {
        // Runs before NextAuth links a Google account to the Person holding its email
        // (allowDangerousEmailAccountLinking), so a new link requires Google to have
        // verified that email. An account already linked keeps signing in as before.
        async signIn({ account, profile }) {
            if (account?.provider !== "google") return true;
            const linked = await prisma.account.findUnique({
                where: {
                    provider_providerAccountId: {
                        provider: account.provider,
                        providerAccountId: account.providerAccountId,
                    },
                },
                select: { id: true },
            });
            if (linked) return true;
            if ((profile as { email_verified?: boolean } | undefined)?.email_verified === true) return true;
            return `/signin?error=${UNVERIFIED_EMAIL_SIGNIN_ERROR}`;
        },
        async jwt({ token, user, account, profile }) {
            // Capture Google's hosted-domain + email_verified claims on sign-in so the dev-instance
            // middleware can gate on verified org membership (docs/ops/dev-instance.md,
            // "Running the cloud dev instance").
            // Prefer the `hd` claim over string-matching the email suffix.
            if (account?.provider === "google" && profile) {
                const googleProfile = profile as { hd?: string; email_verified?: boolean };
                token.hd = googleProfile.hd ?? null;
                token.emailVerified = googleProfile.email_verified ?? false;
            }
            // Persona-mint: stamp the inert provenance claim (null clears it on "return to me").
            // On the cloud dev instance, carry the org gate claims onto the minted session so the
            // middleware still passes — every dev mint is by/returns to a verified org member
            // (enforced in evaluateMint), and the middleware must never read impersonatedBy.
            if (account?.provider === PERSONA_MINT_PROVIDER_ID && user) {
                token.impersonatedBy = (user as { impersonatedBy?: string | null }).impersonatedBy ?? null;
                if (config.checkinEnv() === "dev") {
                    token.hd = ORG_DOMAIN;
                    token.emailVerified = true;
                }
            }
            // Guard on `user.email`: a synthetic guest mint (logged-out preview) returns a user with
            // no email, so it resolves no participant and the token carries no id/roles — authz sees
            // a logged-out visitor, while the persona-mint block above still stamped the gate claims
            // + impersonatedBy so the dev gate passes and "Return to me" works.
            if (user?.email) {
                // Normalize the lookup key to match the lowercased stored value
                // (issue #292); Google's casing is otherwise passed through verbatim.
                const email = normalizeEmail(user.email);
                const dbParticipant = await withAuroraResumeRetry(() => prisma.person.findUnique({
                    where: { email, mergedIntoId: null },
                    include: {
                        toolStatuses: {
                            select: {
                                toolId: true,
                                level: true
                            }
                        },
                        // Program ids led — drives the client program-ops row gate.
                        programsLed: { select: { id: true } },
                        household: { include: { orgMembership: true } },
                        // Source of truth for the five authority claims (assignParticipantClaims).
                        roles: { select: { role: true } }
                    }
                }));

                if (dbParticipant) {
                    if (
                        !dbParticipant.isSysadmin &&
                        dbParticipant.email &&
                        BOOTSTRAP_SYSADMINS.includes(dbParticipant.email.toLowerCase())
                    ) {
                        // System bypass: bootstrap self-promotion off an env-configured
                        // allowlist, not a user-initiated authority-matrix request — there is
                        // no actor to check against, only a trusted source deciding its own grant.
                        await setRoleFlag(prisma, dbParticipant.id, "isSysadmin", true, "system");
                        dbParticipant.isSysadmin = true;
                        // Claims derive from `roles`, not the mirror column — push the grant
                        // into the in-memory list so this same-request sign-in gets it too.
                        dbParticipant.roles.push({ role: "SYSADMIN" });
                    }

                    // Stamp authority claims, applying the household login gate (a board
                    // "Deny Membership" forces denied=true and strips every role flag).
                    assignParticipantClaims(token, dbParticipant);
                    await stampVolunteerDesignation(token, dbParticipant.email);
                }
            } else if (token.id) {
                // On every subsequent request (no `user` present), re-sync authority
                // flags from the DB so role grants/revocations take effect without
                // waiting for the token to expire. Previously these flags were only
                // read at sign-in, which let a revoked isSysadmin/isKeyholder keep their
                // privileges (including the /api/roles endpoint) until the JWT
                // aged out — up to 30 days.
                const dbParticipant = await withAuroraResumeRetry(() => prisma.person.findUnique({
                    // A merge tombstone keeps its row and its roles, so `mergedIntoId: null`
                    // (LIVE_PERSON) is what makes this lookup miss and collapses the token
                    // below — otherwise the re-sync re-grants authority from a record every
                    // other surface refuses to show.
                    where: { id: token.id as number, mergedIntoId: null },
                    include: {
                        toolStatuses: {
                            select: {
                                toolId: true,
                                level: true
                            }
                        },
                        // Program ids led — drives the client program-ops row gate.
                        programsLed: { select: { id: true } },
                        household: { include: { orgMembership: true } },
                        // Source of truth for the five authority claims (assignParticipantClaims).
                        roles: { select: { role: true } }
                    }
                }));

                if (!dbParticipant) {
                    // Account no longer exists — return an empty token so every
                    // downstream authorization check fails closed. The cast is
                    // deliberate: JWT requires `id`, and omitting it is the point.
                    return {} as JWT;
                }

                // Re-stamp claims on every request so a board "Deny Membership" takes effect
                // within the token's refresh window (updateAge), not only at next sign-in.
                // assignParticipantClaims forces denied=true and clears all roles when DENIED.
                assignParticipantClaims(token, dbParticipant);
                await stampVolunteerDesignation(token, dbParticipant.email);
            }
            return token;
        },
        async session({ session, token }) {
            if (session.user) {
                session.user.id = token.id;
                session.user.denied = token.denied ?? false;
                for (const flag of ROLE_FLAGS) {
                    session.user[flag] = token[flag];
                }
                session.user.householdId = token.householdId;
                session.user.householdLead = token.householdLead ?? false;
                session.user.ageBand = token.ageBand ?? "unknown";
                session.user.programsLed = token.programsLed ?? [];
                session.user.toolStatuses = token.toolStatuses || [];
                session.user.impersonatedBy = token.impersonatedBy ?? null;
                // Surface the org-gate claims so dev-only server actions (assertDevActor) can
                // re-verify the caller is a verified org member without re-decoding the JWT.
                session.user.hd = token.hd ?? null;
                session.user.emailVerified = token.emailVerified ?? false;
                // ops-stg access gate escape hatch — see lib/config.ts isStagingAccessAllowed.
                session.user.canAccessStaging = token.canAccessStaging ?? false;
                // Catalog-viewer volunteer leg (#1286) — completes the client gate.
                session.user.hasVolunteerDesignation = token.hasVolunteerDesignation ?? false;
            }
            return session;
        }
    }
}
