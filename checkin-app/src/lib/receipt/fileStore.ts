/**
 * The receipt library's file store (#1265 S3 design §2). Deployed instances use a private bucket
 * with the ECS task role, as the membership agreement does; a laptop uses a temp directory.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ServiceError } from "@checkin/component-kit";
import type { ReceiptFileStore } from "@checkin/receipt";
import { config } from "@/lib/config";

let s3: S3Client | null = null;
function s3Client(): S3Client {
    if (!s3) s3 = new S3Client({ region: config.awsRegion() });
    return s3;
}

/** A deployed instance with no bucket refuses files; it never falls back to the database. */
function bucket(): string {
    const name = config.receiptFilesBucket();
    if (!name) throw new ServiceError(503, "Receipt file storage is not configured");
    return name;
}

export function createS3FileStore(): ReceiptFileStore {
    return {
        async put(key, bytes, sha256) {
            await s3Client().send(
                new PutObjectCommand({
                    Bucket: bucket(),
                    Key: key,
                    Body: bytes,
                    IfNoneMatch: "*",
                    // S3 takes base64 of the raw digest; the rows store it as hex.
                    ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
                }),
            );
        },
        async get(key) {
            try {
                const res = await s3Client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
                return res.Body ? await res.Body.transformToByteArray() : null;
            } catch (e) {
                if (e instanceof NoSuchKey || (e as { name?: string })?.name === "NoSuchKey") return null;
                throw e;
            }
        },
        async delete(key) {
            await s3Client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
        },
    };
}

export function createTempDirFileStore(root = join(tmpdir(), "checkin-receipt-files")): ReceiptFileStore {
    return {
        async put(key, bytes) {
            const path = join(root, key);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, bytes, { flag: "wx" });
        },
        async get(key) {
            try {
                return new Uint8Array(await readFile(join(root, key)));
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw e;
            }
        },
        async delete(key) {
            await rm(join(root, key), { force: true });
        },
    };
}
