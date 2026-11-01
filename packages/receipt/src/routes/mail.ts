/** The held-mail queue and the ignored-file list, both FINANCE surfaces behind the registry. */
import { parseId, readJson } from "@checkin/component-kit";
import type { ReceiptFileRouteHandler, ReceiptRouteHandler } from "../contract";
import { mailQueueService } from "../services/mailQueueService";

const mailItemId = (raw: string | undefined): number => parseId(raw, "mail item id");

export const listHeld: ReceiptRouteHandler = async () => ({ ReceiptMailItem: await mailQueueService.listHeld() });

export const assign: ReceiptRouteHandler = async ({ req, params }) => ({
  ReceiptMailItem: await mailQueueService.assign(mailItemId(params.id), await readJson(req)),
});

export const discard: ReceiptRouteHandler = async ({ req, params }) => ({
  ReceiptMailItem: await mailQueueService.discard(mailItemId(params.id), await readJson(req)),
});

/** The only way a held mail item's bytes leave; the service audits every read. */
export const file: ReceiptFileRouteHandler = async ({ params }) => {
  const stored = await mailQueueService.getFile(mailItemId(params.id));
  return {
    row: { id: stored.id, fileBlob: stored.fileBlob },
    contentType: stored.mimeType,
    filename: stored.mimeType === "text/plain" ? `mail-item-${params.id}.txt` : undefined,
  };
};

export const ignoreReceiptFile: ReceiptRouteHandler = async ({ req, params }) => ({
  ReceiptIgnoredFileView: await mailQueueService.ignoreReceiptFile(params.id, await readJson(req)),
});

export const listIgnored: ReceiptRouteHandler = async () => ({ ReceiptIgnoredFileView: await mailQueueService.listIgnored() });

export const removeIgnored: ReceiptRouteHandler = async ({ params }) => ({
  ReceiptIgnoredFileView: await mailQueueService.removeIgnored(parseId(params.id, "ignored file id")),
});
