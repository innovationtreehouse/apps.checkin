/**
 * @jest-environment node
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createS3FileStore, createTempDirFileStore } from "../fileStore";

const sendMock = jest.fn();
jest.mock("@aws-sdk/client-s3", () => {
    class NoSuchKey extends Error {}
    const command = (input: unknown) => ({ input });
    return {
        S3Client: jest.fn().mockImplementation(() => ({ send: sendMock })),
        PutObjectCommand: jest.fn().mockImplementation(command),
        GetObjectCommand: jest.fn().mockImplementation(command),
        DeleteObjectCommand: jest.fn().mockImplementation(command),
        NoSuchKey,
    };
});

const BYTES = new Uint8Array(Buffer.from("receipt"));
const digest = createHash("sha256").update(BYTES);

describe("S3 file store", () => {
    const saved = process.env.RECEIPT_FILES_S3_BUCKET;
    beforeEach(() => {
        sendMock.mockReset();
        process.env.RECEIPT_FILES_S3_BUCKET = "bucket";
    });
    afterAll(() => {
        if (saved === undefined) delete process.env.RECEIPT_FILES_S3_BUCKET;
        else process.env.RECEIPT_FILES_S3_BUCKET = saved;
    });

    it("writes once, with the stored hex hash re-encoded as base64 of the raw digest", async () => {
        const hex = digest.copy().digest("hex");
        await createS3FileStore().put("receipts/r1", BYTES, hex);
        expect(sendMock.mock.calls[0][0].input).toEqual({
            Bucket: "bucket",
            Key: "receipts/r1",
            Body: BYTES,
            IfNoneMatch: "*",
            ChecksumSHA256: digest.copy().digest("base64"),
        });
    });

    it("reads a missing object as null and rethrows anything else", async () => {
        const store = createS3FileStore();
        sendMock.mockRejectedValueOnce(Object.assign(new Error("gone"), { name: "NoSuchKey" }));
        await expect(store.get("receipts/r1")).resolves.toBeNull();
        sendMock.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDenied" }));
        await expect(store.get("receipts/r1")).rejects.toThrow("denied");
    });

    it("refuses with 503 and calls nothing when no bucket is set", async () => {
        delete process.env.RECEIPT_FILES_S3_BUCKET;
        await expect(createS3FileStore().put("receipts/r1", BYTES, "00")).rejects.toMatchObject({ status: 503 });
        expect(sendMock).not.toHaveBeenCalled();
    });
});

describe("temp-directory file store", () => {
    it("round-trips, writes once, and reads a deleted file as null", async () => {
        const root = await mkdtemp(join(tmpdir(), "receipt-store-test-"));
        try {
            const store = createTempDirFileStore(root);
            await store.put("mail-items/a", BYTES, "unused");
            expect(await store.get("mail-items/a")).toEqual(BYTES);
            await expect(store.put("mail-items/a", BYTES, "unused")).rejects.toThrow();
            await store.delete("mail-items/a");
            expect(await store.get("mail-items/a")).toBeNull();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
