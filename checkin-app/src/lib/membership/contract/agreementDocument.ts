import { GetObjectCommand, HeadObjectCommand, NoSuchKey, NotFound, S3Client } from "@aws-sdk/client-s3";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import { config } from "@/lib/config";

/**
 * Loader for the static agreement PDFs that get uploaded to Zoho Sign: the
 * membership agreement and the Key Volunteer Agreement, two objects in one bucket.
 * We do NOT generate the PDF — Zoho overlays the signature fields onto this file
 * (Printed Name prefilled). Reads the last-page index + dimensions the way the
 * source-of-truth script used pymupdf, but via pdf-lib (pure JS).
 *
 * The PDF is NOT committed to the repo: it lives in a private S3 bucket and is
 * fetched here at runtime with the ECS task role (region + credentials come from
 * the environment — no static creds in the image). One bucket/key serves every
 * env; non-prod signatures are watermarked at upload time (see stampWatermark).
 *
 * When the bucket is unset or the object is missing, loadAgreementPdf() throws
 * AgreementUnavailableError (the sign endpoint then reports a clean 503) rather
 * than uploading a placeholder.
 */

/** Filename shown in Zoho for the uploaded document. */
export const AGREEMENT_FILENAME = "membership-agreement.pdf";
export const KVA_FILENAME = "key-volunteer-agreement.pdf";

export interface LoadedAgreement {
    pdf: Buffer;
    /** Zero-based last-page index (fields sit on the last page, per the script). */
    lastPageNo: number;
    pageWidth: number;
    pageHeight: number;
}

export class AgreementUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AgreementUnavailableError";
    }
}

// One client per process; region (and task-role credentials) resolve from the
// environment the container runs in (AWS_REGION is set on the ECS task def).
let s3: S3Client | null = null;
function s3Client(): S3Client {
    if (!s3) s3 = new S3Client({ region: config.awsRegion() });
    return s3;
}

/** Read the membership agreement PDF from S3 and the geometry needed to place the signature fields. */
export function loadAgreementPdf(): Promise<LoadedAgreement> {
    return loadPdf(config.agreementPdfKey(), "Membership agreement");
}

/** Read the Key Volunteer Agreement PDF (`KVA_PDF_S3_KEY`) the same way. */
export function loadKvaPdf(): Promise<LoadedAgreement> {
    return loadPdf(config.kvaPdfKey(), "Key Volunteer Agreement");
}

/** True when the Key Volunteer Agreement PDF is in the bucket. */
export async function kvaDocumentInPlace(): Promise<boolean> {
    const bucket = config.agreementPdfBucket();
    if (!bucket) return false;
    try {
        await s3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: config.kvaPdfKey() }));
        return true;
    } catch (e) {
        if (e instanceof NotFound || (e as { name?: string })?.name === "NotFound") return false;
        throw e;
    }
}

async function loadPdf(key: string, label: string): Promise<LoadedAgreement> {
    const bucket = config.agreementPdfBucket();
    if (!bucket) {
        throw new AgreementUnavailableError(
            `${label} bucket is not configured (AGREEMENT_PDF_S3_BUCKET unset).`,
        );
    }

    let pdf: Buffer;
    try {
        const res = await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        pdf = Buffer.from(await res.Body!.transformToByteArray());
    } catch (e) {
        // Missing object (not yet uploaded) → unavailable, not a hard error. The
        // task role has s3:ListBucket so this surfaces as NoSuchKey, not a 403.
        if (e instanceof NoSuchKey || (e as { name?: string })?.name === "NoSuchKey") {
            throw new AgreementUnavailableError(`${label} PDF not found at s3://${bucket}/${key}.`);
        }
        throw e;
    }

    const doc = await PDFDocument.load(pdf);
    const lastPageNo = doc.getPageCount() - 1;
    const { width, height } = doc.getPage(lastPageNo).getSize();
    return { pdf, lastPageNo, pageWidth: width, pageHeight: height };
}

/**
 * Stamp a diagonal watermark across every page — used on NON-prod instances so a
 * test signature is unmistakably marked as such, both in the signing ceremony and
 * on the final signed PDF. Server-controlled (driven by CHECKIN_ENV), so the
 * applicant can't remove or edit it. Page geometry is unchanged, so signature
 * field placement still matches loadAgreementPdf()'s dimensions. Never applied in
 * prod, which must produce a clean, binding agreement.
 */
export async function stampWatermark(pdf: Buffer, text: string): Promise<Buffer> {
    const doc = await PDFDocument.load(pdf);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    for (const page of doc.getPages()) {
        const { width, height } = page.getSize();
        page.drawText(text, {
            x: width * 0.1,
            y: height * 0.42,
            size: 26,
            font,
            color: rgb(0.85, 0.1, 0.1),
            opacity: 0.22,
            rotate: degrees(45),
        });
    }
    return Buffer.from(await doc.save());
}
