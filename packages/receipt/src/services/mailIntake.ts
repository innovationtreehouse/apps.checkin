// Gmail intake: the last catch-up step of the host's daily cron. Each mailed file
// becomes a receipt by its authenticated sender, a deferred item when that sender is over their
// daily upload limit, or a held mail item for finance.
import { createHash } from "node:crypto";
import { z } from "zod";
import { isServiceError, KindedError, kindOf, ServiceError } from "@checkin/component-kit";
import { isUniqueConstraintError } from "@checkin/pg-kit";
import { db } from "../db";
import { isNoticeMessageId, type MailboxReader, type MailMessage, type MailPart, type MailRefusal, type MailRefusalReason, type ReceiptPrincipal } from "../contract";
import type { Prisma } from "../generated/prisma/client";
import { ACCEPTED_TYPES, checkReceiptFile, MAX_FILE_BYTES } from "../lib/file-type";
import { deleteStoredFiles, newMailItemFileKey, newRawMailKey, readStoredFile, sha256Hex } from "../lib/fileStorage";
import { parseRawMail } from "../lib/rawMail";
import { fileStore, getOrgId, mailbox, ports, rawMailRetentionDays } from "../runtime";
import { intakeMailedReceipt } from "./receiptService";
import { DRAIN_BUDGET_MS, drainOcrQueue, type DrainCounts } from "./ocrDrain";
import { OrgUploadLimitError } from "../lib/insert";
import type { Actor } from "../repositories/receipt";
import { byDeadline, DeadlineError } from "../lib/deadline";
import { isAutomated, sendMailReplies } from "./mailReplies";

// ponytail: no stored cursor; the ledger and the captured rows make re-listing free. Ceiling is a cron outage
// longer than 30 days, or a flood bigger than a run's capture budget drains inside 30 days; widen the window then.
export const MAIL_WINDOW_DAYS = 30;
/** New receipts per run, oldest mail first; the rest wait for the next run, inside the window. Held items do not count. */
export const MAIL_CAP = 10;
/** Files charged to held mail per run (see chargeHold); the rest wait for the next run. */
export const MAIL_HELD_CAP = 50;
/** Bytes charged to held mail per run (see chargeHold), checked before each file is taken. */
export const MAIL_HELD_BYTES = 50 * 1024 * 1024;
/** Held and deferred items past which nothing more is stored; finance is alerted once per run while over it. */
export const MAIL_HELD_CEILING = 500;
/** Wall time of the daily run's mail step, inside the scheduler's 60-second wait; messages not reached wait for the next run. */
export const MAIL_TIME_BUDGET_MS = 30_000;
export { MAIL_CATCH_UP_CAP } from "../lib/mailCatchUpCap";
/** Wall time of one catch-up run, which runs after its request has answered. */
export const MAIL_CATCH_UP_BUDGET_MS = 10 * 60_000;
/** How long a run's lease outlasts its budget and its drain, covering the drain's last reading and the release; a crashed run blocks the next for this long at most. */
const LEASE_SLACK_MS = 10 * 60_000;
/** The drain's reading calls end this long before the lease, and capture's never later, leaving the run's end its time. */
const READ_MARGIN_MS = 3 * 60_000;
/**
 * The run's end-of-run calls (dating mail, alerts, acknowledgements) end this long before the lease, leaving its release time.
 * A timed-out alert is sent again next run, so finance may see it twice; a timed-out acknowledgement is never sent again.
 */
const END_MARGIN_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type MailIntakeResult =
  | { status: "unbound" }
  /** Another run holds the mailbox; this one read nothing. */
  | { status: "busy" }
  | MailRunCounts;

export type MailRunCounts = {
      /** `listing_failed`: the mailbox could not be listed, or an outside call ran past its deadline and ended the run's reading. */
      status: "ok" | "listing_failed";
      /** Captured messages processed this run, from their stored copies. */
      messages: number;
      /** New messages whose raw copy was stored this run. */
      captured: number;
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
      /** Messages not captured or not processed, past the time budget, the raw byte cap or with every cap spent; taken up next run. */
      unread: number;
      /** Files never receipts: inline images under the floor, trivial bodies, and files on the ignore list. */
      ignored: number;
      /** Acknowledgements sent, and sends that reported failure. */
      replied: number;
      replyFailed: number;
};

type Headers = { name: string; value: string }[];

const headerValues = (headers: Headers | undefined, name: string): string[] =>
  (headers ?? []).filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value);

// ASCII only: lowercasing folds some other letters to ASCII, as the Kelvin sign to `k`, naming another person's address.
const ADDR_SPEC = /^[^\s@<>"(),;:\u0080-\uffff]+@[^\s@<>"(),;:\u0080-\uffff]+\.[^\s@<>"(),;:\u0080-\uffff]+$/;

/**
 * An RFC 5322 header with comments as whitespace and each quoted string as a lone `"`, which no
 * addr-spec may hold. Comments nest and both forms read quoted pairs. Null when either is
 * unterminated, or a `)` or `\` stands outside them.
 */
function withoutCommentsAndQuotes(value: string): string | null {
  let bare = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === ")" || c === "\\") return null;
    if (c === "(") {
      for (let depth = 1; depth > 0; ) {
        i++;
        if (i >= value.length) return null;
        if (value[i] === "\\") i++;
        else if (value[i] === "(") depth++;
        else if (value[i] === ")") depth--;
      }
      bare += " ";
    } else if (c === '"') {
      for (i++; value[i] !== '"'; i++) {
        if (value[i] === "\\") i++;
        if (i >= value.length) return null;
      }
      bare += '"';
    } else bare += c;
  }
  return bare;
}

/** The addr-spec of the message's single `From` header holding a single address, lowercased; else null. */
export function fromAddress(headers: Headers | undefined): string | null {
  const froms = headerValues(headers, "From");
  if (froms.length !== 1) return null;
  const bare = withoutCommentsAndQuotes(froms[0]);
  // A comma lists two addresses; a colon or semicolon is group syntax.
  if (bare === null || /[,;:]/.test(bare)) return null;
  // A display name holds no `@`: one there would be a second candidate address.
  const spec = (bare.match(/^[^<>@]*<([^<>]*)>\s*$/)?.[1] ?? bare).trim();
  return ADDR_SPEC.test(spec) ? spec.toLowerCase() : null;
}

/** The lowercased addresses a To or Cc header lists; a header that cannot be read lists none. */
function listedAddresses(headers: Headers | undefined, name: string): string[] {
  return headerValues(headers, name).flatMap((value) => {
    const bare = withoutCommentsAndQuotes(value);
    if (bare === null) return [];
    return bare.split(/[,;:]/).map((a) => (a.match(/<([^<>]*)>/)?.[1] ?? a).trim().toLowerCase());
  });
}

/**
 * A reply to one of the mailbox's own notices, or a copy on which the mailbox is only in Cc: mail a
 * "no receipt" notice would only interrupt. A forward can keep the In-Reply-To of the mail it
 * forwards, so only one naming our notice counts. Mail to an alias lists the mailbox nowhere.
 */
export function isSideCopy(headers: Headers | undefined, mailboxAddress: string): boolean {
  if (headerValues(headers, "In-Reply-To").some((id) => isNoticeMessageId(id, mailboxAddress))) return true;
  const mine = mailboxAddress.toLowerCase();
  return listedAddresses(headers, "Cc").includes(mine) && !listedAddresses(headers, "To").includes(mine);
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
 * True when Google's own verdict says the `From` domain passed DMARC and a DKIM signature by
 * that exact domain passed: an SPF pass alone is not enough. Only the topmost
 * `Authentication-Results` header counts, and only when Google wrote it: a sender can write
 * any header below it. Gmail echoes the envelope sender into the header, so a sender that could
 * break its syntax fails before parsing; anything ambiguous after (unparseable, two dmarc
 * results, two header.from properties) fails closed too.
 */
export function dmarcAligned(headers: Headers | undefined, address: string): boolean {
  const results = googleResults(headers);
  const domain = address.split("@")[1];
  return (
    !!results &&
    dmarcResultFor(results, domain) === "pass" &&
    results.some((r) => r.method.toLowerCase() === "dkim" && r.result.toLowerCase() === "pass" && signedBy(r, domain))
  );
}

/** The method results of the topmost `Authentication-Results`, when Google wrote it and it parses; else null. */
function googleResults(headers: Headers | undefined): ResInfo[] | null {
  const topmost = headerValues(headers, "Authentication-Results")[0];
  if (topmost === undefined || !envelopeSafe(headers, topmost)) return null;
  const parsed = parseAuthResults(topmost);
  return parsed && parsed.authservId.toLowerCase() === "mx.google.com" ? parsed.results : null;
}

/** The lowercased result of the single dmarc clause naming exactly this `From` domain; else null. */
function dmarcResultFor(results: ResInfo[], domain: string): string | null {
  const dmarc = results.filter((r) => r.method.toLowerCase() === "dmarc");
  if (dmarc.length !== 1) return null;
  const from = dmarc[0].props.filter(([key]) => key.toLowerCase() === "header.from");
  return from.length === 1 && from[0][1].toLowerCase() === domain ? dmarc[0].result.toLowerCase() : null;
}

/** The sender check's outcome, stored on each mail item. */
export type DmarcVerdict = "pass" | "fail" | "none";

/**
 * `pass` is exactly `dmarcAligned`. `none` means Google found no DMARC record for the `From`
 * domain. Everything else fails, including a DMARC pass on SPF alone and mail with no single `From`.
 */
export function dmarcVerdict(headers: Headers | undefined, address: string | null): DmarcVerdict {
  if (!address) return "fail";
  if (dmarcAligned(headers, address)) return "pass";
  const results = googleResults(headers);
  return results && dmarcResultFor(results, address.split("@")[1]) === "none" ? "none" : "fail";
}

/**
 * True when a DKIM result names its signer and every signer property names exactly this domain:
 * `header.d` as the domain, `header.i` as an address or `@domain`. Any other value fails closed.
 */
function signedBy(result: ResInfo, domain: string): boolean {
  // ponytail: exact signing domain; accept a parent domain (relaxed alignment) if a real sender needs it.
  const signer = result.props.filter(([key]) => ["header.d", "header.i"].includes(key.toLowerCase()));
  return (
    signer.length > 0 &&
    signer.every(([key, value]) => {
      const v = value.toLowerCase();
      if (key.toLowerCase() === "header.d") return v === domain;
      const at = v.lastIndexOf("@");
      return at >= 0 && v.slice(at + 1) === domain;
    })
  );
}

const isForwarded = (part: MailPart) => part.mimeType.toLowerCase() === "message/rfc822";

/** Every part outside a forwarded message: an attached message's headers and parts are never read. */
function ownParts(part: MailPart): MailPart[] {
  if (isForwarded(part)) return [];
  return [part, ...(part.parts ?? []).flatMap(ownParts)];
}

/** Messages attached whole (forwarded as attachment): never opened. */
const forwardedParts = (part: MailPart): MailPart[] => (isForwarded(part) ? [part] : (part.parts ?? []).flatMap(forwardedParts));

/** What a mail client attaches on its own (signatures, invites, contact cards, Outlook's wrapper): never a refused receipt. */
const CLIENT_ATTACHMENT_TYPES = new Set([
  "application/pkcs7-signature",
  "application/x-pkcs7-signature",
  "application/pgp-signature",
  "text/calendar",
  "application/ics",
  "text/vcard",
  "text/x-vcard",
  "application/ms-tnef",
]);

const isAttachment = (p: MailPart) =>
  !!p.filename && !/^\s*inline/i.test(headerValues(p.headers, "Content-Disposition")[0] ?? "");

type MailFile = { name: string; declaredType: string; size: number; read: () => Promise<Buffer>; body?: true };

const FILE_NAME_MAX = 200;
const fileName = (p: MailPart, fallback: string) => (p.filename || fallback).slice(0, FILE_NAME_MAX);

// ponytail: a legible receipt image under the floor is skipped silently; lower it if one is ever found.
/** Inline images under this size (tracking pixels, icons, small logos) are skipped unread. */
export const INLINE_FLOOR_BYTES = 5 * 1024;

/** A body under this many bytes, as `bodyText` measures it, is never a receipt. */
export const BODY_MIN_BYTES = 100;

/** A money amount: `$` before a digit, or a number with two decimal places. */
export const MONEY_AMOUNT = /\$\s?\d|\d\.\d{2}(?!\d)/;

/**
 * A signature separator or a mail client's trailer line holding no digit, so a line naming an amount stays. Only the
 * line goes: a forwarded receipt often sits below it.
 */
const TRAILER_LINE = /^(?:-- |sent from (?:my |yahoo mail|mail for windows)[^\d\r\n]*)\r?$/gim;

/** An HTML body's visible text: its style blocks and tags (with their style attributes) hold CSS numbers, never amounts. */
const visibleText = (html: string) => html.replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ").replace(/<[^>]*>/g, " ");

/** The body's visible text without trailer lines, its whitespace collapsed: what the size and money checks read. */
export const bodyText = (text: string, html: boolean): string =>
  (html ? visibleText(text) : text).replace(TRAILER_LINE, "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

/**
 * A message's candidate files, read in this order: each attachment of an accepted type, each inline
 * part of an accepted non-text type at or over the floor, then the body, stored as text. The body
 * counts only at BODY_MIN_BYTES or more, and is a file only when it holds a money amount. A
 * significant body without one, in a message with no other file, read or refused, is returned as `unpriced` for the
 * caller to bounce or hold. `ignored` counts the inline parts under the floor, a body that is no
 * file, and each message attached whole. `refused` names the attachments never read: an
 * unaccepted type or a message attached whole.
 */
export function mailFiles(msg: MailMessage): { files: MailFile[]; ignored: number; refused: MailRefusal[]; unpriced?: MailFile } {
  const parts = ownParts(msg.payload);
  const typeOf = (p: MailPart) => p.mimeType.toLowerCase();
  const read = (p: MailPart) => async () => Buffer.from(p.body?.data ?? "", "base64url");
  const file = (p: MailPart, declaredType = typeOf(p)): MailFile => ({ name: fileName(p, declaredType === "text/plain" ? "the text of your email" : "an image in your email"), declaredType, size: p.body?.size ?? 0, read: read(p) });

  const attachments = parts.filter((p) => isAttachment(p) && ACCEPTED_TYPES.has(typeOf(p)));
  const inline = parts.filter((p) => !isAttachment(p) && typeOf(p) !== "text/plain" && ACCEPTED_TYPES.has(typeOf(p)));
  const sized = inline.filter((p) => (p.body?.size ?? 0) >= INLINE_FLOOR_BYTES);
  const forwarded = forwardedParts(msg.payload);
  let ignored = inline.length - sized.length + forwarded.length;
  const refused: MailRefusal[] = [
    ...parts.filter((p) => isAttachment(p) && !ACCEPTED_TYPES.has(typeOf(p)) && !CLIENT_ATTACHMENT_TYPES.has(typeOf(p))).map((p) => ({ file: fileName(p, "an attachment"), reason: "wrong_type" as const })),
    ...forwarded.map((p) => ({ file: fileName(p, "an attached email"), reason: "forwarded" as const })),
  ];

  const bodyPart = (type: string) => parts.find((p) => !isAttachment(p) && typeOf(p) === type && p.body?.data);
  // HTML is stored as its source text: a receipt file is never served as a page.
  const body = bodyPart("text/plain") ?? bodyPart("text/html");
  const files = [...attachments, ...sized].map((p) => file(p));
  if (!body) return { files, ignored, refused };
  const text = bodyText(Buffer.from(body.body?.data ?? "", "base64url").toString(), typeOf(body) === "text/html");
  const bodyFile: MailFile = { ...file(body, "text/plain"), body: true };
  const significant = Buffer.byteLength(text) >= BODY_MIN_BYTES;
  if (significant && MONEY_AMOUNT.test(text)) files.push(bodyFile);
  else if (significant && files.length === 0 && refused.length === 0) return { files, ignored, refused, unpriced: bodyFile };
  else ignored++;
  return { files, ignored, refused };
}

const isStatus = (err: unknown, code: number) => isServiceError(err) && err.status === code;

/**
 * Why a file was held for finance: no sender passed the sender check, the verified sender may not submit receipts, or a
 * submitter's reply to a notice or Cc-only copy held text with no amount, which gets no reply.
 */
export type HoldReason = "unverified_sender" | "not_a_submitter" | "side_copy";

/** Refused files finance is told about, in a held note with no file, when no submitter sent the mail. */
const HELD_REFUSALS = new Set<MailRefusalReason>(["wrong_type", "forwarded", "too_large", "empty"]);

/** The ledger key of a message's one refusal note, which names what finance should hear of and keeps no file. */
export const REFUSAL_NOTE_KEY = createHash("sha256").update("receipt mail refusal note").digest("hex");

/** A message's refusal note, held or since discarded: never the ledger row of a file. */
export const isRefusalNote = (row: { attachmentHash: string }) => row.attachmentHash === REFUSAL_NOTE_KEY;

const sameRefusal = (a: MailRefusal) => (b: MailRefusal) => a.file === b.file && a.reason === b.reason;

/** The statuses whose items keep their file in the ledger, awaiting finance or a later run. */
export const STORED_STATUSES = ["held", "deferred"];

/**
 * Make a deferred item a receipt uploaded by its sender. The item flips to `assigned` in the
 * receipt's own insert, so a concurrent retry or release leaves no second receipt (409).
 */
export async function intakeDeferred(
  item: { id: number; fileBlob: Uint8Array; fileKey: string | null; mimeType: string },
  sender: ReceiptPrincipal,
  { uploadLimits, onClaim, deadline }: { uploadLimits: boolean; onClaim?: (tx: Prisma.TransactionClient, receiptId: string) => Promise<unknown>; deadline?: number },
): Promise<string> {
  const receiptId = await intakeMailedReceipt(
    sender,
    Buffer.from(item.fileBlob),
    item.mimeType,
    async (tx, receiptId) => {
      const claimed = await tx.receiptMailItem.updateMany({
        where: { id: item.id, status: "deferred" },
        data: { status: "assigned", receiptId, fileKey: null },
      });
      if (claimed.count !== 1) throw new ServiceError(409, "This mail item was already handled. Refresh and retry.");
      await onClaim?.(tx, receiptId);
    },
    { uploadLimits, heldFileKey: item.fileKey, deadline },
  );
  return receiptId;
}

/** Takes the org's mail lease until `until`, unless a live run holds it. */
async function takeLease(orgId: string, until: Date): Promise<boolean> {
  await db.receiptMailLease.createMany({ data: [{ orgId, until: new Date(0) }], skipDuplicates: true });
  const { count } = await db.receiptMailLease.updateMany({ where: { orgId, until: { lt: new Date() } }, data: { until } });
  return count === 1;
}

/** What a finished run leaves on the lease for finance: its counts, or `crashed` when it threw. */
const MailRunSummarySchema = z.object({
  status: z.enum(["ok", "listing_failed", "crashed"]),
  messages: z.number(),
  receipts: z.number(),
  held: z.number(),
  /** Files put off by a cap or the sender's daily limit, and messages not reached: read on a later run. */
  waiting: z.number(),
  failed: z.number(),
  /** Put-off files or unread messages remain, which another run would read now. */
  more: z.boolean(),
  /** The drain after the run; absent on a run that crashed before it, or that predates it. */
  drain: z.object({ read: z.number(), failed: z.number(), waiting: z.number() }).optional(),
});
export type MailRunSummary = z.infer<typeof MailRunSummarySchema>;

function summarize(counts: MailRunCounts | null, drain?: DrainCounts): MailRunSummary {
  if (!counts) return { status: "crashed", messages: 0, receipts: 0, held: 0, waiting: 0, failed: 0, more: false };
  const { status, messages, receipts, held, failed, deferred, unread, overLimit } = counts;
  return { status, messages, receipts, held, waiting: deferred + unread + overLimit, failed, more: deferred + unread > 0, drain };
}

/** The deadlines (epoch ms) a run's outside calls must answer by, from its lease's expiry: always before it. */
export const callDeadlines = (leaseUntil: number) => ({ read: leaseUntil - READ_MARGIN_MS, end: leaseUntil - END_MARGIN_MS });

/** The reader with each call rejecting with DeadlineError once `deadline` passes. */
const readerBy = (reader: MailboxReader, deadline: number): MailboxReader => ({
  address: reader.address,
  listRecent: (days) => byDeadline(deadline, "the mailbox listing", () => reader.listRecent(days)),
  getRaw: (id) => byDeadline(deadline, "a mailbox fetch", () => reader.getRaw(id)),
});

export type MailRun =
  | { status: "unbound" }
  | { status: "busy" }
  | { status: "started"; intake: Promise<MailRunCounts>; done: Promise<MailRunCounts> };

/**
 * Takes the org's mail lease and starts one intake pass, `busy` when another run holds the lease.
 * `beforeRun` runs while the lease is held; if it throws, the lease is freed and no pass starts.
 * `intake` settles when the mail is taken in. The drain then reads waiting receipts under the same
 * lease, and `done` settles once the lease is released with the run's summary.
 */
export async function startMailRun({
  cap = MAIL_CAP,
  budgetMs = MAIL_TIME_BUDGET_MS,
  beforeRun,
}: { cap?: number; budgetMs?: number; beforeRun?: () => Promise<unknown> } = {}): Promise<MailRun> {
  const reader = mailbox();
  if (!reader) return { status: "unbound" };
  const orgId = await getOrgId();
  const started = Date.now();
  const until = new Date(mailLeaseUntil(started, budgetMs));
  if (!(await takeLease(orgId, until))) return { status: "busy" };
  try {
    await beforeRun?.();
  } catch (err) {
    await db.receiptMailLease
      .updateMany({ where: { orgId, until }, data: { until: new Date(0) } })
      .catch((releaseErr: unknown) => console.error("[receipt] mail lease release failed; it expires on its own:", releaseErr));
    throw err;
  }
  const release = (counts: MailRunCounts | null, drain?: DrainCounts) =>
    db.receiptMailLease
      .updateMany({ where: { orgId, until }, data: { until: new Date(0), lastRunAt: new Date(), lastRun: summarize(counts, drain) } })
      .catch((err: unknown) => console.error("[receipt] mail lease release failed; it expires on its own:", err));
  const intake = readLeased(reader, orgId, started, cap, budgetMs, until.getTime());
  const done = intake.then(
    async (counts) => {
      const drain = await drainOcrQueue(drainDeadline(until.getTime())).catch((err: unknown) => {
        console.error("[receipt] OCR drain crashed:", err);
        return undefined;
      });
      await release(drain ? counts : null, drain);
      return counts;
    },
    async (err: unknown) => {
      // A failed intake still leaves the receipts queued before it to be read.
      await drainOcrQueue(drainDeadline(until.getTime())).catch((drainErr: unknown) => console.error("[receipt] OCR drain crashed:", drainErr));
      await release(null);
      throw err;
    },
  );
  return { status: "started", intake, done };
}

/** The drain under the mail lease with no mailbox bound, so a receipt left queued is still read; null while a run holds the lease. */
export async function drainAlone(): Promise<DrainCounts | null> {
  const orgId = await getOrgId();
  const until = new Date(mailLeaseUntil(Date.now(), 0));
  if (!(await takeLease(orgId, until))) return null;
  try {
    return await drainOcrQueue(drainDeadline(until.getTime()));
  } finally {
    await db.receiptMailLease
      .updateMany({ where: { orgId, until }, data: { until: new Date(0) } })
      .catch((err: unknown) => console.error("[receipt] mail lease release failed; it expires on its own:", err));
  }
}

/** When a run started at `started` with `budgetMs` releases its lease at the latest: its intake, its drain and the slack. */
export const mailLeaseUntil = (started: number, budgetMs: number) => started + budgetMs + DRAIN_BUDGET_MS + LEASE_SLACK_MS;

/** The drain's deadline (epoch ms): its budget from now, and never past the lease's reading deadline. */
export const drainDeadline = (leaseUntil: number, now = Date.now()) => Math.min(now + DRAIN_BUDGET_MS, callDeadlines(leaseUntil).read);

/** The org's mail lease: whether a run holds it now, and the last finished run's summary. */
export async function mailRunState(): Promise<{ running: boolean; lastRunAt: Date | null; lastRun: MailRunSummary | null }> {
  const lease = await db.receiptMailLease.findUnique({ where: { orgId: await getOrgId() } });
  return {
    running: !!lease && lease.until.getTime() > Date.now(),
    lastRunAt: lease?.lastRunAt ?? null,
    lastRun: MailRunSummarySchema.safeParse(lease?.lastRun).data ?? null,
  };
}

/** One intake pass and its drain, run to their end; `busy` while another run holds the lease. */
export async function readMailbox(): Promise<MailIntakeResult> {
  const run = await startMailRun();
  return run.status === "started" ? run.done : run;
}

/**
 * The daily cron's intake pass: answers once the mail is taken in, and leaves the drain reading
 * waiting receipts after the request has answered, with or without a mailbox bound. `busy` while
 * another run holds the lease.
 */
export async function takeInMailbox(): Promise<MailIntakeResult> {
  const run = await startMailRun();
  if (run.status === "unbound") drainAlone().catch((err: unknown) => console.error("[receipt] OCR drain crashed:", err));
  if (run.status !== "started") return run;
  run.done.catch((err: unknown) => console.error("[receipt] mail run failed:", err));
  return run.intake;
}

type Pass = Awaited<ReturnType<typeof createPass>>;

/**
 * One pass's processing state: its counts, caps and held budget, and the per-message logic that
 * turns a message's files into receipts, held and deferred items, refusals and owed replies.
 * `budgetEnds` (epoch ms) is when the pass stops starting new work.
 */
async function createPass(orgId: string, cap: number, deadlines: { read: number; end: number }, mailboxAddress: string, budgetEnds: number) {
  const unresolved = await db.receiptMailItem.count({ where: { orgId, status: { in: STORED_STATUSES } } });
  const counts = { messages: 0, captured: 0, receipts: 0, held: 0, skipped: 0, rejected: 0, failed: 0, deferred: 0, overLimit: 0, overCeiling: 0, unread: 0, ignored: 0 };
  const ignoredHashes = new Set(
    (await db.receiptIgnoredFile.findMany({ where: { orgId }, select: { fileHash: true } })).map((r) => r.fileHash),
  );
  let heldFiles = 0;
  let heldBytes = 0;
  const capped = () => counts.receipts >= cap;
  const outOfTime = () => Date.now() >= budgetEnds;
  const stored = () => unresolved + counts.held + counts.overLimit;
  const holdsSpent = () => heldFiles >= MAIL_HELD_CAP || stored() >= MAIL_HELD_CEILING;

  /**
   * The one charging rule for the held budget: each file taken from an unknown sender, and each
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

  async function readMessage(msg: MailMessage): Promise<void> {
    const { files, ignored, refused, unpriced } = mailFiles(msg);
    const headers = msg.payload.headers;
    const address = fromAddress(headers);
    const verdict = dmarcVerdict(headers, address);
    const aligned = verdict === "pass";
    const submitter = () => (address && aligned ? ports().people.submitterByEmail(address) : Promise.resolve(null));
    // A significant body with no amount: a submitter is told, or, on a side copy, finance holds a note of it with no
    // reply; a submitter's automated mail keeps it as their receipt unless it is a side copy; anyone else's is held.
    const known = unpriced ? await submitter() : undefined;
    const sideCopy = isSideCopy(headers, mailboxAddress);
    let sideCopyNote = false;
    if (unpriced) {
      const automated = isAutomated(msg.payload, address);
      if (known && sideCopy) sideCopyNote = !automated;
      else if (known && !automated) refused.push({ file: "your email", reason: "no_amount" });
      else files.push(unpriced);
    }
    // Nothing to read and nothing refused: the sender is told no receipt was found, unless the mail was a reply or side copy.
    if (files.length === 0 && refused.length === 0 && !sideCopy) {
      refused.push({ file: "your email", reason: "no_receipt" });
    }
    // Every file already in the ledger: nothing to take.
    const rows = await db.receiptMailItem.findMany({ where: { gmailMessageId: msg.id }, select: { id: true, attachmentHash: true, status: true, refusal: true } });
    const note = rows.find(isRefusalNote);
    const ledgered = files.length > 0 && rows.length - (note ? 1 : 0) >= files.length;
    // A file refused on an earlier pass is never read again, so its row carries it into the notice.
    refused.push(...rows.flatMap((r) => (r.refusal && !isRefusalNote(r) ? [r.refusal as unknown as MailRefusal] : [])));
    const sender: ReceiptPrincipal | null = known !== undefined ? known : !ledgered || refused.length > 0 ? await submitter() : null;
    const holdReason: HoldReason = aligned ? "not_a_submitter" : "unverified_sender";
    // Owed in the same transaction as each stored file, so a reply is owed exactly when the message has one.
    const reply = { orgId, gmailMessageId: msg.id, senderAddress: address ?? "", receivedAt: new Date(Number(msg.internalDate)), replyToSender: aligned && !isAutomated(msg.payload, address) };
    const oweReply = (tx: Prisma.TransactionClient | typeof db) => tx.receiptMailReply.createMany({ data: [reply], skipDuplicates: true });
    /**
     * Written once. Reopens a row already finished, since its acknowledgement may have gone out on an
     * earlier pass, but never one left claimed by a crash: that could resend its acknowledgement.
     */
    const oweRefusals = async () => {
      if (!sender || !reply.replyToSender || refused.length === 0) return;
      const refusals = refused as unknown as Prisma.InputJsonValue;
      await oweReply(db);
      await db.receiptMailReply.updateMany({
        where: { gmailMessageId: msg.id, refusals: { equals: [] }, refusalSentAt: null, OR: [{ claimedAt: null }, { doneAt: { not: null } }] },
        data: { refusals, doneAt: null, claimedAt: null, attempts: 0 },
      });
    };
    /**
     * Without a submitter to tell, the message's refused files go to finance as one held note that keeps no file, and so
     * does a submitter's side copy with no amount. The note is charged one held file against the run's budget and the
     * ceiling; with no room, the message stays open for a later run. A discarded note is never reopened.
     */
    const holdRefusals = async () => {
      const toNote: MailRefusal[] = sender
        ? sideCopyNote ? [{ file: "your email", reason: "no_amount" }] : []
        : refused.filter((r) => HELD_REFUSALS.has(r.reason));
      const noted = (note?.refusal ?? []) as unknown as MailRefusal[];
      const fresh = toNote.filter((r, i) => !noted.some(sameRefusal(r)) && toNote.findIndex(sameRefusal(r)) === i);
      if (fresh.length === 0 || (note && note.status !== "held")) return;
      const refusal = [...noted, ...fresh] as unknown as Prisma.InputJsonValue;
      if (note) {
        await db.receiptMailItem.update({ where: { id: note.id }, data: { refusal } });
        return;
      }
      if (!roomToHold(0)) return;
      heldFiles++;
      const { count } = await db.receiptMailItem.createMany({
        data: [{
          orgId,
          gmailMessageId: msg.id,
          attachmentHash: REFUSAL_NOTE_KEY,
          receivedAt: new Date(Number(msg.internalDate)),
          senderAddress: address ?? "",
          dmarcVerdict: verdict,
          status: "held",
          heldAt: new Date(),
          holdReason: sender ? ("side_copy" satisfies HoldReason) : holdReason,
          refusal,
        }],
        skipDuplicates: true,
      });
      counts.held += count;
    };
    if (ledgered) {
      counts.skipped += files.length;
      await holdRefusals();
      await oweRefusals();
      return;
    }
    counts.ignored += ignored;
    let putOff = false;

    for (const file of files) {
      if (sender && capped()) {
        counts.deferred++;
        putOff = true;
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        counts.rejected++;
        refused.push({ file: file.name, reason: "too_large" });
        continue;
      }
      if (!sender && !roomToHold(file.size)) continue;
      const bytes = await file.read();
      if (!sender) chargeHold(file, bytes);
      const key = { gmailMessageId: msg.id, attachmentHash: createHash("sha256").update(bytes).digest("hex") };
      if (await db.receiptMailItem.findUnique({ where: { gmailMessageId_attachmentHash: key }, select: { id: true } })) {
        counts.skipped++;
        continue;
      }
      const item = { orgId, ...key, receivedAt: new Date(Number(msg.internalDate)), senderAddress: address ?? "", dmarcVerdict: verdict };
      const check = ignoredHashes.has(key.attachmentHash) ? null : checkReceiptFile(bytes, file.declaredType);
      if (check && !check.ok) {
        counts.rejected++;
        refused.push({ file: file.name, reason: bytes.length === 0 ? "empty" : bytes.length > MAX_FILE_BYTES ? "too_large" : "wrong_type" });
        continue;
      }
      try {
        // An ignored file gets a discarded ledger row, so a replay skips it.
        if (!check) {
          await db.receiptMailItem.create({ data: { ...item, status: "discarded" } });
          counts.ignored++;
          continue;
        }
        if (sender) {
          try {
            await intakeMailedReceipt(
              sender,
              bytes,
              check.mimeType,
              async (tx, newId) => {
                await tx.receiptMailItem.create({ data: { ...item, status: "assigned", receiptId: newId } });
                await oweReply(tx);
              },
              { deadline: deadlines.read },
            );
            counts.receipts++;
            continue;
          } catch (err) {
            // Over the sender's daily upload limit: stored to retry on a later run.
            if (!isStatus(err, 429)) throw err;
          }
          if (!roomToHold(bytes.length)) {
            // Final at the ceiling, so a later run cannot take a file the sender was told to send again.
            if (stored() >= MAIL_HELD_CEILING) {
              const refusal: MailRefusal = { file: file.name, reason: "ceiling" };
              await db.receiptMailItem.create({ data: { ...item, status: "refused", refusal: { ...refusal } } });
              refused.push(refusal);
            } else {
              putOff = true;
            }
            continue;
          }
          chargeHold(file, bytes);
        }
        const status = sender ? "deferred" : "held";
        const fileKey = newMailItemFileKey();
        await byDeadline(deadlines.read, "the file store", () => fileStore().put(fileKey, bytes, key.attachmentHash));
        try {
          await db.$transaction([
            db.receiptMailItem.create({
              data: { ...item, status, heldAt: sender ? null : new Date(), holdReason: sender ? null : holdReason, fileKey, fileSize: bytes.length, mimeType: check.mimeType },
            }),
            oweReply(db),
          ]);
        } catch (err) {
          await deleteStoredFiles([fileKey], deadlines.read);
          throw err;
        }
        counts[sender ? "overLimit" : "held"]++;
      } catch (err) {
        // A concurrent run took this file first.
        if (!isUniqueConstraintError(err)) throw err;
        counts.skipped++;
      }
    }
    await holdRefusals();
    // A put-off file may be refused yet, so the one notice waits for the pass that finishes the message.
    if (!putOff) await oweRefusals();
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
          await db.receiptMailItem.updateMany({ where: { id: row.id, status: "deferred" }, data: { status: "held", heldAt: new Date(), holdReason: "not_a_submitter" satisfies HoldReason } });
          continue;
        }
        const item = await db.receiptMailItem.findFirst({ where: { id: row.id, status: "deferred" }, select: { id: true, fileKey: true, mimeType: true } });
        if (!item?.mimeType) continue;
        const fileBlob = await readStoredFile(item.fileKey, deadlines.read);
        if (!fileBlob) {
          counts.failed++;
          console.error("[receipt] a deferred mail item's file is missing");
          continue;
        }
        await intakeDeferred({ ...item, fileBlob, mimeType: item.mimeType }, sender, { uploadLimits: true, deadline: deadlines.read });
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

  return { orgId, counts, deadlines, capped, outOfTime, stored, holdsSpent, readMessage, retryDeferred };
}

/** What processing a captured message came to: done, put off in part for a later pass, or past its stored copy's retention. */
export type CapturedOutcome = { status: "processed" | "waiting" } | { status: "expired"; message: string };

/** The kind and a short reason of a processing failure; never message content. */
function processErrorOf(err: unknown): string {
  const reason = isServiceError(err) || err instanceof KindedError ? `: ${err.message.slice(0, 200)}` : "";
  return `${kindOf(err)}${reason}`;
}

type CapturedRow = { id: number; gmailMessageId: string; receivedAt: Date; capturedAt: Date; rawKey: string; processedAt: Date | null };

/**
 * Processes one captured message from its stored copy: the only processing code, for the run and for
 * replay alike. Past the environment's retention it answers `expired` without asking the store; inside
 * it, a missing copy is an error. A message the ledger already covers creates nothing twice.
 */
async function processCaptured(row: CapturedRow, pass: Pass): Promise<CapturedOutcome> {
  const days = rawMailRetentionDays();
  if (Date.now() - row.capturedAt.getTime() >= days * DAY_MS) {
    return { status: "expired", message: `This email's stored copy expired ${days} days after capture.` };
  }
  const deferredBefore = pass.counts.deferred;
  const overCeilingBefore = pass.counts.overCeiling;
  try {
    const raw = await readStoredFile(row.rawKey, pass.deadlines.read);
    if (!raw) throw new KindedError("system", "This email's stored copy is missing");
    await pass.readMessage(await parseRawMail(row.gmailMessageId, String(row.receivedAt.getTime()), Buffer.from(raw)));
  } catch (err) {
    await db.receiptMailMessage
      .update({ where: { id: row.id }, data: { processError: processErrorOf(err) } })
      .catch((saveErr: unknown) => console.error("[receipt] recording a mail processing error failed:", saveErr));
    throw err;
  }
  // A file put off by a cap or the held ceiling leaves the message for a later pass.
  const waiting = pass.counts.deferred !== deferredBefore || pass.counts.overCeiling !== overCeilingBefore;
  await db.receiptMailMessage.update({
    where: { id: row.id },
    data: { processedAt: waiting ? row.processedAt : (row.processedAt ?? new Date()), processError: null },
  });
  return { status: waiting ? "waiting" : "processed" };
}

/** Replay's budget for its outside calls. */
export const REPLAY_BUDGET_MS = 30_000;

/**
 * Processes one captured message again from its stored copy, creating only what is missing. Answers
 * `expired`, with no store call, once the copy is past the environment's retention. A replay is
 * audited with who asked before it runs; a null `askedBy` is a system step.
 */
export async function processCapturedMessage(id: number, askedBy: Actor | null = null): Promise<CapturedOutcome> {
  const orgId = await getOrgId();
  const row = await db.receiptMailMessage.findFirst({ where: { id, orgId } });
  if (!row) throw new ServiceError(404, "No such captured email.");
  const reader = mailbox();
  if (!reader) throw new ServiceError(409, "The receipt mailbox is not set up.");
  await db.receiptAuditLog.create({
    data: { receiptId: null, userId: askedBy?.id ?? null, username: askedBy?.name ?? null, action: "mail_replayed", fieldChanged: "mail_message", valueBefore: String(id) },
  });
  const deadline = Date.now() + REPLAY_BUDGET_MS;
  return processCaptured(row, await createPass(orgId, MAIL_CAP, { read: deadline, end: deadline }, reader.address, deadline));
}

/** Raw mail captured per run at most; a message that would start past it waits for the next run. */
export const MAIL_RAW_BYTES = 100 * 1024 * 1024;
/** How long after the capture budget the run's end-of-run calls (dating mail, alerts, acknowledgements) may run. */
const CAPTURE_END_MS = 15_000;

/**
 * The deadlines (epoch ms) of a run's capture and processing calls: they end with its budget, and its
 * end-of-run calls shortly after, never past the lease's own call deadlines.
 */
export const captureDeadlines = (started: number, budgetMs: number, leaseUntil: number) => {
  const lease = callDeadlines(leaseUntil);
  return { read: Math.min(started + budgetMs, lease.read), end: Math.min(started + budgetMs + CAPTURE_END_MS, lease.end) };
};

async function readLeased(
  mailboxReader: MailboxReader,
  orgId: string,
  started: number,
  cap: number,
  budgetMs: number,
  leaseUntil: number,
): Promise<MailRunCounts> {
  const deadlines = captureDeadlines(started, budgetMs, leaseUntil);
  const reader = readerBy(mailboxReader, deadlines.read);
  const endReader = readerBy(mailboxReader, deadlines.end);
  const pass = await createPass(orgId, cap, deadlines, mailboxReader.address, started + budgetMs);
  const { counts, capped, outOfTime, holdsSpent, stored } = pass;

  await pass.retryDeferred();

  // Mail received before this is out of the window by the next daily run.
  const lastChance = started - (MAIL_WINDOW_DAYS - 1) * DAY_MS;
  /** Stored as soon as it happens, so a run that dies later still leaves the message to alert on. */
  const leftUnread = (gmailMessageId: string, receivedAt: Date | null) =>
    db.receiptMailAtRisk.upsert({
      where: { gmailMessageId },
      create: { orgId, gmailMessageId, receivedAt },
      update: receivedAt ? { receivedAt } : {},
    });

  /**
   * Listed messages the ledger shows finished from before capture, which are not fetched: at least one
   * ledger row, none of them deferred, and no at-risk row.
   */
  async function finishedMessages(ids: string[]): Promise<Map<string, number>> {
    const [items, open] = await Promise.all([
      db.receiptMailItem.findMany({ where: { orgId, gmailMessageId: { in: ids } }, select: { gmailMessageId: true, status: true } }),
      db.receiptMailAtRisk.findMany({ where: { gmailMessageId: { in: ids } }, select: { gmailMessageId: true } }),
    ]);
    const unfinished = new Set([...open.map((r) => r.gmailMessageId), ...items.flatMap((r) => (r.status === "deferred" ? [r.gmailMessageId] : []))]);
    const files = new Map<string, number>();
    for (const { gmailMessageId } of items) if (!unfinished.has(gmailMessageId)) files.set(gmailMessageId, (files.get(gmailMessageId) ?? 0) + 1);
    return files;
  }

  /**
   * Captures each listed message not captured and not finished, oldest first: its raw copy to the store,
   * then its row. A message not captured stays at risk for the ageing alert. False when an outside call
   * ran past its deadline, which ends the run's reading.
   */
  async function captureListed(listed: string[]): Promise<boolean> {
    const finished = await finishedMessages(listed);
    const capturedRows = await db.receiptMailMessage.findMany({ where: { orgId, gmailMessageId: { in: listed } }, select: { gmailMessageId: true, processedAt: true } });
    const captured = new Set(capturedRows.map((r) => r.gmailMessageId));
    // A captured message still to process counts its skipped files when it is processed.
    const pending = new Set(capturedRows.flatMap((r) => (r.processedAt ? [] : [r.gmailMessageId])));
    for (const [id, files] of finished) if (!pending.has(id)) counts.skipped += files;
    const ids = listed.filter((id) => !finished.has(id) && !captured.has(id));
    const capturedNow: string[] = [];
    let rawBytes = 0;
    /** Stores the messages from `from` on as unread and at risk, for the next run and the ageing alert. */
    const leaveRestUnread = async (from: number) => {
      const unread = ids.slice(from);
      counts.unread += unread.length;
      if (unread.length === 0) return;
      // Oldest first, so the first unread message dates them all.
      const receivedAt = await endReader.getRaw(unread[0]).then((m) => new Date(Number(m.internalDate)), () => null);
      await db.receiptMailAtRisk.createMany({ data: unread.map((gmailMessageId) => ({ orgId, gmailMessageId, receivedAt })), skipDuplicates: true });
    };
    let timedOut = false;
    for (const [i, id] of ids.entries()) {
      if (rawBytes >= MAIL_RAW_BYTES || outOfTime()) {
        await leaveRestUnread(i);
        break;
      }
      let receivedAt: Date | null = null;
      try {
        const { raw, internalDate } = await reader.getRaw(id);
        receivedAt = new Date(Number(internalDate));
        rawBytes += raw.length;
        const rawKey = newRawMailKey();
        const rawSha256 = sha256Hex(raw);
        await byDeadline(deadlines.read, "the file store", () => fileStore().put(rawKey, raw, rawSha256));
        try {
          await db.receiptMailMessage.create({ data: { orgId, gmailMessageId: id, receivedAt, rawKey, rawSha256, rawSize: raw.length } });
        } catch (err) {
          // A concurrent run captured it first; this copy expires with the rest.
          if (!isUniqueConstraintError(err)) throw err;
        }
        counts.captured++;
        capturedNow.push(id);
      } catch (err) {
        counts.failed++;
        console.error(`[receipt] mail capture failed for one message (${kindOf(err)}):`, err);
        await leftUnread(id, receivedAt);
        if (err instanceof DeadlineError) {
          // An outside call is not answering, so the reading ends here.
          timedOut = true;
          await leaveRestUnread(i + 1);
          break;
        }
      }
    }
    await db.receiptMailAtRisk.deleteMany({
      where: { orgId, OR: [{ gmailMessageId: { in: capturedNow } }, { alertedAt: { not: null }, gmailMessageId: { notIn: listed } }] },
    });
    return !timedOut;
  }

  /** Processes captured messages not yet done, oldest first, inside retention; false when an outside call ran past its deadline. */
  async function processPending(): Promise<boolean> {
    const pending = await db.receiptMailMessage.findMany({
      where: { orgId, processedAt: null, capturedAt: { gt: new Date(Date.now() - rawMailRetentionDays() * DAY_MS) } },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    });
    for (const [i, row] of pending.entries()) {
      if ((capped() && holdsSpent()) || outOfTime()) {
        counts.unread += pending.length - i;
        return true;
      }
      counts.messages++;
      try {
        await processCaptured(row, pass);
      } catch (err) {
        counts.failed++;
        console.error(`[receipt] mail processing failed for one message (${kindOf(err)}):`, err);
        if (err instanceof DeadlineError) {
          counts.unread += pending.length - i - 1;
          return false;
        }
      }
    }
    return true;
  }

  /**
   * One alert for stored messages not yet alerted, past lastChance or of unknown age; stamped only once it is sent.
   * Overlapping runs can each send it. One duplicate email is accepted: claiming rows before the send would lose the alert if the run died in between.
   */
  async function alertAtRisk(): Promise<void> {
    const due = await db.receiptMailAtRisk.findMany({
      where: { orgId, alertedAt: null, OR: [{ receivedAt: null }, { receivedAt: { lt: new Date(lastChance) } }] },
      select: { id: true, gmailMessageId: true, receivedAt: true },
    });
    // A capped run stores only a lower bound, so each due row is re-dated from its own message, one at a time to spare Gmail; one that cannot be fetched keeps its stored date.
    const dated: typeof due = [];
    for (const row of due) {
      const message = await endReader.getRaw(row.gmailMessageId).catch(() => null);
      if (!message) {
        dated.push(row);
        continue;
      }
      const receivedAt = new Date(Number(message.internalDate));
      dated.push({ ...row, receivedAt });
      await db.receiptMailAtRisk
        .update({ where: { id: row.id }, data: { receivedAt } })
        .catch((err) => console.error(`[receipt] mail ageing re-date failed for row ${row.id}:`, err));
    }
    const rows = dated.filter((r) => !r.receivedAt || r.receivedAt.getTime() < lastChance);
    if (rows.length === 0) return;
    const dates = rows.flatMap((r) => (r.receivedAt ? [r.receivedAt.getTime()] : []));
    try {
      await byDeadline(deadlines.end, "the mail ageing alert", () => ports().alerts.mailAgingOut({
        orgId,
        messages: rows.length,
        oldestReceivedAt: dates.length > 0 ? new Date(Math.min(...dates)) : null,
      }));
      await db.receiptMailAtRisk.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { alertedAt: new Date() } });
    } catch (err) {
      console.error("[receipt] mail ageing alert failed:", err);
    }
  }

  let ids: string[] | null = null;
  try {
    ids = await reader.listRecent(MAIL_WINDOW_DAYS);
  } catch (err) {
    const kind = kindOf(err);
    // The cron run counts `listing_failed` as a failure, so the Problems list shows it.
    console.error(`[receipt] mailbox listing failed (${kind}):`, err);
  }
  const listedAll = ids ? await captureListed(ids) : false;
  const processedAll = await processPending();
  await alertAtRisk();

  let replies = { sent: 0, failed: 0 };
  try {
    replies = await sendMailReplies(deadlines.end);
  } catch (err) {
    console.error("[receipt] mail acknowledgements failed:", err);
  }

  if (counts.overCeiling > 0) {
    try {
      await byDeadline(deadlines.end, "the mail hold ceiling alert", () =>
        ports().alerts.mailHoldCeilingReached({ orgId, unresolved: stored(), refused: counts.overCeiling }),
      );
    } catch (err) {
      console.error("[receipt] mail hold ceiling alert failed:", err);
    }
  }
  return { status: listedAll && processedAll ? "ok" : "listing_failed", ...counts, replied: replies.sent, replyFailed: replies.failed };
}
