// Gmail intake (#1265 §2a): the last catch-up step of the host's daily cron. Each mailed file
// becomes a receipt by its authenticated sender, a deferred item when that sender is over their
// daily upload limit, or a held mail item for finance.
import { createHash } from "node:crypto";
import { isServiceError, ServiceError } from "@checkin/component-kit";
import { isUniqueConstraintError } from "@checkin/pg-kit";
import { db } from "../db";
import type { MailboxReader, MailMessage, MailPart, ReceiptPrincipal } from "../contract";
import type { Prisma } from "../generated/prisma/client";
import { ACCEPTED_TYPES, checkReceiptFile, MAX_FILE_BYTES } from "../lib/file-type";
import { getOrg, mailbox, ports } from "../runtime";
import { discardBodyCopy, intakeMailedReceipt } from "./receiptService";
import { OrgUploadLimitError } from "../lib/insert";

// ponytail: no stored cursor; the ledger makes re-reads free. Ceiling is a cron outage longer than the
// window, or more than MAIL_WINDOW_DAYS × MAIL_CAP mailed receipts inside one window; widen either then.
export const MAIL_WINDOW_DAYS = 3;
/** New receipts (OCR calls) per run, oldest mail first; the rest wait for the next run, inside the window. Held items do not count. */
export const MAIL_CAP = 10;
/** Downloads charged to held mail per run (see chargeHold); the rest wait for the next run. */
export const MAIL_HELD_CAP = 50;
/** Bytes charged to held mail per run (see chargeHold), checked before each download. */
export const MAIL_HELD_BYTES = 50 * 1024 * 1024;
/** Held and deferred items past which nothing more is stored; finance is alerted once per run while over it. */
export const MAIL_HELD_CEILING = 500;
// ponytail: every listed message is fetched each run before the ledger is checked, so a flood larger than this
// budget's worth of fetches can still push a later receipt past the window; record unheld message ids then.
/** Wall time per run; messages not reached wait for the next run. */
export const MAIL_TIME_BUDGET_MS = 2 * 60_000;

export type MailIntakeResult =
  | { status: "unbound" }
  | {
      status: "ok";
      messages: number;
      receipts: number;
      held: number;
      skipped: number;
      rejected: number;
      failed: number;
      /** Files put off by a per-run cap or byte budget; read again next run. */
      deferred: number;
      /** Files from a known sender over their daily upload limit, stored to retry on a later run. */
      overLimit: number;
      /** Files not held because the held ceiling was reached. */
      overCeiling: number;
      /** Messages not reached, past the time budget or with every cap spent; read again next run. */
      unread: number;
      /** Files never receipts: inline images under the floor, trivial bodies, and files on the ignore list. */
      ignored: number;
    };

type Headers = { name: string; value: string }[];

const headerValues = (headers: Headers | undefined, name: string): string[] =>
  (headers ?? []).filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value);

const ADDR_SPEC = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;

/** The addr-spec of the message's single `From` header holding a single address, lowercased; else null. */
export function fromAddress(headers: Headers | undefined): string | null {
  const froms = headerValues(headers, "From");
  if (froms.length !== 1) return null;
  const bare = froms[0].replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/\([^()]*\)/g, "");
  // A comma lists two addresses; a colon or semicolon is group syntax.
  if (/[,;:]/.test(bare)) return null;
  const angles = [...bare.matchAll(/<([^<>]*)>/g)];
  const spec = angles.length === 1 ? angles[0][1] : angles.length === 0 && !/[<>]/.test(bare) ? bare : null;
  const trimmed = spec?.trim().toLowerCase();
  return trimmed && ADDR_SPEC.test(trimmed) ? trimmed : null;
}

type AuthResToken = { word: string } | { sep: ";" | "=" };

/**
 * RFC 8601 lexer. Comments are dropped and act as whitespace; a quoted string joins its word as
 * plain text, so a `;` or `=` inside it never separates. Outside quotes `;` separates, and so
 * does the first `=` of each whitespace-delimited run: later ones stay literal, as in a base64
 * `header.b` value. Null when a comment or quoted string is unterminated, or a comment holds a
 * `"`: Google's own comments never do, so one there is sender text echoed into the comment.
 */
function lexAuthResults(value: string): AuthResToken[] | null {
  const tokens: AuthResToken[] = [];
  let word: string | null = null;
  let sawEq = false;
  const flush = () => {
    if (word !== null) tokens.push({ word });
    word = null;
  };
  const space = () => {
    flush();
    sawEq = false;
  };
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "(") {
      space();
      for (let depth = 1; depth > 0; ) {
        i++;
        if (i >= value.length) return null;
        if (value[i] === "\\") i++;
        else if (value[i] === '"') return null;
        else if (value[i] === "(") depth++;
        else if (value[i] === ")") depth--;
      }
    } else if (c === '"') {
      let text = "";
      for (i++; value[i] !== '"'; i++) {
        if (value[i] === "\\") i++;
        if (i >= value.length) return null;
        text += value[i];
      }
      word = (word ?? "") + text;
    } else if (c === ";") {
      space();
      tokens.push({ sep: c });
    } else if (c === "=" && !sawEq) {
      flush();
      sawEq = true;
      tokens.push({ sep: c });
    } else if (/\s/.test(c)) space();
    else word = (word ?? "") + c;
  }
  flush();
  return tokens;
}

type ResInfo = { method: string; result: string; props: [string, string][] };

/**
 * The authserv-id and method results of one `Authentication-Results` value; null when it does
 * not parse. A clause's token shape is matched as a string: `w` a word, separators as themselves.
 */
function parseAuthResults(value: string): { authservId: string; results: ResInfo[] } | null {
  const tokens = lexAuthResults(value);
  if (!tokens) return null;
  const clauses: AuthResToken[][] = [[]];
  for (const t of tokens) {
    if ("sep" in t && t.sep === ";") clauses.push([]);
    else clauses[clauses.length - 1].push(t);
  }
  const shape = (c: AuthResToken[]) => c.map((t) => ("word" in t ? "w" : t.sep)).join("");
  const words = (c: AuthResToken[]) => c.flatMap((t) => ("word" in t ? [t.word] : []));

  const [head, ...rest] = clauses;
  const [authservId, version] = words(head);
  // authserv-id [authres-version]
  if (!/^ww?$/.test(shape(head)) || (version !== undefined && !/^\d+$/.test(version))) return null;
  // no-result
  if (rest.length === 1 && shape(rest[0]) === "w" && words(rest[0])[0].toLowerCase() === "none") {
    return { authservId, results: [] };
  }
  const results: ResInfo[] = [];
  for (const clause of rest) {
    // method[/version]=result, then key=value pairs (reasonspec and propspecs)
    if (!/^w=w(w=w)*$/.test(shape(clause))) return null;
    const [methodspec, result, ...pairs] = words(clause);
    const props: [string, string][] = [];
    for (let i = 0; i < pairs.length; i += 2) props.push([pairs[i], pairs[i + 1]]);
    results.push({ method: methodspec.replace(/\/\d+$/, ""), result, props });
  }
  return { authservId, results };
}

// Characters an envelope local part can hold only when quoted; quoted, it can end Gmail's comment early.
const UNSAFE_ENVELOPE = /["();\\]/;

/** False when the envelope sender, in any `Return-Path` or `smtp.mailfrom` value, holds an UNSAFE_ENVELOPE character. */
const envelopeSafe = (headers: Headers | undefined, authResults: string): boolean =>
  headerValues(headers, "Return-Path").every((v) => !UNSAFE_ENVELOPE.test(v)) &&
  [...authResults.matchAll(/smtp\.mailfrom=([^\s;]*)/gi)].every((m) => !UNSAFE_ENVELOPE.test(m[1]));

/**
 * True when Google's own verdict says the `From` domain passed DMARC. Only the topmost
 * `Authentication-Results` header counts, and only when Google wrote it: a sender can write
 * any header below it. Gmail echoes the envelope sender into the header, so a sender that could
 * break its syntax fails before parsing; anything ambiguous after (unparseable, two dmarc
 * results, two header.from properties) fails closed too.
 */
export function dmarcAligned(headers: Headers | undefined, address: string): boolean {
  const topmost = headerValues(headers, "Authentication-Results")[0];
  if (topmost === undefined || !envelopeSafe(headers, topmost)) return false;
  const parsed = parseAuthResults(topmost);
  if (!parsed || parsed.authservId.toLowerCase() !== "mx.google.com") return false;
  const dmarc = parsed.results.filter((r) => r.method.toLowerCase() === "dmarc");
  if (dmarc.length !== 1 || dmarc[0].result.toLowerCase() !== "pass") return false;
  const from = dmarc[0].props.filter(([key]) => key.toLowerCase() === "header.from");
  return from.length === 1 && from[0][1].toLowerCase() === address.split("@")[1];
}

/** Every part outside a forwarded message: an attached message's headers and parts are never read. */
function ownParts(part: MailPart): MailPart[] {
  if (part.mimeType.toLowerCase() === "message/rfc822") return [];
  return [part, ...(part.parts ?? []).flatMap(ownParts)];
}

const isAttachment = (p: MailPart) =>
  !!p.filename && !/^\s*inline/i.test(headerValues(p.headers, "Content-Disposition")[0] ?? "");

type MailFile = { declaredType: string; size: number; read: () => Promise<Buffer>; body?: true };

// ponytail: a legible receipt image under the floor is skipped silently; lower it if one is ever found.
/** Inline images under this declared size (tracking pixels, icons, small logos) are skipped without a download. */
export const INLINE_FLOOR_BYTES = 5 * 1024;

// ponytail: a body printing its total without cents reads as trivial; widen the pattern if one is found.
/** A money amount: a number with two decimal places. A body without one is trivial. */
const MONEY_AMOUNT = /\d\.\d{2}(?!\d)/;

/**
 * A message's candidate files, read in this order: each attachment of an accepted type, each inline
 * part of an accepted non-text type at or over the floor, then the body, stored as text, unless it
 * holds no money amount. `ignored` counts the inline parts under the floor and a trivial body.
 */
export function mailFiles(msg: MailMessage, reader: MailboxReader): { files: MailFile[]; ignored: number } {
  const parts = ownParts(msg.payload);
  const typeOf = (p: MailPart) => p.mimeType.toLowerCase();
  const read = (p: MailPart) => async () =>
    p.body?.data !== undefined
      ? Buffer.from(p.body.data, "base64url")
      : p.body?.attachmentId
        ? reader.getAttachment(msg.id, p.body.attachmentId)
        : Buffer.alloc(0);
  const file = (p: MailPart, declaredType = typeOf(p)): MailFile => ({ declaredType, size: p.body?.size ?? 0, read: read(p) });

  const attachments = parts.filter((p) => isAttachment(p) && ACCEPTED_TYPES.has(typeOf(p)));
  const inline = parts.filter((p) => !isAttachment(p) && typeOf(p) !== "text/plain" && ACCEPTED_TYPES.has(typeOf(p)));
  const sized = inline.filter((p) => (p.body?.size ?? 0) >= INLINE_FLOOR_BYTES);
  let ignored = inline.length - sized.length;

  const bodyPart = (type: string) => parts.find((p) => !isAttachment(p) && typeOf(p) === type && p.body?.data);
  // HTML is stored as its source text: a receipt file is never served as a page.
  const body = bodyPart("text/plain") ?? bodyPart("text/html");
  const files = [...attachments, ...sized].map((p) => file(p));
  if (body) {
    if (MONEY_AMOUNT.test(Buffer.from(body.body?.data ?? "", "base64url").toString())) files.push({ ...file(body, "text/plain"), body: true });
    else ignored++;
  }
  return { files, ignored };
}

const isStatus = (err: unknown, code: number) => isServiceError(err) && err.status === code;

/** The statuses whose items keep their file in the ledger, awaiting finance or a later run. */
export const STORED_STATUSES = ["held", "deferred"];

/**
 * Make a deferred item a receipt uploaded by its sender. The item flips to `assigned` in the
 * receipt's own insert, so a concurrent retry or release leaves no second receipt (409).
 */
export async function intakeDeferred(
  item: { id: number; fileBlob: Uint8Array; mimeType: string },
  sender: ReceiptPrincipal,
  { uploadLimits, onClaim }: { uploadLimits: boolean; onClaim?: (tx: Prisma.TransactionClient, receiptId: string) => Promise<unknown> },
): Promise<string> {
  return intakeMailedReceipt(
    sender,
    Buffer.from(item.fileBlob),
    item.mimeType,
    async (tx, receiptId) => {
      const claimed = await tx.receiptMailItem.updateMany({
        where: { id: item.id, status: "deferred" },
        data: { status: "assigned", receiptId, fileBlob: null },
      });
      if (claimed.count !== 1) throw new ServiceError(409, "This mail item was already handled. Refresh and retry.");
      await onClaim?.(tx, receiptId);
    },
    { uploadLimits },
  );
}

export async function readMailbox(): Promise<MailIntakeResult> {
  const reader = mailbox();
  if (!reader) return { status: "unbound" };
  const started = Date.now();
  const orgId = (await getOrg()).id;
  const unresolved = await db.receiptMailItem.count({ where: { orgId, status: { in: STORED_STATUSES } } });
  const counts = { messages: 0, receipts: 0, held: 0, skipped: 0, rejected: 0, failed: 0, deferred: 0, overLimit: 0, overCeiling: 0, unread: 0, ignored: 0 };
  const ignoredHashes = new Set(
    (await db.receiptIgnoredFile.findMany({ where: { orgId }, select: { fileHash: true } })).map((r) => r.fileHash),
  );
  let heldFiles = 0;
  let heldBytes = 0;
  const capped = () => counts.receipts >= MAIL_CAP;
  const outOfTime = () => Date.now() - started >= MAIL_TIME_BUDGET_MS;
  const stored = () => unresolved + counts.held + counts.overLimit;
  const holdsSpent = () => heldFiles >= MAIL_HELD_CAP || stored() >= MAIL_HELD_CEILING;

  /**
   * The one charging rule for the held budget: each file downloaded from an unknown sender, and each
   * file deferred for a known one, costs one file and its larger stated or actual size, whatever comes of it.
   */
  function chargeHold(file: MailFile, bytes: Buffer): void {
    heldFiles++;
    heldBytes += Math.max(file.size, bytes.length);
  }

  /** Whether a file of this size may be held now; counts it as deferred or over the ceiling when not. */
  function roomToHold(size: number): boolean {
    if (stored() >= MAIL_HELD_CEILING) {
      counts.overCeiling++;
      return false;
    }
    if (heldFiles >= MAIL_HELD_CAP || heldBytes + size > MAIL_HELD_BYTES) {
      counts.deferred++;
      return false;
    }
    return true;
  }

  /** A body read beside its message's other receipts is discarded when its reading repeats one of them. */
  async function discardIfCopy(gmailMessageId: string, receiptId: string): Promise<void> {
    const siblings = await db.receiptMailItem.findMany({
      where: { gmailMessageId, receiptId: { not: null }, NOT: { receiptId } },
      select: { receiptId: true },
    });
    try {
      await discardBodyCopy(receiptId, siblings.flatMap((s) => (s.receiptId ? [s.receiptId] : [])));
    } catch (err) {
      // The body stays its own receipt; finance discards it the ordinary way.
      console.error("[receipt] body copy check failed for one receipt:", err);
    }
  }

  async function readMessage(msg: MailMessage, reader: MailboxReader): Promise<void> {
    const { files, ignored } = mailFiles(msg, reader);
    counts.ignored += ignored;
    // Every file already in the ledger: nothing to download.
    if (files.length > 0 && (await db.receiptMailItem.count({ where: { gmailMessageId: msg.id } })) >= files.length) {
      counts.skipped += files.length;
      return;
    }
    const headers = msg.payload.headers;
    const address = fromAddress(headers);
    const sender: ReceiptPrincipal | null =
      address && dmarcAligned(headers, address) ? await ports().people.submitterByEmail(address) : null;

    for (const file of files) {
      if (sender && capped()) {
        counts.deferred++;
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        counts.rejected++;
        continue;
      }
      if (!sender && !roomToHold(file.size)) continue;
      const bytes = await file.read();
      if (!sender) chargeHold(file, bytes);
      const key = { gmailMessageId: msg.id, attachmentHash: createHash("sha256").update(bytes).digest("hex") };
      if (ignoredHashes.has(key.attachmentHash)) {
        counts.ignored++;
        continue;
      }
      const check = checkReceiptFile(bytes, file.declaredType);
      if (!check.ok) {
        counts.rejected++;
        continue;
      }
      if (await db.receiptMailItem.findUnique({ where: { gmailMessageId_attachmentHash: key }, select: { id: true } })) {
        counts.skipped++;
        continue;
      }
      const item = { orgId, ...key, receivedAt: new Date(Number(msg.internalDate)), senderAddress: address ?? "" };
      try {
        if (sender) {
          try {
            const receiptId = await intakeMailedReceipt(sender, bytes, check.mimeType, (tx, newId) =>
              tx.receiptMailItem.create({ data: { ...item, status: "assigned", receiptId: newId } }),
            );
            counts.receipts++;
            if (file.body) await discardIfCopy(msg.id, receiptId);
            continue;
          } catch (err) {
            // Over the sender's daily upload limit: stored to retry on a later run.
            if (!isStatus(err, 429)) throw err;
          }
          if (!roomToHold(bytes.length)) continue;
          chargeHold(file, bytes);
        }
        const status = sender ? "deferred" : "held";
        await db.receiptMailItem.create({ data: { ...item, status, fileBlob: new Uint8Array(bytes), mimeType: check.mimeType } });
        counts[sender ? "overLimit" : "held"]++;
      } catch (err) {
        // A concurrent run took this file first.
        if (!isUniqueConstraintError(err)) throw err;
        counts.skipped++;
      }
    }
  }

  /**
   * Deferred items, oldest first, inside the run's receipt cap. A retry refused by the daily limit
   * spends no cap and no OCR call, and that sender's other deferred items wait for the next run;
   * the org-wide limit stops every retry for the run.
   * A sender who is no longer a submitter has their items held for finance.
   */
  async function retryDeferred(): Promise<void> {
    const rows = await db.receiptMailItem.findMany({
      where: { orgId, status: "deferred" },
      select: { id: true, senderAddress: true },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    });
    const limited = new Set<string>();
    for (const row of rows) {
      if (capped() || outOfTime()) return;
      if (limited.has(row.senderAddress)) continue;
      try {
        const sender = await ports().people.submitterByEmail(row.senderAddress);
        if (!sender) {
          await db.receiptMailItem.updateMany({ where: { id: row.id, status: "deferred" }, data: { status: "held" } });
          continue;
        }
        const item = await db.receiptMailItem.findFirst({ where: { id: row.id, status: "deferred" }, select: { id: true, fileBlob: true, mimeType: true } });
        if (!item?.fileBlob || !item.mimeType) continue;
        await intakeDeferred({ ...item, fileBlob: item.fileBlob, mimeType: item.mimeType }, sender, { uploadLimits: true });
        counts.receipts++;
      } catch (err) {
        if (err instanceof OrgUploadLimitError) return;
        if (isStatus(err, 429)) limited.add(row.senderAddress);
        else if (isStatus(err, 409)) counts.skipped++;
        else {
          counts.failed++;
          console.error("[receipt] deferred mail retry failed for one item:", err);
        }
      }
    }
  }

  await retryDeferred();

  const ids = await reader.listRecent(MAIL_WINDOW_DAYS);
  for (const [i, id] of ids.entries()) {
    if ((capped() && holdsSpent()) || outOfTime()) {
      counts.unread = ids.length - i;
      break;
    }
    counts.messages++;
    try {
      await readMessage(await reader.getMessage(id), reader);
    } catch (err) {
      counts.failed++;
      console.error("[receipt] mail intake failed for one message:", err);
    }
  }

  if (counts.overCeiling > 0) {
    try {
      await ports().alerts.mailHoldCeilingReached({ orgId, unresolved: stored(), refused: counts.overCeiling });
    } catch (err) {
      console.error("[receipt] mail hold ceiling alert failed:", err);
    }
  }
  return { status: "ok", ...counts };
}
