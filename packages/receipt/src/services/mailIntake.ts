// Gmail intake: the last catch-up step of the host's daily cron. Each mailed file
// becomes a receipt by its authenticated sender, a deferred item when that sender is over their
// daily upload limit, or a held mail item for finance.
import { createHash } from "node:crypto";
import { z } from "zod";
import { isServiceError, kindOf, ServiceError } from "@checkin/component-kit";
import { isUniqueConstraintError } from "@checkin/pg-kit";
import { db } from "../db";
import { isNoticeMessageId, type MailboxReader, type MailMessage, type MailPart, type MailRefusal, type ReceiptPrincipal } from "../contract";
import type { Prisma } from "../generated/prisma/client";
import { ACCEPTED_TYPES, checkReceiptFile, MAX_FILE_BYTES } from "../lib/file-type";
import { deleteStoredFiles, newMailItemFileKey, readStoredFile } from "../lib/fileStorage";
import { fileStore, storesNewFilesInBucket, getOrgId, mailbox, ports } from "../runtime";
import { discardBodyCopy, intakeMailedReceipt } from "./receiptService";
import { OrgUploadLimitError } from "../lib/insert";
import { isAutomated, sendMailReplies } from "./mailReplies";

// ponytail: no stored cursor; the ledger makes re-reads free. Ceiling is a cron outage longer than 30 days,
// or a flood bigger than the per-run caps drain inside 30 days; widen the window or the caps then.
export const MAIL_WINDOW_DAYS = 30;
/** New receipts (OCR calls) per run, oldest mail first; the rest wait for the next run, inside the window. Held items do not count. */
export const MAIL_CAP = 10;
/** Downloads charged to held mail per run (see chargeHold); the rest wait for the next run. */
export const MAIL_HELD_CAP = 50;
/** Bytes charged to held mail per run (see chargeHold), checked before each download. */
export const MAIL_HELD_BYTES = 50 * 1024 * 1024;
/** Held and deferred items past which nothing more is stored; finance is alerted once per run while over it. */
export const MAIL_HELD_CEILING = 500;
// ponytail: a finished message is skipped unfetched, but every unfinished one, and every message that left no
// ledger row (no file, or every file refused), is fetched each run; a flood of those larger than this budget's
// worth of fetches inside 30 days can still push a later receipt past the window, with an alert; widen the budget then.
/** Wall time per run; messages not reached wait for the next run. */
export const MAIL_TIME_BUDGET_MS = 2 * 60_000;
export { MAIL_CATCH_UP_CAP } from "../lib/mailCatchUpCap";
/** Wall time of one catch-up run, which runs after its request has answered. */
export const MAIL_CATCH_UP_BUDGET_MS = 10 * 60_000;
/** How long a run's lease outlasts its budget, covering its last OCR call, alerts and replies; a crashed run blocks the next for this long at most. */
const LEASE_SLACK_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type MailIntakeResult =
  | { status: "unbound" }
  /** Another run holds the mailbox; this one read nothing. */
  | { status: "busy" }
  | MailRunCounts;

export type MailRunCounts = {
      /** `listing_failed`: the mailbox could not be listed, so no message was read this run. */
      status: "ok" | "listing_failed";
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
/** Inline images under this declared size (tracking pixels, icons, small logos) are skipped without a download. */
export const INLINE_FLOOR_BYTES = 5 * 1024;

// ponytail: a body printing its total without cents reads as trivial; widen the pattern if one is found.
/** A money amount: a number with two decimal places. A body without one is trivial. */
const MONEY_AMOUNT = /\d\.\d{2}(?!\d)/;

/** An HTML body's visible text: its style blocks and tags (with their style attributes) hold CSS numbers, never amounts. */
const visibleText = (html: string) => html.replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ").replace(/<[^>]*>/g, " ");

/**
 * A message's candidate files, read in this order: each attachment of an accepted type, each inline
 * part of an accepted non-text type at or over the floor, then the body, stored as text, unless it
 * holds no money amount. `ignored` counts the inline parts under the floor, a trivial body and
 * each message attached whole. `refused` names the attachments never read: an unaccepted type or
 * a message attached whole.
 */
export function mailFiles(msg: MailMessage, reader: MailboxReader): { files: MailFile[]; ignored: number; refused: MailRefusal[] } {
  const parts = ownParts(msg.payload);
  const typeOf = (p: MailPart) => p.mimeType.toLowerCase();
  const read = (p: MailPart) => async () =>
    p.body?.data !== undefined
      ? Buffer.from(p.body.data, "base64url")
      : p.body?.attachmentId
        ? reader.getAttachment(msg.id, p.body.attachmentId)
        : Buffer.alloc(0);
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
  if (body) {
    const text = Buffer.from(body.body?.data ?? "", "base64url").toString();
    if (MONEY_AMOUNT.test(typeOf(body) === "text/html" ? visibleText(text) : text)) files.push({ ...file(body, "text/plain"), body: true });
    else ignored++;
  }
  return { files, ignored, refused };
}

const isStatus = (err: unknown, code: number) => isServiceError(err) && err.status === code;

/** Why a file was held for finance: no sender passed the sender check, or the verified sender may not submit receipts. */
export type HoldReason = "unverified_sender" | "not_a_submitter";

/** The statuses whose items keep their file in the ledger, awaiting finance or a later run. */
export const STORED_STATUSES = ["held", "deferred"];

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

/**
 * Make a deferred item a receipt uploaded by its sender. The item flips to `assigned` in the
 * receipt's own insert, so a concurrent retry or release leaves no second receipt (409).
 */
export async function intakeDeferred(
  item: { id: number; fileBlob: Uint8Array; fileKey: string | null; mimeType: string },
  sender: ReceiptPrincipal,
  { uploadLimits, onClaim }: { uploadLimits: boolean; onClaim?: (tx: Prisma.TransactionClient, receiptId: string) => Promise<unknown> },
): Promise<string> {
  const receiptId = await intakeMailedReceipt(
    sender,
    Buffer.from(item.fileBlob),
    item.mimeType,
    async (tx, receiptId) => {
      const claimed = await tx.receiptMailItem.updateMany({
        where: { id: item.id, status: "deferred" },
        data: { status: "assigned", receiptId, fileBlob: null, fileKey: null },
      });
      if (claimed.count !== 1) throw new ServiceError(409, "This mail item was already handled. Refresh and retry.");
      await onClaim?.(tx, receiptId);
    },
    { uploadLimits, heldFileKey: item.fileKey },
  );
  // A deferred text item is a body; its message's attachments are retried first, oldest first.
  if (item.mimeType === "text/plain") {
    const { gmailMessageId } = await db.receiptMailItem.findUniqueOrThrow({ where: { id: item.id }, select: { gmailMessageId: true } });
    await discardIfCopy(gmailMessageId, receiptId);
  }
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
});
export type MailRunSummary = z.infer<typeof MailRunSummarySchema>;

function summarize(counts: MailRunCounts | null): MailRunSummary {
  if (!counts) return { status: "crashed", messages: 0, receipts: 0, held: 0, waiting: 0, failed: 0, more: false };
  const { status, messages, receipts, held, failed, deferred, unread, overLimit } = counts;
  return { status, messages, receipts, held, waiting: deferred + unread + overLimit, failed, more: deferred + unread > 0 };
}

export type MailRun = { status: "unbound" } | { status: "busy" } | { status: "started"; done: Promise<MailRunCounts> };

/**
 * Takes the org's mail lease and starts one intake pass, `busy` when another run holds the lease.
 * `beforeRun` runs while the lease is held; if it throws, the lease is freed and no pass starts.
 * `done` settles when the pass ends and the lease is released with its summary.
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
  const until = new Date(started + budgetMs + LEASE_SLACK_MS);
  if (!(await takeLease(orgId, until))) return { status: "busy" };
  try {
    await beforeRun?.();
  } catch (err) {
    await db.receiptMailLease
      .updateMany({ where: { orgId, until }, data: { until: new Date(0) } })
      .catch((releaseErr: unknown) => console.error("[receipt] mail lease release failed; it expires on its own:", releaseErr));
    throw err;
  }
  const release = (counts: MailRunCounts | null) =>
    db.receiptMailLease
      .updateMany({ where: { orgId, until }, data: { until: new Date(0), lastRunAt: new Date(), lastRun: summarize(counts) } })
      .catch((err: unknown) => console.error("[receipt] mail lease release failed; it expires on its own:", err));
  const done = readLeased(reader, orgId, started, cap, budgetMs).then(
    async (counts) => {
      await release(counts);
      return counts;
    },
    async (err: unknown) => {
      await release(null);
      throw err;
    },
  );
  return { status: "started", done };
}

/** The org's mail lease: whether a run holds it now, and the last finished run's summary. */
export async function mailRunState(): Promise<{ running: boolean; lastRunAt: Date | null; lastRun: MailRunSummary | null }> {
  const lease = await db.receiptMailLease.findUnique({ where: { orgId: await getOrgId() } });
  return {
    running: !!lease && lease.until.getTime() > Date.now(),
    lastRunAt: lease?.lastRunAt ?? null,
    lastRun: MailRunSummarySchema.safeParse(lease?.lastRun).data ?? null,
  };
}

/** The cron's intake pass, run to its end; `busy` while another run holds the lease. */
export async function readMailbox(): Promise<MailIntakeResult> {
  const run = await startMailRun();
  return run.status === "started" ? run.done : run;
}

async function readLeased(reader: MailboxReader, orgId: string, started: number, cap: number, budgetMs: number): Promise<MailRunCounts> {
  const unresolved = await db.receiptMailItem.count({ where: { orgId, status: { in: STORED_STATUSES } } });
  const counts = { messages: 0, receipts: 0, held: 0, skipped: 0, rejected: 0, failed: 0, deferred: 0, overLimit: 0, overCeiling: 0, unread: 0, ignored: 0 };
  const ignoredHashes = new Set(
    (await db.receiptIgnoredFile.findMany({ where: { orgId }, select: { fileHash: true } })).map((r) => r.fileHash),
  );
  let heldFiles = 0;
  let heldBytes = 0;
  const capped = () => counts.receipts >= cap;
  const outOfTime = () => Date.now() - started >= budgetMs;
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

  async function readMessage(msg: MailMessage, reader: MailboxReader): Promise<void> {
    const { files, ignored, refused } = mailFiles(msg, reader);
    // Nothing to read and nothing refused: the sender is told no receipt was found, unless the mail was a reply or side copy.
    if (files.length === 0 && refused.length === 0 && !isSideCopy(msg.payload.headers, reader.address)) {
      refused.push({ file: "your email", reason: "no_receipt" });
    }
    // Every file already in the ledger: nothing to download.
    const rows = await db.receiptMailItem.findMany({ where: { gmailMessageId: msg.id }, select: { refusal: true } });
    const ledgered = files.length > 0 && rows.length >= files.length;
    // A file refused on an earlier pass is never read again, so its row carries it into the notice.
    refused.push(...rows.flatMap((r) => (r.refusal ? [r.refusal as unknown as MailRefusal] : [])));
    const headers = msg.payload.headers;
    const address = fromAddress(headers);
    const verdict = dmarcVerdict(headers, address);
    const aligned = verdict === "pass";
    const sender: ReceiptPrincipal | null = address && aligned && (!ledgered || refused.length > 0) ? await ports().people.submitterByEmail(address) : null;
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
    if (ledgered) {
      counts.skipped += files.length;
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
        // An ignored file gets a discarded ledger row, so later runs skip its message without a download.
        if (!check) {
          await db.receiptMailItem.create({ data: { ...item, status: "discarded" } });
          counts.ignored++;
          continue;
        }
        if (sender) {
          try {
            const receiptId = await intakeMailedReceipt(sender, bytes, check.mimeType, async (tx, newId) => {
              await tx.receiptMailItem.create({ data: { ...item, status: "assigned", receiptId: newId } });
              await oweReply(tx);
            });
            counts.receipts++;
            if (file.body) await discardIfCopy(msg.id, receiptId);
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
        const fileKey = storesNewFilesInBucket() ? newMailItemFileKey() : null;
        if (fileKey) await fileStore().put(fileKey, bytes, key.attachmentHash);
        try {
          await db.$transaction([
            db.receiptMailItem.create({
              data: { ...item, status, holdReason: sender ? null : holdReason, fileBlob: fileKey ? null : new Uint8Array(bytes), fileKey, fileSize: bytes.length, mimeType: check.mimeType },
            }),
            oweReply(db),
          ]);
        } catch (err) {
          await deleteStoredFiles([fileKey]);
          throw err;
        }
        counts[sender ? "overLimit" : "held"]++;
      } catch (err) {
        // A concurrent run took this file first.
        if (!isUniqueConstraintError(err)) throw err;
        counts.skipped++;
      }
    }
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
          await db.receiptMailItem.updateMany({ where: { id: row.id, status: "deferred" }, data: { status: "held", holdReason: "not_a_submitter" satisfies HoldReason } });
          continue;
        }
        const item = await db.receiptMailItem.findFirst({ where: { id: row.id, status: "deferred" }, select: { id: true, fileBlob: true, fileKey: true, mimeType: true } });
        if (!item?.mimeType) continue;
        const fileBlob = await readStoredFile(item);
        if (!fileBlob) {
          counts.failed++;
          console.error("[receipt] a deferred mail item's file is missing");
          continue;
        }
        await intakeDeferred({ ...item, fileBlob, mimeType: item.mimeType }, sender, { uploadLimits: true });
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
   * Listed messages the ledger shows finished, which are not fetched again: at least one ledger row, none of
   * them deferred, and no at-risk row. A message is marked at risk before it is read and cleared only once
   * every file was read, held, ignored, discarded or refused, so one left partly read, even by a crash, stays open.
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

  async function readListed(listed: string[], reader: MailboxReader): Promise<void> {
    const finished = await finishedMessages(listed);
    for (const files of finished.values()) counts.skipped += files;
    const ids = listed.filter((id) => !finished.has(id));
    const readClean: string[] = [];
    for (const [i, id] of ids.entries()) {
      if ((capped() && holdsSpent()) || outOfTime()) {
        const unread = ids.slice(i);
        counts.unread = unread.length;
        // Oldest first, so the first unread message dates them all.
        const receivedAt = await reader.getMessage(id).then((m) => new Date(Number(m.internalDate)), () => null);
        await db.receiptMailAtRisk.createMany({ data: unread.map((gmailMessageId) => ({ orgId, gmailMessageId, receivedAt })), skipDuplicates: true });
        break;
      }
      counts.messages++;
      const deferredBefore = counts.deferred;
      const overCeilingBefore = counts.overCeiling;
      let msg: MailMessage | null = null;
      try {
        msg = await reader.getMessage(id);
        await leftUnread(id, new Date(Number(msg.internalDate)));
        await readMessage(msg, reader);
      } catch (err) {
        counts.failed++;
        console.error("[receipt] mail intake failed for one message:", err);
        await leftUnread(id, msg && new Date(Number(msg.internalDate)));
        continue;
      }
      if (counts.deferred === deferredBefore && counts.overCeiling === overCeilingBefore) readClean.push(id);
    }
    await db.receiptMailAtRisk.deleteMany({
      where: { orgId, OR: [{ gmailMessageId: { in: readClean } }, { alertedAt: { not: null }, gmailMessageId: { notIn: listed } }] },
    });
  }

  /**
   * One alert for stored messages not yet alerted, past lastChance or of unknown age; stamped only once it is sent.
   * Overlapping runs can each send it. One duplicate email is accepted: claiming rows before the send would lose the alert if the run died in between.
   */
  async function alertAtRisk(reader: MailboxReader): Promise<void> {
    const due = await db.receiptMailAtRisk.findMany({
      where: { orgId, alertedAt: null, OR: [{ receivedAt: null }, { receivedAt: { lt: new Date(lastChance) } }] },
      select: { id: true, gmailMessageId: true, receivedAt: true },
    });
    // A capped run stores only a lower bound, so each due row is re-dated from its own message, one at a time to spare Gmail; one that cannot be fetched keeps its stored date.
    const dated: typeof due = [];
    for (const row of due) {
      const message = await reader.getMessage(row.gmailMessageId).catch(() => null);
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
      await ports().alerts.mailAgingOut({
        orgId,
        messages: rows.length,
        oldestReceivedAt: dates.length > 0 ? new Date(Math.min(...dates)) : null,
      });
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
    console.error(`[receipt] mailbox listing failed (${kind}):`, err);
    // Sent every run the listing fails: mail is ageing out unread for as long as it lasts.
    try {
      await ports().alerts.mailListingFailed({ orgId, kind });
    } catch (alertErr) {
      console.error("[receipt] mailbox listing alert failed:", alertErr);
    }
  }
  if (ids) await readListed(ids, reader);
  await alertAtRisk(reader);

  let replies = { sent: 0, failed: 0 };
  try {
    replies = await sendMailReplies();
  } catch (err) {
    console.error("[receipt] mail acknowledgements failed:", err);
  }

  if (counts.overCeiling > 0) {
    try {
      await ports().alerts.mailHoldCeilingReached({ orgId, unresolved: stored(), refused: counts.overCeiling });
    } catch (err) {
      console.error("[receipt] mail hold ceiling alert failed:", err);
    }
  }
  return { status: ids ? "ok" : "listing_failed", ...counts, replied: replies.sent, replyFailed: replies.failed };
}
