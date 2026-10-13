/**
 * Centralized environment & configuration management.
 * All process.env access should go through this module.
 */

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

/**
 * The single environment-personality switch (see docs/ops/dev-instance.md).
 *   prod  — production (default when unset). Real data, public landing, no impersonation.
 *   dev   — cloud dev instance. Entire site behind org login.
 *   local — a developer laptop. Permits offline credential login + keyless kiosk.
 *
 * IMPORTANT: this is server-only. CHECKIN_ENV is intentionally NOT NEXT_PUBLIC_, so it is
 * never inlined into the client bundle (which keeps the same image safe in every environment).
 * Client components must read it via useCheckinEnv() (see components/EnvProvider), never here.
 */
export type CheckinEnv = 'prod' | 'dev' | 'local';

/** Verified Google Workspace hosted-domain (`hd`) allowed on the dev instance. */
export const ORG_DOMAIN = 'innovationtreehouse.org';

/**
 * The single environment fuse. Every deployed instance — prod, cloud-dev, ops-stg —
 * runs the same production image, so NODE_ENV is 'production' everywhere and cannot
 * tell them apart: environment branches gate on this (through the config predicates
 * below), never NODE_ENV. Enforced by the NODE_ENV ban in eslint.config.mjs.
 */
function readCheckinEnv(): CheckinEnv {
    const value = process.env.CHECKIN_ENV;
    // Anything unrecognized — including unset — fails safe to prod.
    return value === 'dev' || value === 'local' ? value : 'prod';
}

/**
 * True on the ops-stg staging environment. ops-stg deploys with CHECKIN_ENV=stg
 * and NOTHING ELSE — no separate CHECKIN_STAGING variable to wire or forget.
 *
 * 'stg' is deliberately NOT a member of the CheckinEnv union: readCheckinEnv()
 * collapses the unrecognized value to 'prod', keeping every mock
 * (Zoho/Shopify/background-check) off and persona-mint unregistered — a
 * prod-data copy needs that. Adding 'staging' to CheckinEnv would flip every
 * `readCheckinEnv() !== 'prod'` mock gate ON in staging, the opposite of what
 * we want. So this predicate reads the RAW process.env.CHECKIN_ENV, not
 * checkinEnv(), to see the un-collapsed 'stg' that the mock path throws away.
 *
 * Exact `=== 'stg'`, not a truthy/substring check, so a stray value can't
 * accidentally engage the gate — it only ever widens the surface that runs a
 * stricter check (isStagingAccessAllowed below), so failing inert on any
 * ambiguous value is the safe default.
 *
 * Derived as well as declared: a missing/blank/malformed CHECKIN_ENV fails
 * readCheckinEnv() SAFE to prod, which fails THIS predicate OPEN — the gate
 * goes inert exactly when it matters most. So CHECKIN_ENV is not the only
 * signal: the ops-stg host (config.baseUrl(), sourced from NEXTAUTH_URL) is a
 * second, independent one that can't be silently forgotten — Google OAuth
 * callbacks don't work without NEXTAUTH_URL pointed at the real host, so it is
 * set correctly by construction, not by a task-def author remembering it.
 */
function isStagingEnv(): boolean {
    if (process.env.CHECKIN_ENV === 'stg') return true;
    try {
        return new URL(config.baseUrl()).hostname.startsWith('ops-stg.');
    } catch {
        return false;
    }
}

/**
 * ops-stg trust-boundary predicate (see docs on the staging access gate).
 * ops-stg runs a scrubbed copy of PRODUCTION data behind PROD's Google OAuth
 * client, deliberately NOT restricted to the org Google Workspace (a
 * sysadmin-settable exception must be able to admit an outside collaborator).
 * That means any Google account on the internet can complete sign-in and
 * NextAuth auto-creates a Person row for them — this predicate is the ONLY
 * thing standing between that stranger and copied prod data, so it is applied
 * at all three surfaces that can serve a response: middleware (pages),
 * authenticateRequest (the API auth chokepoint), and resolveAccess (the
 * `authorize: 'public'` path, which reaches authenticateRequest but does not
 * gate on its result by default).
 *
 * Fails closed: missing/undefined claims (no token, anonymous caller, a
 * caller whose claims didn't decode) deny.
 */
export type StagingGateClaims = {
    hd?: string | null;
    emailVerified?: boolean;
    canAccessStaging?: boolean;
};

export function isStagingAccessAllowed(claims: StagingGateClaims | null | undefined): boolean {
    if (!claims) return false;
    return (claims.hd === ORG_DOMAIN && claims.emailVerified === true) || claims.canAccessStaging === true;
}

/** True only when all three Zoho OAuth secrets are present. */
function zohoConfiguredEnv(): boolean {
    return !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN);
}

/**
 * The dev/local Zoho Sign MOCK is active when the real integration is unconfigured
 * AND we're on a non-prod instance (see docs/ops/contract-signing-mock.md).
 * CHECKIN_ENV is the single, server-only fuse (see the note above
 * shopifyMockActiveEnv for why NODE_ENV was eliminated as a second fuse) — it
 * fails safe to prod, so no mock path is reachable in prod by construction.
 * Setting real Zoho secrets in dev opts back into the real client
 * (zohoConfigured wins).
 */
function zohoMockActiveEnv(): boolean {
    return !zohoConfiguredEnv() && readCheckinEnv() !== 'prod';
}

/**
 * Fixed shared secret the dev mock signs its self-fired webhook with. It guards
 * nothing real — the payload is generated locally — it exists
 * only so verifyZohoToken's real timing-safe compare has a value in dev.
 * Exported for the same reason as DEV_MOCK_SHOPIFY_WEBHOOK_SECRET below.
 */
export const DEV_MOCK_WEBHOOK_SECRET = 'dev-zoho-mock-webhook-secret';

/**
 * Which Shopify backend runs — gated EXPLICITLY on CHECKIN_ENV, never on whether
 * creds happen to be set:
 *
 *   prod  → real PRODUCTION Shopify store   (SHOPIFY_* creds required)
 *   dev   → real DEV Shopify store          (SHOPIFY_* creds required)
 *   local → in-app MOCK, no store, no creds — checkout is settled by the self-fired
 *           orders/paid webhook (Debug tool or the in-app "local mock" button),
 *           signed with DEV_MOCK_SHOPIFY_WEBHOOK_SECRET and matched against synthetic
 *           dev-mock variant ids.
 *
 * dev and prod are identical code paths; they differ only in which store SHOPIFY_*
 * points at per-deploy. The ONLY behavioural branch is local. To hit a real store
 * from a laptop, run as CHECKIN_ENV=dev with real creds — CHECKIN_ENV=local is always
 * the mock, regardless of whether creds happen to be set.
 *
 * Gated on the explicit env, NOT on cred presence — and on CHECKIN_ENV ALONE.
 * NODE_ENV was deliberately ELIMINATED as a second "build-level fuse" across this
 * file (#951 review): every deployed instance runs the same production image
 * (Dockerfile sets NODE_ENV=production), so the clause could never distinguish a
 * misconfigured prod box from a legitimate deployment — it only broke dev-instance
 * features (the Debug-nav 404 class) while "protecting" against exactly one thing:
 * a human explicitly setting CHECKIN_ENV=local on prod infra. That misconfig class
 * belongs to CHECKIN_ENV itself, which fails safe to prod for any unset or
 * unrecognized value (readCheckinEnv). One fuse, honestly owned.
 */
function shopifyMockActiveEnv(): boolean {
    return readCheckinEnv() === 'local';
}


/**
 * Fixed secret the Shopify mock signs its self-fired orders/paid webhook with.
 * Unlike a real dev store (which signs with Shopify's own per-store secret we
 * don't choose), the mock generates the payload locally, so a fixed constant is
 * enough for verifyShopifyHmac's real timing-safe compare — same rationale as
 * DEV_MOCK_WEBHOOK_SECRET. See §4 of the design: fixed ⇔ self-fired mock.
 *
 * Exported so tests that assert the mock's self-signed webhook verifies can
 * import it instead of duplicating the literal: the tests exercise the fallback
 * wiring, and the exact value is not a contract anything external signs with,
 * so signer and verifier should track one source of truth.
 */
export const DEV_MOCK_SHOPIFY_WEBHOOK_SECRET = 'dev-shopify-mock-webhook-secret';

/**
 * Synthetic membership variant id used when the Shopify mock is active. Programs
 * synthesize a dev-mock-variant id at creation (shopify.ts › createShopifySingleVariantProgram),
 * but the membership variant is manual BoardSettings config that a local seed never
 * populates — so with no fallback the mock orders/paid webhook can't match a membership
 * order (webhooks/shopify/route.ts) and the dev fire tool 409s. Both the mock firer and
 * the inbound handler fall back to this id when shopifyMockActive(), so local membership
 * dues settle end-to-end with zero setup. Same shape as the program dev-mock ids.
 */
export const DEV_MOCK_MEMBERSHIP_VARIANT_ID = 'dev-mock-variant-membership';

/**
 * The dev/local background-check MOCK is active when the real Averity consent link
 * is unconfigured (AVERITY_CONSENT_URL unset) AND we're on a non-prod instance.
 * CHECKIN_ENV is the single fuse, same as the Zoho/Shopify mocks (see the note
 * above shopifyMockActiveEnv) — it fails safe to prod, so no mock path is reachable
 * in prod by construction. It hands the applicant an in-app consent link
 * (/dev/bg-consent) instead of Averity's hosted page, so the check can be started
 * in debug mode; board members then sign off through the normal two-reviewer
 * attestation. Setting AVERITY_CONSENT_URL opts back into the real link.
 * See docs/ops/background-check-mock.md.
 */
function bgMockActiveEnv(): boolean {
    return !process.env.AVERITY_CONSENT_URL && readCheckinEnv() !== 'prod';
}

export const config = {
    // Database
    databaseUrl: () => requireEnv('DATABASE_URL'),

    // Auth
    nextAuthUrl: () => process.env.NEXTAUTH_URL || 'http://localhost:4000',
    nextAuthSecret: () => requireEnv('NEXTAUTH_SECRET'),
    googleClientId: () => requireEnv('GOOGLE_CLIENT_ID'),
    googleClientSecret: () => requireEnv('GOOGLE_CLIENT_SECRET'),

    // Kiosk
    kioskPublicKey: (): string | null => process.env.KIOSK_PUBLIC_KEY || null,

    // Email
    resendApiKey: (): string | null => process.env.RESEND_API_KEY || null,
    // The env-level From. Null when unset so an unconfigured instance is
    // distinguishable from a configured one: getEmailSenderIdentity prefers
    // BoardSettings.emailFromAddress and falls back here, and sendEmail refuses to
    // send when neither supplies an address. A hardcoded default would be a sender
    // no domain has verified, so every send would be attempted and rejected.
    emailFrom: (): string | null => process.env.EMAIL_FROM || null,
    // Resend's inbound bounce/complaint webhook signs with Svix under this shared
    // secret (Resend dashboard → Webhooks → signing secret, "whsec_..."). Null when
    // unset — the webhook route's verify fn fails closed with a 500 config error,
    // same pattern as shopifyWebhookSecret/zohoWebhookSecret.
    resendWebhookSecret: (): string | null => process.env.RESEND_WEBHOOK_SECRET || null,

    // Background check (Averity/VERITY hosted consent deep link). No API — this is a
    // static hosted URL provided out-of-band, so it lives in config, not BoardSettings.
    averityConsentUrl: (): string | null => process.env.AVERITY_CONSENT_URL || null,

    // Zoho Sign webhook shared secret (timing-safe compared in verifyZohoToken).
    // Falls back to a fixed dev secret only when the mock is active, so the mock's
    // self-fired webhook (dev interstitial) verifies for real with zero env setup.
    zohoWebhookSecret: (): string | null =>
        process.env.ZOHO_WEBHOOK_SECRET || (zohoMockActiveEnv() ? DEV_MOCK_WEBHOOK_SECRET : null),

    // AWS — region for SDK clients. Set on the ECS task def (AWS_REGION); the
    // default covers local dev. Credentials come from the task role / local profile.
    awsRegion: (): string => process.env.AWS_REGION || 'us-east-2',

    // Membership-agreement PDF — stored in a private S3 bucket (uploaded
    // out-of-band, never committed) and fetched at runtime by the task role.
    // Bucket null when unset → the sign endpoint reports the agreement
    // unavailable (503), the same failure as a missing object. The key has a
    // default so only the bucket must be wired per-env.
    agreementPdfBucket: (): string | null => process.env.AGREEMENT_PDF_S3_BUCKET || null,
    agreementPdfKey: (): string => process.env.AGREEMENT_PDF_S3_KEY || 'membership-agreement.pdf',

    // Zoho Sign — membership-agreement e-signing. The three OAuth secrets are
    // null when unset (integration "off"); the two endpoints default to the .com
    // data center and only need overriding for .eu/.in/etc. See zohoConfigured().
    zohoClientId: (): string | null => process.env.ZOHO_CLIENT_ID || null,
    zohoClientSecret: (): string | null => process.env.ZOHO_CLIENT_SECRET || null,
    zohoRefreshToken: (): string | null => process.env.ZOHO_REFRESH_TOKEN || null,
    zohoAccountsUrl: (): string => process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com',
    zohoSignApi: (): string => process.env.ZOHO_SIGN_API || 'https://sign.zoho.com/api/v1',
    // True only when all three OAuth secrets are present — real integration wired.
    zohoConfigured: (): boolean => zohoConfiguredEnv(),
    // True when the dev/local mock provider stands in for real Zoho (secrets unset,
    // non-prod). Selects the mock adapter, skips the S3 PDF load, enables the dev
    // interstitial + its webhook endpoint. Always false in prod. See zohoMockActiveEnv.
    zohoMockActive: (): boolean => zohoMockActiveEnv(),
    // Sign flow is usable when real Zoho is configured OR the dev mock is active.
    // Gates getOrCreateContractSigningUrl + syncContractStatus (replaces the bare
    // zohoConfigured() checks so the mock can drive them in dev).
    zohoAvailable: (): boolean => zohoConfiguredEnv() || zohoMockActiveEnv(),

    // Cron — shared secret gating the session-less cron routes (see cronAuth.ts).
    cronSecret: (): string | null => process.env.CRON_SECRET || null,

    // s-read mirror — read-only connection string to the `shopify_read` Postgres
    // (the s-read-function's Shopify order/refund/payout mirror). Null when not
    // wired → the reconciler (lib/finance/reconcile.ts) short-circuits as "not
    // wired" instead of throwing, so an env without the mirror simply runs no
    // reconciliation.
    //
    // In AWS there is NO mirror connection string of its own: the app's DML role
    // is a member of the mirror's SELECT-only NOLOGIN grant-holder (infra
    // modules/checkin-bootstrap/bootstrap.sh), so the URL is DATABASE_URL with the
    // database name swapped to SHOPIFY_READ_DB ("shopify_read_<env>", a plain task
    // env — see infra modules/checkin/overview.tf, incl. why it is explicit per
    // env rather than derived from checkinEnv()). SHOPIFY_READ_DATABASE_URL stays
    // as a full-URL override for local dev, where the mirror may live anywhere.
    shopifyReadDatabaseUrl: (): string | null => {
        if (process.env.SHOPIFY_READ_DATABASE_URL) return process.env.SHOPIFY_READ_DATABASE_URL;
        const db = process.env.SHOPIFY_READ_DB;
        const base = process.env.DATABASE_URL;
        if (!db || !base) return null;
        try {
            const url = new URL(base);
            url.pathname = `/${db}`;
            return url.toString();
        } catch {
            return null;
        }
    },

    // s-read sync trigger — name of the `s-read-<env>-trigger` Lambda that RunTasks
    // the sync family (s-read-function/DEPLOY.md). Null when unset → the board's
    // manual-sync route reports "not wired" (503) rather than throwing, matching the
    // mirror accessor above.
    //
    // Named EXPLICITLY per env rather than derived from checkinEnv(): that predicate
    // fails safe to 'prod' for any unset/unrecognized value, which is right for the
    // Zoho/Shopify mocks (a misconfigured box must not get the mock) but exactly
    // backwards here — it would point an unconfigured box at PROD's sync trigger. An
    // explicit name fails to null, i.e. to doing nothing.
    sReadTriggerFunction: (): string | null => process.env.S_READ_TRIGGER_FUNCTION || null,

    // Shopify — Client Credentials Grant integration (see shopify.ts). All three
    // null when unset (integration "off").
    shopifyStoreDomain: (): string | null => process.env.SHOPIFY_STORE_DOMAIN || null,
    shopifyClientId: (): string | null => process.env.SHOPIFY_CLIENT_ID || null,
    shopifyClientSecret: (): string | null => process.env.SHOPIFY_CLIENT_SECRET || null,
    // dev/prod: the real store's per-store webhook secret (null if unwired → the
    // inbound webhook 500s, the intended fail). local: the fixed mock secret, so the
    // self-fired webhook verifies for real with zero env setup.
    shopifyWebhookSecret: (): string | null =>
        process.env.SHOPIFY_WEBHOOK_SECRET || (shopifyMockActiveEnv() ? DEV_MOCK_SHOPIFY_WEBHOOK_SECRET : null),
    // True ONLY on CHECKIN_ENV=local (see shopifyMockActiveEnv). Gates /api/dev/shopify/*
    // + the dev tool + the synthetic dev-mock variant fallbacks. Always false on dev and prod.
    shopifyMockActive: (): boolean => shopifyMockActiveEnv(),

    // True when the dev/local background-check mock stands in for Averity (consent URL
    // unset, non-prod). Selects the mock provider (in-app consent link) and gates
    // /dev/bg-consent + its complete route. Always false in prod. See bgMockActiveEnv.
    bgMockActive: (): boolean => bgMockActiveEnv(),

    // App
    checkinEnv: (): CheckinEnv => readCheckinEnv(),
    // Production (default when unset). Consumers should call this rather than
    // string-comparing checkinEnv() so the env predicates live in one place.
    isProd: (): boolean => readCheckinEnv() === 'prod',
    // True on the cloud dev instance OR a local laptop (i.e. not prod). Server-only.
    isDevInstance: (): boolean => readCheckinEnv() !== 'prod',
    // Gate for the /dev tools + their capture paths (sent-mail inbox, email
    // capture) — use this to gate any future dev tool. Prod safety rests on
    // CHECKIN_ENV alone, which is server-only and fails safe to 'prod' for any
    // unset/unrecognized value; cloud-dev pages are additionally behind the
    // org-member login gate.
    devToolsActive: (): boolean => readCheckinEnv() !== 'prod',
    // Optional CSV participant import module (page + API). Off unless CSV_IMPORT_ENABLED=true;
    // when off the page and its routes 404.
    csvImportEnabled: (): boolean => process.env.CSV_IMPORT_ENABLED === 'true',
    // True only on a developer laptop. Gates offline credential login + keyless kiosk.
    isLocal: (): boolean => readCheckinEnv() === 'local',
    // True on ops-stg (CHECKIN_ENV=stg; see isStagingEnv) — gates the access
    // gate's staging branch (middleware/authenticateRequest/resolveAccess).
    isStaging: (): boolean => isStagingEnv(),
    baseUrl: (): string => {
        if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
        return process.env.NEXTAUTH_URL || 'http://localhost:4000';
    },
} as const;
