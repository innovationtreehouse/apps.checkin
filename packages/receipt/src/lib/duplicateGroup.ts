import { db } from "../db";
import { BODY_COPY_DISCARDED } from "./receipt-flow";
import { STATE_LABELS } from "./stateLabels";

export type DuplicateMember = { id: string; state: string; label: string };
/** The viewed receipt and every member not dismissed against it, in upload order, and the ones dismissed. */
export type DuplicateGroup = { members: DuplicateMember[]; dismissed: string[] };

type Node = { id: string; state: string; uploadedAt: Date; pushedAt: Date | null };

const isLive = (n: Pick<Node, "state">) => n.state !== "discarded";
const byUpload = (a: Node, b: Node) => a.uploadedAt.getTime() - b.uploadedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Every receipt matching one of `ids` on any tier, in either direction, minus pairs a person
 * decided are different purchases. A mailed body discarded as a copy of its own message's
 * attachment matches nothing. Retailers compare case- and whitespace-folded on both sides; an
 * empty retailer, order number or receipt number matches nothing.
 */
async function matchesOf(orgId: string, ids: string[]): Promise<Node[]> {
  return db.$queryRaw<Node[]>`
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
async function component(orgId: string, start: Node): Promise<{ live: Map<string, Node>; discarded: Map<string, Node> }> {
  const live = new Map([[start.id, start]]);
  const discarded = new Map<string, Node>();
  let frontier = [start.id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const node of await matchesOf(orgId, frontier)) {
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

/** How each member is shown: its state, with the date and reason of a rejection or withdrawal. */
async function labels(nodes: Node[]): Promise<Map<string, string>> {
  const ended = nodes.filter((n) => n.state === "rejected" || n.state === "discarded").map((n) => n.id);
  const logs = await db.receiptAuditLog.findMany({
    where: { receiptId: { in: ended }, action: { in: ["reject_financial", "discarded"] } },
    orderBy: [{ changedAt: "asc" }, { id: "asc" }],
  });
  const last = new Map(logs.map((l) => [`${l.receiptId}:${l.action}`, l]));
  return new Map(
    nodes.map((n) => {
      if (n.state === "rejected") {
        const log = last.get(`${n.id}:reject_financial`);
        return [n.id, log ? `Rejected on ${day(log.changedAt)}: ${log.valueAfter ?? ""}` : "Rejected"];
      }
      if (n.state === "discarded") {
        const log = last.get(`${n.id}:discarded`);
        return [n.id, log ? `Withdrawn by its submitter on ${day(log.changedAt)}` : "Withdrawn by its submitter"];
      }
      if (n.state === "receipt_finalized") return [n.id, n.pushedAt ? "Finalized · Sent to expenses" : "Finalized"];
      return [n.id, STATE_LABELS[n.state] ?? n.state];
    }),
  );
}

/**
 * The duplicate group of a receipt, computed from the data on every read (design §5.1): every
 * receipt joined to it by matches, symmetric and transitive, in upload order. A discarded
 * receipt raises no flag, so it shows only beside two live members that match. Members
 * dismissed against the viewed receipt are left out of its view and listed in `dismissed`.
 */
export async function duplicateGroup(orgId: string, id: string): Promise<DuplicateGroup | null> {
  const [viewed] = await db.$queryRaw<Node[]>`
    SELECT d.id, d.state, r.uploaded_at AS "uploadedAt", r.pushed_at AS "pushedAt"
    FROM receipt_details d JOIN receipts r ON r.id = d.id
    WHERE d.id = ${id} AND d.org_id = ${orgId}`;
  if (!viewed) return null;

  const decided = await db.receiptPairDecision.findMany({
    where: { orgId, kind: "different", OR: [{ receiptId: id }, { otherReceiptId: id }] },
    select: { receiptId: true, otherReceiptId: true },
  });
  const dismissedIds = new Set(decided.map((p) => (p.receiptId === id ? p.otherReceiptId : p.receiptId)));

  const live = new Map<string, Node>();
  const discarded = new Map<string, Node>();
  const starts = isLive(viewed) ? [viewed] : (await matchesOf(orgId, [id])).filter(isLive);
  for (const start of starts) {
    if (live.has(start.id)) continue;
    const found = await component(orgId, start);
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
    : await db.receipt.findMany({ where: { id: { in: [...dismissedIds] } }, select: { id: true, uploadedAt: true }, orderBy: [{ uploadedAt: "asc" }, { id: "asc" }] });
  const label = await labels(shown);
  return {
    members: shown.map((n) => ({ id: n.id, state: n.state, label: label.get(n.id) ?? n.state })),
    dismissed: dismissedRows.map((r) => r.id),
  };
}
