import { emailAddressChecks, getConfigHealth, openConfigIssues, REQUIRED_EMAIL_SELECT, type ConfigCheck } from "@/lib/configHealth";

// config.ts reads process.env live through getters, so these tests just set/clear
// env vars — no module mocking needed. CHECKIN_ENV is the single fuse for the
// mocks and drives prod.

const ZOHO_KEYS = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"];
// The mirror check reads a RESOLVED url, so BOTH of its inputs have to be cleared:
// SHOPIFY_READ_DB (+ DATABASE_URL) feed the derived path and SHOPIFY_READ_DATABASE_URL
// the override. Miss one and an ambient value silently turns the "nothing configured"
// case green — the check would then never be able to fail here.
const MIRROR_KEYS = ["SHOPIFY_READ_DATABASE_URL", "SHOPIFY_READ_DB", "DATABASE_URL"];
const ALL_KEYS = [
    ...ZOHO_KEYS,
    ...MIRROR_KEYS,
    "ZOHO_WEBHOOK_SECRET",
    "AGREEMENT_PDF_S3_BUCKET",
    "RECEIPT_FILES_S3_BUCKET",
    "RESEND_API_KEY",
    "S_READ_TRIGGER_FUNCTION",
    "ANTHROPIC_API_KEY",
    "GMAIL_REFRESHER_FN",
    "RECEIPT_MAILBOX_ADDRESS",
    "RECEIPT_PROD_MAILBOX_ADDRESS",
    "CHECKIN_ENV",
];

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
    for (const k of ALL_KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
});
afterEach(() => {
    for (const k of ALL_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

const byId = (checks: ConfigCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe("getConfigHealth — prod, nothing configured", () => {
    it("every check fails and names its env var", () => {
        process.env.CHECKIN_ENV = "prod";
        const checks = getConfigHealth();
        const c = byId(checks);
        expect(c["zoho-esign"].ok).toBe(false);
        expect(c["zoho-esign"].detail).toContain("ZOHO_CLIENT_ID");
        expect(c["agreement-pdf-s3"].ok).toBe(false);
        expect(c["agreement-pdf-s3"].detail).toContain("AGREEMENT_PDF_S3_BUCKET");
        expect(c["kva-pdf-s3"].ok).toBe(false);
        expect(c["kva-pdf-s3"].detail).toContain("KVA_PDF_S3_KEY");
        expect(c["zoho-webhook-secret"].ok).toBe(false);
        expect(c["zoho-webhook-secret"].detail).toContain("ZOHO_WEBHOOK_SECRET");
        expect(c["resend-email"].ok).toBe(false);
        expect(c["resend-email"].detail).toContain("RESEND_API_KEY");
        expect(c["s-read-trigger"].ok).toBe(false);
        expect(c["s-read-trigger"].detail).toContain("S_READ_TRIGGER_FUNCTION");
        expect(c["s-read-mirror"].ok).toBe(false);
        expect(c["s-read-mirror"].detail).toContain("SHOPIFY_READ_DB");
        expect(c["receipt-ocr"].ok).toBe(false);
        expect(c["receipt-ocr"].detail).toContain("ANTHROPIC_API_KEY");
        expect(c["receipt-mailbox"].ok).toBe(false);
        expect(c["receipt-mailbox"].detail).toContain("RECEIPT_MAILBOX_ADDRESS");
        expect(c["receipt-files-s3"].ok).toBe(false);
        expect(c["receipt-files-s3"].detail).toContain("RECEIPT_FILES_S3_BUCKET");
        expect(openConfigIssues(checks)).toBe(10);
    });
});

describe("getConfigHealth — prod, all configured", () => {
    it("no open issues", () => {
        process.env.CHECKIN_ENV = "prod";
        process.env.ZOHO_CLIENT_ID = "id";
        process.env.ZOHO_CLIENT_SECRET = "secret";
        process.env.ZOHO_REFRESH_TOKEN = "refresh";
        process.env.ZOHO_WEBHOOK_SECRET = "whsecret";
        process.env.AGREEMENT_PDF_S3_BUCKET = "bucket";
        process.env.RESEND_API_KEY = "re_key";
        process.env.S_READ_TRIGGER_FUNCTION = "s-read-prod-trigger";
        // The mirror the way AWS actually wires it: no connection string of its own,
        // just the app's own credential pointed at the mirror's database name.
        process.env.DATABASE_URL = "postgresql://checkin_prod_dml:pw@host:5432/checkin_prod?sslmode=verify-full";
        process.env.SHOPIFY_READ_DB = "shopify_read_prod";
        process.env.ANTHROPIC_API_KEY = "sk-key";
        process.env.GMAIL_REFRESHER_FN = "gmail-refresher";
        process.env.RECEIPT_MAILBOX_ADDRESS = "receipts@example.org";
        process.env.RECEIPT_FILES_S3_BUCKET = "receipt-files";
        expect(openConfigIssues(getConfigHealth())).toBe(0);
    });
});

describe("getConfigHealth — local, nothing configured", () => {
    it("mock/local states keep every check green", () => {
        process.env.CHECKIN_ENV = "local";
        const checks = getConfigHealth();
        // Zoho + S3 ok via the active mock; webhook ok via mock-secret fallback;
        // Resend ok because email is optional outside prod.
        expect(openConfigIssues(checks)).toBe(0);
    });
});

describe("getConfigHealth — receipt files", () => {
    const check = () => byId(getConfigHealth())["receipt-files-s3"];

    it("is a gap on a deployed instance with no bucket", () => {
        process.env.CHECKIN_ENV = "prod";
        expect(check().ok).toBe(false);
        expect(check().detail).toContain("RECEIPT_FILES_S3_BUCKET");
    });

    it("is fine with a bucket, and on local without one", () => {
        process.env.CHECKIN_ENV = "prod";
        process.env.RECEIPT_FILES_S3_BUCKET = "bucket";
        expect(check().ok).toBe(true);
        delete process.env.RECEIPT_FILES_S3_BUCKET;
        process.env.CHECKIN_ENV = "local";
        expect(check().ok).toBe(true);
    });
});

describe("getConfigHealth — receipt mailbox", () => {
    const check = () => byId(getConfigHealth())["receipt-mailbox"];
    const setMailbox = () => {
        process.env.GMAIL_REFRESHER_FN = "gmail-refresher";
        process.env.RECEIPT_MAILBOX_ADDRESS = "receipts@example.org";
    };

    it.each([["dev"], ["stg"], ["local"]])("is no gap on %s with nothing set", (env) => {
        process.env.CHECKIN_ENV = env;
        expect(check().ok).toBe(true);
    });

    it.each([["dev"], ["stg"]])("is a gap on %s when set but refused, naming why", (env) => {
        process.env.CHECKIN_ENV = env;
        setMailbox();
        expect(check().ok).toBe(false);
        expect(check().detail).toContain("RECEIPT_PROD_MAILBOX_ADDRESS");
        process.env.RECEIPT_PROD_MAILBOX_ADDRESS = "real@example.org";
        expect(check().ok).toBe(true);
    });

    it("is a gap under an unknown CHECKIN_ENV, which binds nothing", () => {
        process.env.CHECKIN_ENV = "production";
        setMailbox();
        expect(check().ok).toBe(false);
        expect(check().detail).toContain("CHECKIN_ENV");
    });
});

describe("getConfigHealth — receipt OCR", () => {
    const check = () => byId(getConfigHealth())["receipt-ocr"];

    it.each([["dev"], ["stg"], ["prod"]])("is a gap on %s without the key", (env) => {
        process.env.CHECKIN_ENV = env;
        expect(check().ok).toBe(false);
        process.env.ANTHROPIC_API_KEY = "sk-key";
        expect(check().ok).toBe(true);
    });
});

describe("emailAddressChecks", () => {
    const FIELDS = [
        ["finance-alert-address", "financeAlertEmailAddress", "Finance alert address"],
        ["board-address", "boardEmailAddress", "Board address"],
        ["sysadmin-address", "sysadminEmailAddress", "Sysadmin list"],
        ["bg-reviewer-address", "bgReviewerEmailAddress", "Background-check reviewer list"],
        ["finance-contact-address", "financeContactEmail", "Finance contact address"],
    ] as const;
    const ALL_SET = Object.fromEntries(FIELDS.map(([, field]) => [field, "list@example.org"]));
    const checkFor = (id: string, settings: Record<string, string | null | undefined>): ConfigCheck => {
        const check = emailAddressChecks(settings).find((c) => c.id === id);
        if (!check) throw new Error(`no check ${id}`);
        return check;
    };

    it("selects exactly the five addresses", () => {
        expect(Object.keys(REQUIRED_EMAIL_SELECT).sort()).toEqual(FIELDS.map(([, field]) => field).sort());
    });

    it.each(FIELDS)("%s fails when %s is unset, naming the field and linking to Settings → Email", (id, field, label) => {
        for (const unset of [null, undefined, ""]) {
            const check = checkFor(id, { ...ALL_SET, [field]: unset });
            expect(check.ok).toBe(false);
            expect(check.detail).toContain(label);
            expect(check.detail).toContain("Settings → Email");
            expect(check.href).toBe("/settings/email");
        }
    });

    it.each(FIELDS)("%s passes when %s is set, without echoing the address", (id) => {
        const check = checkFor(id, ALL_SET);
        expect(check.ok).toBe(true);
        expect(check.detail).not.toContain("list@example.org");
    });

    it("has one check per address and none for the scholarship notify list", () => {
        expect(emailAddressChecks(ALL_SET).map((c) => c.id)).toEqual(FIELDS.map(([id]) => id));
    });

    it("fails all five when the settings row is missing, and each counts toward the badge", () => {
        const checks = emailAddressChecks(null);
        expect(checks.map((c) => c.ok)).toEqual([false, false, false, false, false]);
        const ok: ConfigCheck = { id: "x", label: "x", ok: true, detail: "" };
        expect(openConfigIssues([ok, ...checks])).toBe(5);
        expect(openConfigIssues([ok, ...emailAddressChecks({ ...ALL_SET, boardEmailAddress: null })])).toBe(1);
    });
});
