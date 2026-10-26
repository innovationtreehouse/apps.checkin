import { db, type Db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import { BODY_COPY_DISCARDED } from "./receipt-flow";
import { STATE_LABELS } from "./stateLabels";

/** `copyOfId` names the receipt kept in place of a member rejected as a copy. */
export type DuplicateMember = { id: string; state: string; label: string; copyOfId: string | null };
/** The viewed receipt and every member not dismissed against it, in upload order, and the ones dismissed. */
export type DuplicateGroup = { members: DuplicateMember[]; dismissed: string[] };

type Node = { id: string; state: string; uploadedAt: Date; pushedAt: Date | null };
type Client = Db | Prisma.TransactionClient;

const isLive = (n: Pick<Node, "state">) => n.state !== "discarded";
const byUpload = (a: Node, b: Node) => a.uploadedAt.getTime() - b.uploadedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Every receipt matching one of `ids` on any tier, in either direction, minus pairs a person
 * decided are different purchases. A mailed body discarded as a copy of its own message's
 * attachment matches nothing. Retailers compare case- and whitespace-folded on both sides; an
 * empty retailer, order number or receipt number matches nothing.
 */
async function matchesOf(client: Client, orgId: string, ids: string[]): Promise<Node[]> {
  return client.$queryRaw<Node[]>`
    SELECT DISTINCT o.id, o.state, ro.uploaded_at AS "uploadedAt", ro.pushed_at AS "pushedAt"
    FROM receipt_details d
    JOIN receipts r ON r.id = d.id
    JOIN receipt_details o ON o.org_id = d.org_id AND o.id <> d.id
    JOIN receipts ro ON ro.id = o.id
    WHERE d.org_id = ${orgId} AND d.id = ANY(${ids})
      AND (
        r.file_hash = ro.file_hash
        OR (
          btrim(d.retailer) <> ''
          AND lower(btrim(regexp_replace(d.retailer, '\\s+', ' ', 'g'))) = lower(btrim(regexp_replace(o.retailer, '\\s+', ' ', 'g')))
          AND (
            (d.receipt_date = o.receipt_date AND d.receipt_total_cents = o.receipt_total_cents)
            OR (d.order_number <> '' AND d.order_number = o.order_number)
            OR (d.receipt_number <> '' AND d.receipt_number = o.receipt_number)
          )
        )
      )
      AND NOT EXISTS (SELECT 1 FROM receipt_audit_log a WHERE a.receipt_id IN (d.id, o.id) AND a.action = ${BODY_COPY_DISCARDED})
      AND NOT EXISTS (
        SELECT 1 FROM receipt_pair_decisions p
        WHERE p.kind = 'different' AND p.receipt_id = LEAST(d.id, o.id) AND p.other_receipt_id = GREATEST(d.id, o.id)
      )`;
}

/**
 * The live receipts connected to `start` through live matches, and the discarded receipts
 * matching any of them. A discarded receipt joins a group but never links one.
 */
async function component(client: Client, orgId: string, start: Node): Promise<{ live: Map<string, Node>; discarded: Map<string, Node> }> {
  const live = new Map([[start.id, start]]);
  const discarded = new Map<string, Node>();
  let frontier = [start.id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const node of await matchesOf(client, orgId, frontier)) {
      if (!isLive(node)) discarded.set(node.id, node);
      else if (!live.has(node.id)) {
        live.set(node.id, node);
        next.push(node.id);
      }
    }
    frontier = next;
  }
  return { live, discarded };
}

const day = (at: Date) => at.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

type Described = { retailer: string | null; receiptDate: string | null; receiptTotalCents: number | null };

/** A receipt in a line of text: its vendor, receipt date and total, as "Home Depot, 3 Oct, $84.12". */
export function describeReceipt(r: Described): string {
  const date = r.receiptDate && /^\d{4}-\d{2}-\d{2}$/.test(r.receiptDate) ? day(new Date(`${r.receiptDate}T00:00:00Z`)) : r.receiptDate;
  const total = r.receiptTotalCents == null ? null : `$${(r.receiptTotalCents / 100).toFixed(2)}`;
  return [r.retailer?.trim() || "Receipt", date, total].filter(Boolean).join(", ");
}

const time = (at: Date) => at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/**
 * The receipt kept in place of a copy, told apart from its copies, which share its vendor, date
 * and total: "Home Depot, uploaded 3 Oct", with the time when another of `alongside` was
 * uploaded the same day.
 */
export function describeKept(kept: { retailer: string | null; uploadedAt: Date }, alongside: Date[]): string {
  const sameDay = alongside.some((at) => at.getTime() !== kept.uploadedAt.getTime() && day(at) === day(kept.uploadedAt));
  return `${kept.retailer?.trim() || "Receipt"}, uploaded ${day(kept.uploadedAt)}${sameDay ? `, ${time(kept.uploadedAt)}` : ""}`;
}

/** The kept receipt's upload time and vendor, by id. */
export async function keptReceipts(client: Client, ids: string[]): Promise<Map<string, { retailer: string | null; uploadedAt: Date }>> {
  const rows = await client.receipt.findMany({ where: { id: { in: ids } }, select: { id: true, uploadedAt: true, details: { select: { retailer: true } } } });
  return new Map(rows.map((r) => [r.id, { retailer: r.details?.retailer ?? null, uploadedAt: r.uploadedAt }]));
}

/** Each receipt's description by id, for labels and messages. */
export async function describeReceipts(client: Client, ids: string[]): Promise<Map<string, string>> {
  const rows = await client.receiptDetail.findMany({ where: { id: { in: ids } }, select: { id: true, retailer: true, receiptDate: true, receiptTotalCents: true } });
  return new Map(rows.map((r) => [r.id, describeReceipt(r)]));
}

/**
 * How each member is shown: its state, with the date and reason of a rejection or withdrawal. A
 * member rejected as a copy names the receipt kept in its place.
 */
async function labels(client: Client, nodes: Node[]): Promise<Map<string, Omit<DuplicateMember, "id" | "state">>> {
  const ended = nodes.filter((n) => n.state === "rejected" || n.state === "discarded").map((n) => n.id);
  const logs = await client.receiptAuditLog.findMany({
    where: { receiptId: { in: ended }, action: { in: ["reject_financial", "discarded", BODY_COPY_DISCARDED, "duplicate_pair_copy_of"] } },
    orderBy: [{ changedAt: "asc" }, { id: "asc" }],
  });
  const last = new Map(logs.map((l) => [`${l.receiptId}:${l.action}`, l]));
  const copies = await client.receiptPairDecision.findMany({ where: { kind: "copy_of", copyReceiptId: { in: ended } } });
  const keptOf = new Map(copies.map((p) => [p.copyReceiptId, p.receiptId === p.copyReceiptId ? p.otherReceiptId : p.receiptId]));
  const kept = await keptReceipts(client, [...keptOf.values()]);
  const uploads = nodes.map((n) => n.uploadedAt);
  const text = (n: Node): string => {
    if (n.state === "rejected") {
      const log = last.get(`${n.id}:reject_financial`);
      const keptRow = kept.get(keptOf.get(n.id) ?? "");
      // A member already rejected when Keep this one recorded it as a copy keeps its own reason.
      const recorded = last.get(`${n.id}:duplicate_pair_copy_of`);
      if (keptRow && (!log || !recorded || log.id > recorded.id)) return `Rejected as a copy of ${describeKept(keptRow, uploads)}`;
      return log ? `Rejected on ${day(log.changedAt)}: ${log.valueAfter ?? ""}` : "Rejected";
    }
    if (n.state === "discarded") {
      if (last.has(`${n.id}:${BODY_COPY_DISCARDED}`)) return "Discarded at mail intake as a copy of its attachment";
      const log = last.get(`${n.id}:discarded`);
      return log ? `Withdrawn by its submitter on ${day(log.changedAt)}` : "Withdrawn by its submitter";
    }
    if (n.state === "receipt_finalized") return n.pushedAt ? "Finalized · Sent to expenses" : "Finalized";
    return STATE_LABELS[n.state] ?? n.state;
  };
  return new Map(nodes.map((n) => [n.id, { label: text(n), copyOfId: (n.state === "rejected" && keptOf.get(n.id)) || null }]));
}

/**
 * The duplicate group of a receipt, computed from the data on every read (design §5.1): every
 * receipt joined to it by matches, symmetric and transitive, in upload order. A discarded
 * receipt raises no flag, so it shows only beside two live members that match. Members
 * dismissed against the viewed receipt are left out of its view and listed in `dismissed`.
 */
export async function duplicateGroup(orgId: string, id: string, client: Client = db): Promise<DuplicateGroup | null> {
  const [viewed] = await client.$queryRaw<Node[]>`
    SELECT d.id, d.state, r.uploaded_at AS "uploadedAt", r.pushed_at AS "pushedAt"
    FROM receipt_details d JOIN receipts r ON r.id = d.id
    WHERE d.id = ${id} AND d.org_id = ${orgId}`;
  if (!viewed) return null;

  const decided = await client.receiptPairDecision.findMany({
    where: { orgId, kind: "different", OR: [{ receiptId: id }, { otherReceiptId: id }] },
    select: { receiptId: true, otherReceiptId: true },
  });
  const dismissedIds = new Set(decided.map((p) => (p.receiptId === id ? p.otherReceiptId : p.receiptId)));

  const live = new Map<string, Node>();
  const discarded = new Map<string, Node>();
  const starts = isLive(viewed) ? [viewed] : (await matchesOf(client, orgId, [id])).filter(isLive);
  for (const start of starts) {
    if (live.has(start.id)) continue;
    const found = await component(client, orgId, start);
    if (found.live.size < 2) continue;
    for (const [k, n] of found.live) live.set(k, n);
    for (const [k, n] of found.discarded) discarded.set(k, n);
  }

  const members = new Map([...live, ...discarded]);
  members.set(viewed.id, viewed);
  for (const other of dismissedIds) members.delete(other);
  const shown = [...members.values()].filter(isLive).length >= 2 ? [...members.values()].sort(byUpload) : [viewed];

  const dismissedRows = dismissedIds.size === 0
    ? []
    : await client.receipt.findMany({ where: { id: { in: [...dismissedIds] } }, select: { id: true, uploadedAt: true }, orderBy: [{ uploadedAt: "asc" }, { id: "asc" }] });
  const label = await labels(client, shown);
  return {
    members: shown.map((n) => ({ id: n.id, state: n.state, label: n.state, copyOfId: null, ...label.get(n.id) })),
    dismissed: dismissedRows.map((r) => r.id),
  };
}
