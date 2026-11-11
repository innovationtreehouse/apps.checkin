/** Body readers and line-owner stamps for the route factories. */
import { httpError } from "@checkin/component-kit";
import { readCapped } from "@checkin/utils";
import type { ReceiptRouteCtx } from "../contract";

/** A 10 MB file plus multipart framing: the host's API upload ceiling, which its test pins to this. */
export const MAX_UPLOAD_BODY_BYTES = 11 * 1024 * 1024;

const tooLarge = (message = "Receipt upload is too large") => httpError(413, message);

/**
 * The upload's multipart form, read under the upload ceiling; the service then holds the file
 * itself to its exact cap.
 */
export async function readUploadForm(req: Request): Promise<FormData> {
  const chunks = await readCapped(req.body, req.headers.get("content-length"), MAX_UPLOAD_BODY_BYTES, () => tooLarge());
  try {
    return await new Response(new Blob(chunks), { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw httpError(400, "Expected multipart/form-data");
  }
}

/** A capped JSON body: 413 (with `tooLargeMessage`) past the cap, 400 when it is not JSON. */
export async function readJsonCapped(
  body: AsyncIterable<Uint8Array> | null,
  declaredLength: string | null,
  cap: number,
  tooLargeMessage: string,
): Promise<unknown> {
  const chunks = await readCapped(body, declaredLength, cap, () => tooLarge(tooLargeMessage));
  try {
    return JSON.parse(await new Blob(chunks).text());
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

/**
 * A line row carries no owner column, and the host's stripper scopes each nested row by itself,
 * so a submitter's lines are stamped with their receipt's uploader or `their_own` strips them.
 */
export function stampLines<T extends object>(lines: T[], uploadedByUserId: number): (T & { uploadedByUserId: number })[] {
  return lines.map((line) => ({ ...line, uploadedByUserId }));
}

/**
 * One line a write returned. A submitter's write reached only their own receipt, so it is
 * stamped with their id; finance reads every line and needs no stamp.
 */
export function ownLine<T extends object>({ access, submitterActorId }: ReceiptRouteCtx, line: T): T {
  if (access !== "submitter") return line;
  if (submitterActorId === null) throw httpError(401, "Unauthorized");
  return { ...line, uploadedByUserId: submitterActorId };
}
