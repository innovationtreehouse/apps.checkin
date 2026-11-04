"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useViewer } from "@checkin/component-ui";
import { notifications } from "@mantine/notifications";
import { Alert, Anchor, Badge, Button, Group, Mark, Modal, Paper, Stack, Table, Text, Textarea, TextInput, Title } from "@mantine/core";
import DuplicateCompare, { type CompareReceipt } from "../components/DuplicateCompare";
import ReceiptFile from "../components/ReceiptFile";
import ReceiptEditor from "../components/ReceiptEditor";
import { CONFIRM_AS_READ, confirmedByReimbursee } from "../components/ConfirmationList";
import { api, BASE, errorMessage, outcomeSteps, receiptStateLabel, send, STATE_LABELS, useLoad, useRoles, type ReceiptListRow } from "../components/api";
import { formatCents } from "@checkin/money";
import { differenceDollars, draftMath, draftProblem, EMPTY_DRAFT, hasTypedDetails, isDirty, planSave, roundingAllowed, type Draft, type ServerLine } from "../components/receiptDraft";
import { returnQueue, reviewDetailHref, reviewHref } from "../components/reviewQueue";
import { useReceipts } from "../components/useReceipts";
import { day } from "../lib/describeReceipt";
import type { DuplicateGroup } from "../lib/duplicateGroup";
import { missingDetails } from "../lib/missingDetails";
import { describeCorrection, editsSinceReading, submitterCorrections, type SubmitterCorrection } from "../lib/submitterCorrections";

const REVIEW_REASON_LABELS: Record<string, string> = {
  tax: "tax was charged",
  old_date: "the receipt is older than the age limit",
  future_date: "the receipt is dated in the future",
  submitter_correction: "the submitter changed the tax or date",
};

/** Marks a value that is a reason the receipt is in finance review. */
function Flagged({ on, children }: { on: boolean; children: React.ReactNode }) {
  return on ? <Mark color="red">{children}</Mark> : <>{children}</>;
}

interface Receipt extends ReceiptListRow {
  mimeType: string;
  taxCents: number | null;
  shippingCents: number | null;
  discountCents: number | null;
  reimbursementFor?: string | null;
  fileHash?: string;
  receiptNumber?: string | null;
  orderNumber?: string | null;
  currency?: string;
  /** Finance and board views only. */
  duplicateSuspectReceiptId?: string | null;
  duplicateFlagClearedAt?: string | null;
  financialReviewReasons: string[];
  lineItems: ServerLine[];
  /** The viewer's own other copy of this receipt; never another person's. */
  duplicateNotice?: { matchId: string; uploadedAt: string } | null;
}

interface AuditRow {
  id: number;
  action: string;
  userId: number | null;
  username: string | null;
  fieldChanged: string | null;
  valueBefore: string | null;
  valueAfter: string | null;
  changedAt: string;
}

/** How a submitter's correction to a field reads beside it: "entered by the submitter", or the earlier value. */
function correctionNote(c: SubmitterCorrection | undefined): string {
  if (!c) return "";
  return c.kind === "entered" ? " (entered by the submitter)" : ` (the submitter changed it from ${c.before})`;
}

const STEP_COLOR = { done: "green", refused: "red", waiting: "gray" } as const;

/** What happened to a finalized receipt's purchase after it left the receipt system. */
function PurchaseOutcomePanel({ receipt }: { receipt: Receipt }) {
  const steps = outcomeSteps(receipt.purchaseOutcome);
  if (steps.length === 0) return null;
  return (
    <Paper withBorder p="sm">
      <Text fw={500} mb="xs">What happened next</Text>
      <Stack gap={4}>
        {steps.map((step) => (
          <div key={step.label}>
            <Badge variant="light" color={STEP_COLOR[step.tone]}>{step.label}</Badge>
            {step.notes.map((note) => (
              <Text key={note} size="sm" mt={2}>{note}</Text>
            ))}
          </div>
        ))}
      </Stack>
    </Paper>
  );
}

const EDITABLE = new Set(["ocr_failed", "validation_failed", "submitter_review"]);
const TERMINAL = new Set(["receipt_finalized", "discarded", "rejected"]);

/**
 * /receipts/[id] — one receipt: its file, details and lines, and the actions its state allows the
 * caller. Opened from the host's finance queue at `queueBase` (`?queue=` present), a decision
 * returns to that queue.
 */
export default function ReceiptDetailPage({ queueBase }: { queueBase?: string }) {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queueParam = useSearchParams().get("queue");
  const fromReview = queueParam !== null && queueBase !== undefined;
  const viewer = useViewer();
  const { isFinance, isBoard } = useRoles();
  const receipt = useLoad<Receipt>(`/${id}`);
  const audit = useLoad<AuditRow[]>(isFinance || isBoard ? `/${id}/audit-logs` : null);
  const open = receipt.data != null && !TERMINAL.has(receipt.data.state);
  const held = receipt.data?.state === "duplicate_flagged";
  const group = useLoad<DuplicateGroup>((isFinance || isBoard) && open ? `/${id}/duplicate-group` : null);
  const otherMembers = group.data?.members.filter((m) => m.id !== id) ?? [];
  const liveIds = group.data?.members.filter((m) => m.state !== "discarded").map((m) => m.id) ?? [];
  const comparing = open && liveIds.some((m) => m !== id);
  const compared = useReceipts<CompareReceipt>([...otherMembers.map((m) => m.id), ...(group.data?.dismissed ?? [])]);
  const suspectId = receipt.data?.duplicateSuspectReceiptId ?? null;
  const memberKey = group.data ? group.data.members.map((m) => m.id).join(",") : null;
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set<string>());
  // A column that wasn't on the first drawing of the panel is tagged New until the page is left.
  useEffect(() => {
    if (memberKey === null) return;
    const ids = memberKey.split(",");
    if (seen.current) {
      const known = seen.current;
      const arrived = ids.filter((m) => !known.has(m));
      if (arrived.length > 0) setFresh((prior) => new Set([...prior, ...arrived]));
    }
    seen.current = new Set([...(seen.current ?? []), ...ids]);
  }, [memberKey]);
  const redrawCompare = () => {
    group.reload();
    compared.reload();
  };
  // A screen left open is usually current again before anyone clicks; the server still refuses a stale decision.
  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      receipt.reload();
      group.reload();
      compared.reload();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [open, receipt.reload, group.reload, compared.reload]);
  useEffect(() => {
    if (group.error) notifications.show({ title: "Couldn't load the possible copies", message: group.error, color: "red", autoClose: false });
  }, [group.error]);
  const loadErrors = [...compared.errors.values()].join("; ");
  useEffect(() => {
    if (loadErrors) notifications.show({ title: "Couldn't load a possible copy", message: loadErrors, color: "red", autoClose: false });
  }, [loadErrors]);
  const [note, setNote] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [confirmingRead, setConfirmingRead] = useState(false);
  // A ref, not state: a second click in the same tick must see the first save already running.
  const busy = useRef(false);

  const r = receipt.data;
  if (receipt.error) return <Alert color="red">{receipt.error}</Alert>;
  if (!r) return <Text>Loading…</Text>;

  const back = fromReview
    ? { href: reviewHref(queueBase, returnQueue(queueParam, r.state)), label: "Finance review" }
    : { href: "/receipts", label: "My receipts" };

  const reasons = r.financialReviewReasons;
  const dateFlagged = reasons.includes("old_date") || reasons.includes("future_date");
  const taxFlagged = reasons.includes("tax");
  // Finance and the Board read the audit log, so they see whether each correction entered a value or changed one.
  const corrections = audit.data
    ? submitterCorrections(
        editsSinceReading(audit.data).filter((a) => a.userId === r.uploadedByUserId),
        { taxCents: r.taxCents, receiptDate: r.receiptDate },
      )
    : [];
  const correctionOf = (field: SubmitterCorrection["field"]) => corrections.find((c) => c.field === field);
  const reasonLabel = (reason: string) =>
    reason === "submitter_correction" && corrections.length > 0
      ? corrections.map(describeCorrection).join("; ")
      : (REVIEW_REASON_LABELS[reason] ?? reason);
  const own = viewer?.id === r.uploadedByUserId;
  const isAdult = viewer?.ageBand === "adult";
  const reimburseeConfirms = confirmedByReimbursee(r);
  // `decides` marks an action that moves the receipt out of the queue it was opened from.
  const act = async (path: string, method: string, body: unknown, success: string, failed: string, decides = false) => {
    if (await send(`/${id}${path}`, method, body, success, failed)) {
      if (decides && fromReview) {
        router.push(back.href);
        return;
      }
      setNote("");
      setRejectReason("");
      setDraft(EMPTY_DRAFT);
      receipt.reload();
      audit.reload();
    }
  };
  const rejectMatch = async (otherId: string, reason: string) => {
    if (await send(`/${otherId}/reject`, "POST", { reason }, "That copy is rejected", "Couldn't reject that copy")) {
      receipt.reload();
      audit.reload();
    }
    redrawCompare();
  };
  /** Not this one: the match is a different purchase, and the panel redraws from the fresh group. */
  const notThisOne = async (otherId: string) => {
    if (await send(`/${id}/not-this-one`, "POST", { otherId }, "Dismissed as a different purchase", "Couldn't dismiss this match")) {
      receipt.reload();
      audit.reload();
    }
    redrawCompare();
  };
  const undoNotThisOne = async (otherId: string) => {
    if (await send(`/${id}/not-this-one/${encodeURIComponent(otherId)}`, "DELETE", {}, "Dismissal undone", "Couldn't undo this dismissal")) {
      receipt.reload();
      audit.reload();
    }
    redrawCompare();
  };
  const hrefOf = (other: string) => reviewDetailHref(other, returnQueue(queueParam, r.state));
  const originalHref = suspectId ? hrefOf(suspectId) : "";
  const editing = EDITABLE.has(r.state) && !r.pushedAt && (own || isFinance);
  const dirty = editing && isDirty(r, draft);
  const totalsOff = r.state === "validation_failed";
  // A saved receipt whose lines already add up still needs a way out of Totals off.
  const savedAddsUp = totalsOff && draftMath(r, EMPTY_DRAFT)?.balanced === true;
  const unread = r.state === "ocr_failed";
  // Details saved before a failed resubmit still need a way out of Couldn't read.
  const savedTyped = unread && missingDetails(r).length === 0;
  const failed = (message: string) => notifications.show({ title: "Receipt not saved", message, color: "red", autoClose: false });

  const readAgain = () => act("/retry-ocr", "POST", {}, "Read again", "Couldn't read the receipt again", true);

  /** Applies the draft's writes in order; on a failure the draft keeps whatever is still unsaved. */
  const saveDraft = async (): Promise<boolean> => {
    const problem = draftProblem(r, draft);
    if (problem) {
      failed(problem);
      return false;
    }
    let remaining = draft;
    for (const op of planSave(r, draft)) {
      try {
        await api(`/${id}${op.path}`, { method: op.method, ...(op.body ? { body: JSON.stringify(op.body) } : {}) });
      } catch (err) {
        setDraft(remaining);
        receipt.reload();
        failed(errorMessage(err));
        return false;
      }
      if (op.addedKey !== undefined) remaining = { ...remaining, added: remaining.added.filter((a) => a.key !== op.addedKey) };
    }
    setDraft(EMPTY_DRAFT);
    receipt.reload();
    audit.reload();
    return true;
  };
  /** Runs `work` unless a save is already running, so a double click never posts a new line twice. */
  const exclusive = async (work: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      await work();
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const save = () =>
    exclusive(async () => {
      if (await saveDraft()) notifications.show({ message: "Saved", color: "green" });
    });
  const stillOff = (message: string) => notifications.show({ message, color: "yellow", autoClose: false });
  /** Sends the saved receipt back through the flow and reports where it landed. */
  const resubmit = async (saved: boolean) => {
    let after: Receipt;
    try {
      after = await api<Receipt>(`/${id}/resubmit`, { method: "POST", body: "{}" });
    } catch (err) {
      receipt.reload();
      audit.reload();
      notifications.show({ title: saved ? "Saved, but couldn't resubmit" : "Couldn't resubmit this receipt", message: errorMessage(err), color: "red", autoClose: false });
      return;
    }
    window.dispatchEvent(new Event("nav-counts-mutated"));
    if (after.state === "validation_failed") {
      stillOff(`${saved ? "Saved. " : ""}The totals still don't add up; stays in Totals off.`);
    } else {
      notifications.show({ message: `${saved ? "Saved and resubmitted" : "Resubmitted"}: ${STATE_LABELS[after.state] ?? after.state}`, color: "green" });
      if (fromReview) {
        router.push(back.href);
        return;
      }
    }
    receipt.reload();
    audit.reload();
  };
  /** Saves a receipt whose totals were off, and resubmits it once its lines add up to its total. */
  const saveTotalsOff = () =>
    exclusive(async () => {
      const math = draftMath(r, draft);
      if (dirty && !(await saveDraft())) return;
      if (math?.balanced) await resubmit(dirty);
      else {
        const off = math ? `${differenceDollars(Math.abs(math.differenceCents))} off${roundingAllowed(math.allowedCents)}` : "off";
        stillOff(`Saved. Still ${off}; stays in Totals off.`);
      }
    });
  /** Runs a state change after saving any unsaved edits, so the change acts on what the screen shows. */
  const afterSave = (run: () => Promise<void>) =>
    exclusive(async () => {
      if (dirty && !(await saveDraft())) return;
      await run();
    });

  return (
    <Stack>
      <Anchor component={Link} href={back.href} size="sm">← {back.label}</Anchor>
      <Group justify="space-between">
        <Title order={3}>{r.retailer ?? "Receipt"}</Title>
        <Group gap="xs">
          {r.isInKind && <Badge>Donation</Badge>}
          <Badge variant="light">{receiptStateLabel(r)}</Badge>
        </Group>
      </Group>
      {r.state === "rejected" ? (
        <Alert color="red" title="Rejected by finance">
          <Text size="sm">{r.validationNotes ?? "No reason was recorded."}</Text>
          {own && r.rejectionUnacknowledged && (
            <Button size="xs" mt="sm" color="red" variant="light" onClick={() => void act("/acknowledge-rejection", "POST", {}, "Acknowledged", "Couldn't acknowledge this rejection")}>
              Got it
            </Button>
          )}
        </Alert>
      ) : (
        r.validationNotes && <Alert color="yellow">{r.validationNotes}</Alert>
      )}
      <PurchaseOutcomePanel receipt={r} />
      {r.financialReviewReasons.length > 0 && (
        <Alert color="blue">Finance review: {r.financialReviewReasons.map(reasonLabel).join("; ")}</Alert>
      )}
      {comparing && (
        <Badge color="orange" variant="light" w="fit-content">Possible duplicate: in a group of {liveIds.length}</Badge>
      )}
      {own && r.duplicateNotice ? (
        <Alert color="yellow">
          You already sent this receipt on{" "}
          <Anchor component={Link} href={`/receipts/${encodeURIComponent(r.duplicateNotice.matchId)}`}>{day(new Date(r.duplicateNotice.uploadedAt))}</Anchor>.
          {" "}You can discard this copy if it is the same purchase.
        </Alert>
      ) : (
        own && held && <Alert color="yellow">Finance will check this for a possible duplicate.</Alert>
      )}
      {comparing && group.data && (
        <DuplicateCompare
          receipt={r}
          group={group.data}
          loaded={compared.loaded}
          loadErrors={compared.errors}
          onRetry={compared.reload}
          fresh={fresh}
          hrefOf={hrefOf}
          isFinance={isFinance}
          own={own}
          onNotThisOne={(otherId) => void notThisOne(otherId)}
          onUndo={(otherId) => void undoNotThisOne(otherId)}
          onDifferentPurchases={() => void act("/different-purchases", "POST", { shownIds: liveIds }, "Recorded as different purchases", "Couldn't record different purchases", true).then(redrawCompare)}
          onKeepThisOne={() => void act("/keep-this-one", "POST", { shownIds: liveIds }, "Kept; the other copies are rejected", "Couldn't keep this receipt", true).then(redrawCompare)}
          onRejectMatch={(otherId, reason) => void rejectMatch(otherId, reason)}
          onRejectAsCopy={(reason) => void act("/reject", "POST", { reason }, "Rejected", "Couldn't reject this receipt", true).then(redrawCompare)}
        />
      )}
      {!comparing && suspectId && (
        <Text size="sm">
          This receipt was flagged as a possible duplicate of <Anchor component={Link} href={originalHref}>another receipt</Anchor>
          {r.duplicateFlagClearedAt ? " and cleared as not a duplicate." : "."}
        </Text>
      )}

      <Group align="flex-start" grow wrap="wrap">
        <Paper withBorder p="sm" miw={280}>
          <ReceiptFile src={`${BASE}/${r.id}/file`} mimeType={r.mimeType} />
        </Paper>
        <Stack miw={280}>
          <Text>Date: <Flagged on={dateFlagged}>{r.receiptDate ?? "—"}</Flagged>{correctionNote(correctionOf("date"))}</Text>
          <Text>
            Total: {formatCents(r.receiptTotalCents)} (<Flagged on={taxFlagged}>tax {formatCents(r.taxCents)}</Flagged>{correctionNote(correctionOf("tax"))}, shipping {formatCents(r.shippingCents)}
            {r.discountCents ? `, discount ${formatCents(r.discountCents)}` : ""})
          </Text>
          {r.needsReimbursement && <Text>Reimbursement owed{r.reimbursementFor ? ` to ${r.reimbursementFor}` : ""}</Text>}
          {!editing && (
            <Table>
              <Table.Thead>
                <Table.Tr><Table.Th>Item</Table.Th><Table.Th>Qty</Table.Th><Table.Th>Total</Table.Th></Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {r.lineItems.map((l) => (
                  <Table.Tr key={l.id}>
                    <Table.Td>{l.description}{l.isDelayed && <Badge ml="xs" size="xs" color="orange">Backordered</Badge>}</Table.Td>
                    <Table.Td>{l.quantity}</Table.Td>
                    <Table.Td>{formatCents(l.totalPriceCents)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}

          {editing && (
            <Group gap="xs">
              <Button size="xs" disabled={!dirty && !savedAddsUp && !savedTyped} loading={saving} onClick={() => void (totalsOff ? saveTotalsOff() : unread ? afterSave(() => resubmit(dirty)) : save())}>Save changes</Button>
              {dirty && (
                <Button size="xs" variant="subtle" onClick={() => setDraft(EMPTY_DRAFT)}>Undo changes</Button>
              )}
            </Group>
          )}

          <Group gap="xs">
            {own && r.state === "submitter_review" && (
              <>
                {reimburseeConfirms ? (
                  <Text size="sm" c="dimmed">The person reimbursed confirms the lines and amounts.</Text>
                ) : (
                  <Button size="xs" disabled={saving} onClick={() => void afterSave(() => act("/submitter-confirm", "POST", {}, "Confirmed", "Couldn't confirm this receipt"))}>
                    {r.needsReimbursement ? CONFIRM_AS_READ : "Confirm"}
                  </Button>
                )}
                {isAdult && !r.isInKind && (
                  <Button size="xs" variant="light" onClick={() => void act("/reimbursement", "PUT", { needsReimbursement: !r.needsReimbursement }, "Updated", "Couldn't change who paid")}>
                    {r.needsReimbursement ? "I didn't pay for this" : "I paid for this myself"}
                  </Button>
                )}
              </>
            )}
            {(own || isFinance) && r.state === "ocr_failed" && (
              <Button size="xs" variant="light" onClick={() => (dirty || hasTypedDetails(r) ? setConfirmingRead(true) : void readAgain())}>Read it again</Button>
            )}
            {own && !TERMINAL.has(r.state) && (
              <Button size="xs" variant="subtle" color="red" onClick={() => void act("/discard", "POST", {}, "Discarded", "Couldn't discard this receipt", true)}>Discard</Button>
            )}
          </Group>

          {isFinance && (
            <Paper withBorder p="sm">
              <Stack gap="xs">
                <Text fw={500} size="sm">Finance</Text>
                {r.state === "financial_review" && !own && (
                  <Button size="xs" w="fit-content" color="green" onClick={() => void act("/approve", "POST", {}, "Approved", "Couldn't approve this receipt", true)}>Approve</Button>
                )}
                {!TERMINAL.has(r.state) && !r.pushedAt && !own && (
                  <Group align="end" gap="xs">
                    <Textarea label="Reason to reject" autosize value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} style={{ flex: 1 }} />
                    <Button size="xs" color="red" variant="light" disabled={!rejectReason.trim()} onClick={() => void act("/reject", "POST", { reason: rejectReason.trim() }, "Rejected", "Couldn't reject this receipt", true)}>Reject</Button>
                  </Group>
                )}
                {r.state === "financial_review" && own && <Text size="sm" c="dimmed">Someone else in finance decides on your own receipt.</Text>}
                {held && (isFinance || isBoard) && group.data && !comparing && !own && (
                  <Group gap="xs">
                    <Text size="sm">No other receipt matches this one now.</Text>
                    <Button size="xs" w="fit-content" onClick={() => void act("/different-purchases", "POST", { shownIds: [id] }, "Released from the duplicate hold", "Couldn't release this receipt", true)}>Different purchases</Button>
                  </Group>
                )}
                {r.state === "flow_error" && (
                  <Button size="xs" w="fit-content" onClick={() => void act("/restart-flow", "POST", {}, "Restarted", "Couldn't restart this receipt", true)}>Restart</Button>
                )}
                {(r.state === "discarded" || r.state === "rejected") && (
                  <Group align="end">
                    <TextInput label="Why this file is never a receipt" value={note} onChange={(e) => setNote(e.currentTarget.value)} style={{ flex: 1 }} />
                    <Button size="xs" variant="light" color="red" disabled={!note.trim()} onClick={() => void act("/ignore-file", "POST", { reason: note }, "This file is ignored in mail from now on", "Couldn't ignore this file")}>
                      Ignore this file from now on
                    </Button>
                  </Group>
                )}
                {r.state === "receipt_finalized" && !r.pushedAt && (
                  <Button size="xs" w="fit-content" variant="light" onClick={() => void act("/push-to-inventory", "POST", {}, "Sent", "Couldn't send this receipt downstream")}>Send downstream</Button>
                )}
              </Stack>
            </Paper>
          )}
        </Stack>
      </Group>

      {editing && <ReceiptEditor receipt={r} draft={draft} onChange={setDraft} taxNote={own} />}

      <Modal opened={confirmingRead} onClose={() => setConfirmingRead(false)} title="Read it again">
        <Stack>
          <Text>A good reading replaces the details and lines typed on this receipt. Unsaved changes are lost either way.</Text>
          <Group justify="end">
            <Button variant="default" onClick={() => setConfirmingRead(false)}>Cancel</Button>
            <Button
              onClick={() => {
                setConfirmingRead(false);
                void readAgain();
              }}
            >
              Read it again
            </Button>
          </Group>
        </Stack>
      </Modal>

      {audit.data && (
        <Paper withBorder p="sm">
          <Text fw={500} size="sm" mb="xs">History</Text>
          {audit.data.map((a) => (
            <Text key={a.id} size="xs">
              {new Date(a.changedAt).toLocaleString()} · {a.username ?? "system"} · {a.action}{a.valueAfter ? ` (${a.valueAfter})` : ""}
            </Text>
          ))}
        </Paper>
      )}
    </Stack>
  );
}
