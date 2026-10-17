import { config, ORG_DOMAIN, isStagingAccessAllowed, DEV_MOCK_SHOPIFY_WEBHOOK_SECRET, DEV_MOCK_WEBHOOK_SECRET } from "@/lib/config";

const ENV_KEYS = [
    "DATABASE_URL", "NEXTAUTH_URL", "NEXTAUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
    "KIOSK_PUBLIC_KEY", "RESEND_API_KEY", "EMAIL_FROM", "AVERITY_CONSENT_URL", "ZOHO_WEBHOOK_SECRET",
    "AWS_REGION", "AGREEMENT_PDF_S3_BUCKET", "AGREEMENT_PDF_S3_KEY", "ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET",
    "ZOHO_REFRESH_TOKEN", "ZOHO_ACCOUNTS_URL", "ZOHO_SIGN_API", "CHECKIN_ENV", "VERCEL_URL", "NODE_ENV",
    "SHOPIFY_STORE_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_WEBHOOK_SECRET",
    "SHOPIFY_READ_DATABASE_URL", "SHOPIFY_READ_DB",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

function clearZoho() {
    delete process.env.ZOHO_CLIENT_ID;
    delete process.env.ZOHO_CLIENT_SECRET;
    delete process.env.ZOHO_REFRESH_TOKEN;
    delete process.env.ZOHO_WEBHOOK_SECRET;
}

function clearShopify() {
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_CLIENT_ID;
    delete process.env.SHOPIFY_CLIENT_SECRET;
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
}

describe("requireEnv-backed getters", () => {
    it("returns the value when set", () => {
        process.env.DATABASE_URL = "postgres://x";
        expect(config.databaseUrl()).toBe("postgres://x");
    });
    it("throws with the var name when unset", () => {
        delete process.env.NEXTAUTH_SECRET;
        expect(() => config.nextAuthSecret()).toThrow("Missing required env var: NEXTAUTH_SECRET");
    });
    it("throws when empty string", () => {
        process.env.GOOGLE_CLIENT_ID = "";
        expect(() => config.googleClientId()).toThrow("Missing required env var: GOOGLE_CLIENT_ID");
    });
    it("google client secret follows the same contract", () => {
        process.env.GOOGLE_CLIENT_SECRET = "s3cr3t";
        expect(config.googleClientSecret()).toBe("s3cr3t");
    });
});

describe("checkinEnv / isProd / isDevInstance / isLocal / devToolsActive", () => {
    it("unset fails safe to prod", () => {
        delete process.env.CHECKIN_ENV;
        expect(config.checkinEnv()).toBe("prod");
        expect(config.isProd()).toBe(true);
        expect(config.isDevInstance()).toBe(false);
        expect(config.isLocal()).toBe(false);
        expect(config.devToolsActive()).toBe(false);
    });
    it("garbage value also fails safe to prod", () => {
        process.env.CHECKIN_ENV = "staging";
        expect(config.checkinEnv()).toBe("prod");
        expect(config.devToolsActive()).toBe(false);
    });
    it("'dev'", () => {
        process.env.CHECKIN_ENV = "dev";
        expect(config.checkinEnv()).toBe("dev");
        expect(config.isProd()).toBe(false);
        expect(config.isDevInstance()).toBe(true);
        expect(config.isLocal()).toBe(false);
        expect(config.devToolsActive()).toBe(true);
    });
    it("'local'", () => {
        process.env.CHECKIN_ENV = "local";
        expect(config.checkinEnv()).toBe("local");
        expect(config.isDevInstance()).toBe(true);
        expect(config.isLocal()).toBe(true);
        expect(config.devToolsActive()).toBe(true);
    });
    it("devToolsActive ignores NODE_ENV: cloud-dev runs the production image", () => {
        // Regression for the Debug-nav 404: every deployed instance has
        // NODE_ENV=production (Dockerfile), so a NODE_ENV fuse killed the /dev
        // tools on cloud-dev itself. The gate must be CHECKIN_ENV alone.
        const original = process.env.NODE_ENV;
        Object.defineProperty(process.env, "NODE_ENV", { value: "production", configurable: true });
        try {
            process.env.CHECKIN_ENV = "dev";
            expect(config.devToolsActive()).toBe(true);
            process.env.CHECKIN_ENV = "prod";
            expect(config.devToolsActive()).toBe(false);
        } finally {
            Object.defineProperty(process.env, "NODE_ENV", { value: original, configurable: true });
        }
    });
});

describe("isStaging — driven by CHECKIN_ENV=stg (no separate variable)", () => {
    // Control both signals: the raw CHECKIN_ENV and the NEXTAUTH_URL-derived host.
    beforeEach(() => {
        delete process.env.CHECKIN_ENV;
        delete process.env.NEXTAUTH_URL;
        delete process.env.VERCEL_URL;
    });

    it("false when CHECKIN_ENV is unset", () => {
        expect(config.isStaging()).toBe(false);
    });
    it("true for the exact value 'stg'", () => {
        process.env.CHECKIN_ENV = "stg";
        expect(config.isStaging()).toBe(true);
    });
    it("false for any other CHECKIN_ENV — exact match, not truthy/substring", () => {
        for (const v of ["prod", "dev", "local", "staging", "STG", ""]) {
            process.env.CHECKIN_ENV = v;
            expect(config.isStaging()).toBe(false);
        }
    });
    it("checkinEnv() still collapses 'stg' to prod while isStaging() is true — the mock path stays off", () => {
        process.env.CHECKIN_ENV = "stg";
        expect(config.checkinEnv()).toBe("prod");
        expect(config.isProd()).toBe(true);
        expect(config.isStaging()).toBe(true);
    });

    // Derived as well as declared: a missing/blank/malformed CHECKIN_ENV fails
    // readCheckinEnv() SAFE to prod, which fails isStaging() OPEN — so the host
    // NEXTAUTH_URL points at is a second signal (can't be forgotten, or OAuth breaks).
    describe("derived from config.baseUrl() as a second signal (CHECKIN_ENV not 'stg')", () => {
        it("true when NEXTAUTH_URL's host starts with 'ops-stg.'", () => {
            process.env.NEXTAUTH_URL = "https://ops-stg.innovationtreehouse.org";
            expect(config.isStaging()).toBe(true);
        });

        it("false for a similarly-named but different host (e.g. prod's 'ops.')", () => {
            process.env.NEXTAUTH_URL = "https://ops.innovationtreehouse.org";
            expect(config.isStaging()).toBe(false);
        });

        it("false for the localhost default", () => {
            expect(config.isStaging()).toBe(false);
        });

        it("does not throw on an unparsable NEXTAUTH_URL — fails closed to false", () => {
            process.env.NEXTAUTH_URL = "not a url";
            expect(() => config.isStaging()).not.toThrow();
            expect(config.isStaging()).toBe(false);
        });

        it("CHECKIN_ENV=stg still wins even if the host does not match", () => {
            process.env.NEXTAUTH_URL = "https://checkin.example.org";
            process.env.CHECKIN_ENV = "stg";
            expect(config.isStaging()).toBe(true);
        });
    });
});

describe("isStagingAccessAllowed — the ops-stg gate predicate", () => {
    it("denies null/undefined claims (no token, anonymous caller)", () => {
        expect(isStagingAccessAllowed(null)).toBe(false);
        expect(isStagingAccessAllowed(undefined)).toBe(false);
    });
    it("denies an empty claims object", () => {
        expect(isStagingAccessAllowed({})).toBe(false);
    });
    it("allows a verified org member", () => {
        expect(isStagingAccessAllowed({ hd: ORG_DOMAIN, emailVerified: true })).toBe(true);
    });
    it("denies the right hd without emailVerified", () => {
        expect(isStagingAccessAllowed({ hd: ORG_DOMAIN, emailVerified: false })).toBe(false);
        expect(isStagingAccessAllowed({ hd: ORG_DOMAIN })).toBe(false);
    });
    it("denies emailVerified=true with the wrong hd", () => {
        expect(isStagingAccessAllowed({ hd: "gmail.com", emailVerified: true })).toBe(false);
    });
    it("allows canAccessStaging=true regardless of hd/emailVerified", () => {
        expect(isStagingAccessAllowed({ canAccessStaging: true })).toBe(true);
        expect(isStagingAccessAllowed({ hd: "gmail.com", emailVerified: false, canAccessStaging: true })).toBe(true);
    });
    it("denies canAccessStaging=false with no org claims", () => {
        expect(isStagingAccessAllowed({ canAccessStaging: false })).toBe(false);
    });
});

describe("zohoConfigured", () => {
    it("true when all three secrets are present", () => {
        process.env.ZOHO_CLIENT_ID = "a";
        process.env.ZOHO_CLIENT_SECRET = "b";
        process.env.ZOHO_REFRESH_TOKEN = "c";
        expect(config.zohoConfigured()).toBe(true);
    });
    it("false when client id is missing", () => {
        clearZoho();
        process.env.ZOHO_CLIENT_SECRET = "b";
        process.env.ZOHO_REFRESH_TOKEN = "c";
        expect(config.zohoConfigured()).toBe(false);
    });
    it("false when refresh token is missing", () => {
        clearZoho();
        process.env.ZOHO_CLIENT_ID = "a";
        process.env.ZOHO_CLIENT_SECRET = "b";
        expect(config.zohoConfigured()).toBe(false);
    });
});

describe("zohoMockActive / zohoAvailable / zohoWebhookSecret", () => {
    it("mock active when unconfigured on a non-prod instance", () => {
        clearZoho();
        process.env.CHECKIN_ENV = "local";
        (process.env as Record<string, string>).NODE_ENV = "test";
        expect(config.zohoMockActive()).toBe(true);
        expect(config.zohoAvailable()).toBe(true);
        expect(config.zohoWebhookSecret()).toBe(DEV_MOCK_WEBHOOK_SECRET);
    });
    it("mock inactive when Zoho is configured (real integration wins)", () => {
        process.env.ZOHO_CLIENT_ID = "a";
        process.env.ZOHO_CLIENT_SECRET = "b";
        process.env.ZOHO_REFRESH_TOKEN = "c";
        process.env.CHECKIN_ENV = "local";
        (process.env as Record<string, string>).NODE_ENV = "test";
        expect(config.zohoMockActive()).toBe(false);
        expect(config.zohoAvailable()).toBe(true); // still available via real config
    });
    it("mock inactive on prod checkinEnv", () => {
        clearZoho();
        process.env.CHECKIN_ENV = "prod";
        (process.env as Record<string, string>).NODE_ENV = "test";
        expect(config.zohoMockActive()).toBe(false);
        expect(config.zohoAvailable()).toBe(false);
    });
    it("mock STAYS active under a production build (NODE_ENV eliminated as a fuse, #951)", () => {
        // Deployed instances all run NODE_ENV=production; CHECKIN_ENV alone decides.
        clearZoho();
        process.env.CHECKIN_ENV = "local";
        (process.env as Record<string, string>).NODE_ENV = "production";
        expect(config.zohoMockActive()).toBe(true);
    });
    it("ZOHO_WEBHOOK_SECRET env wins regardless of mock state", () => {
        clearZoho();
        process.env.ZOHO_WEBHOOK_SECRET = "explicit-secret";
        process.env.CHECKIN_ENV = "prod";
        expect(config.zohoWebhookSecret()).toBe("explicit-secret");
    });
    it("null when unset and mock inactive", () => {
        clearZoho();
        process.env.CHECKIN_ENV = "prod";
        expect(config.zohoWebhookSecret()).toBeNull();
    });
});

describe("shopifyMockActive / shopifyWebhookSecret", () => {
    it("mock active on local", () => {
        clearShopify();
        process.env.CHECKIN_ENV = "local";
        (process.env as Record<string, string>).NODE_ENV = "test";
        expect(config.shopifyMockActive()).toBe(true);
        expect(config.shopifyWebhookSecret()).toBe(DEV_MOCK_SHOPIFY_WEBHOOK_SECRET);
    });
    it("mock STILL active on local even when Shopify creds are set (env gate, not cred gate)", () => {
        process.env.SHOPIFY_STORE_DOMAIN = "shop.myshopify.com";
        process.env.SHOPIFY_CLIENT_ID = "a";
        process.env.SHOPIFY_CLIENT_SECRET = "b";
        process.env.CHECKIN_ENV = "local";
        (process.env as Record<string, string>).NODE_ENV = "test";
        expect(config.shopifyMockActive()).toBe(true);
    });
    it("mock inactive on dev (real dev store, not the mock)", () => {
        clearShopify();
        process.env.CHECKIN_ENV = "dev";
        (process.env as Record<string, string>).NODE_ENV = "test";
        expect(config.shopifyMockActive()).toBe(false);
    });
    it("mock inactive on prod checkinEnv", () => {
        clearShopify();
        process.env.CHECKIN_ENV = "prod";
        (process.env as Record<string, string>).NODE_ENV = "test";
        expect(config.shopifyMockActive()).toBe(false);
        expect(config.shopifyWebhookSecret()).toBeNull();
    });
    it("mock STAYS active under a production build (NODE_ENV eliminated as a fuse, #951)", () => {
        clearShopify();
        process.env.CHECKIN_ENV = "local";
        (process.env as Record<string, string>).NODE_ENV = "production";
        expect(config.shopifyMockActive()).toBe(true);
        expect(config.shopifyWebhookSecret()).toBe(DEV_MOCK_SHOPIFY_WEBHOOK_SECRET);
    });
    it("SHOPIFY_WEBHOOK_SECRET env wins regardless of mock state", () => {
        clearShopify();
        process.env.SHOPIFY_WEBHOOK_SECRET = "explicit-shopify-secret";
        process.env.CHECKIN_ENV = "prod";
        expect(config.shopifyWebhookSecret()).toBe("explicit-shopify-secret");
    });
});

describe("bgMockActive", () => {
    it("mock active when Averity unset on a non-prod instance", () => {
        delete process.env.AVERITY_CONSENT_URL;
        process.env.CHECKIN_ENV = "local";
        (process.env as Record<string, string>).NODE_ENV = "test";
        expect(config.bgMockActive()).toBe(true);
    });
    it("mock inactive when AVERITY_CONSENT_URL is set (real link wins)", () => {
        process.env.AVERITY_CONSENT_URL = "https://averity.example/consent";
        process.env.CHECKIN_ENV = "local";
        (process.env as Record<string, string>).NODE_ENV = "test";
        expect(config.bgMockActive()).toBe(false);
    });
    it("mock inactive on prod checkinEnv", () => {
        delete process.env.AVERITY_CONSENT_URL;
        process.env.CHECKIN_ENV = "prod";
        (process.env as Record<string, string>).NODE_ENV = "test";
        expect(config.bgMockActive()).toBe(false);
    });
    it("mock STAYS active under a production build (NODE_ENV eliminated as a fuse, #951)", () => {
        delete process.env.AVERITY_CONSENT_URL;
        process.env.CHECKIN_ENV = "local";
        (process.env as Record<string, string>).NODE_ENV = "production";
        expect(config.bgMockActive()).toBe(true);
    });
});

describe("simple optional getters (env-set vs default)", () => {
    it("kioskPublicKey", () => {
        delete process.env.KIOSK_PUBLIC_KEY;
        expect(config.kioskPublicKey()).toBeNull();
        process.env.KIOSK_PUBLIC_KEY = "key123";
        expect(config.kioskPublicKey()).toBe("key123");
    });
    it("resendApiKey", () => {
        delete process.env.RESEND_API_KEY;
        expect(config.resendApiKey()).toBeNull();
        process.env.RESEND_API_KEY = "resend-1";
        expect(config.resendApiKey()).toBe("resend-1");
    });
    it("emailFrom is null when unset (no hardcoded sender to mask a gap)", () => {
        delete process.env.EMAIL_FROM;
        expect(config.emailFrom()).toBeNull();
        process.env.EMAIL_FROM = "a@b.com";
        expect(config.emailFrom()).toBe("a@b.com");
    });
    it("awsRegion default", () => {
        delete process.env.AWS_REGION;
        expect(config.awsRegion()).toBe("us-east-2");
        process.env.AWS_REGION = "us-west-1";
        expect(config.awsRegion()).toBe("us-west-1");
    });
    it("agreementPdfBucket / agreementPdfKey", () => {
        delete process.env.AGREEMENT_PDF_S3_BUCKET;
        expect(config.agreementPdfBucket()).toBeNull();
        delete process.env.AGREEMENT_PDF_S3_KEY;
        expect(config.agreementPdfKey()).toBe("membership-agreement.pdf");
        process.env.AGREEMENT_PDF_S3_KEY = "custom.pdf";
        expect(config.agreementPdfKey()).toBe("custom.pdf");
    });
    it("zohoAccountsUrl / zohoSignApi defaults", () => {
        delete process.env.ZOHO_ACCOUNTS_URL;
        delete process.env.ZOHO_SIGN_API;
        expect(config.zohoAccountsUrl()).toBe("https://accounts.zoho.com");
        expect(config.zohoSignApi()).toBe("https://sign.zoho.com/api/v1");
        process.env.ZOHO_ACCOUNTS_URL = "https://accounts.zoho.eu";
        expect(config.zohoAccountsUrl()).toBe("https://accounts.zoho.eu");
    });
    it("averityConsentUrl", () => {
        delete process.env.AVERITY_CONSENT_URL;
        expect(config.averityConsentUrl()).toBeNull();
        process.env.AVERITY_CONSENT_URL = "https://averity.example/consent";
        expect(config.averityConsentUrl()).toBe("https://averity.example/consent");
    });
    it("ORG_DOMAIN is the fixed hosted domain", () => {
        expect(ORG_DOMAIN).toBe("innovationtreehouse.org");
    });
});

describe("baseUrl / nextAuthUrl", () => {
    it("baseUrl prefers VERCEL_URL", () => {
        process.env.VERCEL_URL = "my-app.vercel.app";
        expect(config.baseUrl()).toBe("https://my-app.vercel.app");
    });
    it("baseUrl falls back to NEXTAUTH_URL when VERCEL_URL unset", () => {
        delete process.env.VERCEL_URL;
        process.env.NEXTAUTH_URL = "https://checkin.example";
        expect(config.baseUrl()).toBe("https://checkin.example");
    });
    it("baseUrl falls back to localhost default when both unset", () => {
        delete process.env.VERCEL_URL;
        delete process.env.NEXTAUTH_URL;
        expect(config.baseUrl()).toBe("http://localhost:4000");
    });
    it("nextAuthUrl mirrors the same default fallback", () => {
        delete process.env.NEXTAUTH_URL;
        expect(config.nextAuthUrl()).toBe("http://localhost:4000");
        process.env.NEXTAUTH_URL = "https://checkin.example";
        expect(config.nextAuthUrl()).toBe("https://checkin.example");
    });
});

describe("shopifyReadDatabaseUrl", () => {
    it("derives the mirror URL from DATABASE_URL + SHOPIFY_READ_DB, keeping credentials and params", () => {
        delete process.env.SHOPIFY_READ_DATABASE_URL;
        process.env.DATABASE_URL = "postgresql://checkin_dev_dml:p%40ss@host.example:5432/checkin_dev?sslmode=verify-full";
        process.env.SHOPIFY_READ_DB = "shopify_read_dev";
        expect(config.shopifyReadDatabaseUrl()).toBe(
            "postgresql://checkin_dev_dml:p%40ss@host.example:5432/shopify_read_dev?sslmode=verify-full",
        );
    });
    it("prefers the explicit SHOPIFY_READ_DATABASE_URL override", () => {
        process.env.SHOPIFY_READ_DATABASE_URL = "postgresql://ro:x@elsewhere:5432/mirror";
        process.env.DATABASE_URL = "postgresql://a:b@host:5432/checkin_dev";
        process.env.SHOPIFY_READ_DB = "shopify_read_dev";
        expect(config.shopifyReadDatabaseUrl()).toBe("postgresql://ro:x@elsewhere:5432/mirror");
    });
    it("is null (mirror off) when SHOPIFY_READ_DB or DATABASE_URL is missing or unparsable", () => {
        delete process.env.SHOPIFY_READ_DATABASE_URL;
        delete process.env.SHOPIFY_READ_DB;
        process.env.DATABASE_URL = "postgresql://a:b@host:5432/checkin_dev";
        expect(config.shopifyReadDatabaseUrl()).toBeNull();
        process.env.SHOPIFY_READ_DB = "shopify_read_dev";
        delete process.env.DATABASE_URL;
        expect(config.shopifyReadDatabaseUrl()).toBeNull();
        process.env.DATABASE_URL = "not a url";
        expect(config.shopifyReadDatabaseUrl()).toBeNull();
    });
});
