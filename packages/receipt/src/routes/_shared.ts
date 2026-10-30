/** Body readers for the route factories. */
import { httpError } from "@checkin/component-kit";
import { readCapped } from "@checkin/utils";

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
