import { config } from "@/lib/config";

/**
 * One config-health check: an integration/env that must be wired for a feature to
 * work. `ok` is a boolean derived from presence checks (never a secret value);
 * `detail` is static English naming which env var to set. Server-only — surfaced
 * to admins + board via /api/system-status/config-health (full list) and the nav
 * badge count in /api/nav/todo-counts.
 */
export type ConfigCheck = { id: string; label: string; ok: boolean; detail: string };

/**
 * The config-health checks, in display order. Each entry's `ok` encodes the
 * env-appropriate rule so dev/mock states don't report a false gap (a dev box
 * running the Zoho mock is healthy, not "unconfigured"). Add a check by appending
 * one object — the badge count, the page rows, and the endpoint are all list-driven.
 */
export function getConfigHealth(): ConfigCheck[] {
    const mock = config.zohoMockActive(); // dev/local with real Zoho unset — the designed mock state
    return [
        {
            id: "zoho-esign",
            label: "Zoho e-sign",
            // real OR mock ⇒ sign flow usable (mirrors config.zohoAvailable()).
            ok: config.zohoConfigured() || mock,
            detail: config.zohoConfigured()
                ? "Real integration configured."
                : mock
                  ? "Dev mock active (real secrets unset; expected in non-prod)."
                  : "NOT configured — set ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN.",
        },
        {
            id: "agreement-pdf-s3",
            label: "Agreement PDF (S3)",
            // The Zoho mock skips the S3 PDF load, so the bucket isn't required when it's active.
            ok: !!config.agreementPdfBucket() || mock,
            detail: config.agreementPdfBucket()
                ? "Bucket configured."
                : mock
                  ? "Not required — Zoho mock skips the S3 PDF load."
                  : "NOT configured — set AGREEMENT_PDF_S3_BUCKET (sign endpoint 503s without it).",
        },
        {
            id: "kva-pdf-s3",
            label: "Key Volunteer Agreement PDF (S3)",
            // Presence only: whether the object itself is uploaded shows on the membership settings page.
            ok: !!config.agreementPdfBucket() || mock,
            detail: config.agreementPdfBucket()
                ? `Read from ${config.kvaPdfKey()} in the agreement bucket (KVA_PDF_S3_KEY).`
                : mock
                  ? "Not required — Zoho mock skips the S3 PDF load."
                  : "NOT configured — set AGREEMENT_PDF_S3_BUCKET; the Key Volunteer Agreement is read from KVA_PDF_S3_KEY in it.",
        },
        {
            id: "receipt-files-s3",
            label: "Receipt files (S3)",
            // Only a gap once new files go to the bucket; a laptop uses a temp directory.
            ok: config.isLocal() || !config.receiptFilesS3() || !!config.receiptFilesBucket(),
            detail: config.receiptFilesBucket()
                ? "Bucket configured."
                : config.isLocal()
                  ? "Not required on local; files go to a temp directory."
                  : config.receiptFilesS3()
                    ? "NOT configured — set RECEIPT_FILES_S3_BUCKET (receipt uploads and mail intake 503 without it)."
                    : "Not set (fine while RECEIPT_FILES_S3 is off).",
        },
        {
            id: "zoho-webhook-secret",
            label: "Zoho webhook secret",
            // zohoWebhookSecret() falls back to the fixed mock secret when the mock is active,
            // so this is non-null in dev and null only on a real-but-unwired instance.
            ok: !!config.zohoWebhookSecret(),
            detail: config.zohoWebhookSecret()
                ? "Configured."
                : "NOT configured — set ZOHO_WEBHOOK_SECRET (status webhook fails verification).",
        },
        {
            id: "resend-email",
            label: "Email (Resend)",
            // No mock/fallback for sending. Only a gap in prod — a dev box legitimately runs
            // without an email key, and there's no self-fired mock to keep it green.
            ok: !config.isProd() || !!config.resendApiKey(),
            detail: config.resendApiKey()
                ? "API key configured."
                : config.isProd()
                  ? "NOT configured — set RESEND_API_KEY (outbound email disabled)."
                  : "Not set (fine outside prod; outbound email disabled).",
        },
        {
            id: "s-read-trigger",
            label: "Shopify sync trigger",
            // A laptop has no AWS to invoke, so this is only a gap on a deployed instance
            // (dev included — dev has its own s-read-dev-trigger). Same shape as Resend above.
            ok: config.isLocal() || !!config.sReadTriggerFunction(),
            detail: config.sReadTriggerFunction()
                ? "Trigger function configured."
                : config.isLocal()
                  ? "Not set (fine on local; no AWS to invoke)."
                  : "NOT configured — set S_READ_TRIGGER_FUNCTION (the board's 'Sync Shopify now' button 503s without it).",
        },
        {
            id: "s-read-mirror",
            label: "Shopify mirror (read)",
            // Distinct from the trigger above: that one ASKS s-read to sync, this one READS
            // what s-read wrote. Different wiring, and an env can have either without the
            // other — so they are two checks, not one.
            //
            // Deliberately checks the RESOLVED url, not a raw env var: in AWS there is no
            // mirror connection string — it's derived from DATABASE_URL + SHOPIFY_READ_DB
            // (config.shopifyReadDatabaseUrl()), and SHOPIFY_READ_DATABASE_URL is only a
            // local-dev override. Naming one var would report a false gap on whichever of
            // the two paths the env doesn't use.
            ok: config.isLocal() || !!config.shopifyReadDatabaseUrl(),
            detail: config.shopifyReadDatabaseUrl()
                ? "Mirror connection configured."
                : config.isLocal()
                  ? "Not set (fine on local; no mirror to read)."
                  : "NOT configured — set SHOPIFY_READ_DB ('Live payment' stays blank and the reconciler backstop no-ops).",
        },
    ];
}

/** Count of failing checks — the red nav-badge number. */
export function openConfigIssues(checks: ConfigCheck[] = getConfigHealth()): number {
    return checks.filter((c) => !c.ok).length;
}
