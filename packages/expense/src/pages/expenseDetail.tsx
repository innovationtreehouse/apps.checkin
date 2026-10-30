"use client";
import { useState, type ReactNode } from "react";
import {
  Alert, Anchor, Badge, Button, Checkbox, Group, Mark, Menu, Modal, NumberInput, Paper, Select, Stack, Switch, Table, Text, TextInput, Textarea, Title,
} from "@mantine/core";
import { formatCents } from "@checkin/money";
import { QB_OFF, STATE_COLORS, STATE_LABELS } from "../lib/expense-constants";
import { reviewKindOf, type ReviewKind } from "../lib/flags";
import type { QueueReason, ReasonCode } from "../lib/reasons";
import { REASON_PLACE, reasonText } from "../lib/reasonWords";
import { backToQueue, lineWaitsOnViewer } from "../lib/backToQueue";
import { lineCents } from "../qb-write";
import { api, goTo, send, useBuckets, useLoad, useRoles } from "../components/api";
import { LoadError } from "@checkin/component-ui";
import NonInventoryBadge from "../components/NonInventoryBadge";
import AccountHoldsPanel, { type Hold } from "../components/AccountHoldsPanel";
import ApproveAllButton from "../components/ApproveAllButton";

interface Line {
  id: number;
  lineNumber: number;
  description: string;
  partNumber: string | null;
  manufacturer: string | null;
  nonInventory?: boolean;
  manualQbAccount?: string | null;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
  gtin13: string | null;
  allocatedTaxCents: number | null;
  allocatedShippingCents: number | null;
  allocatedDiscountCents: number | null;
  qbAccountId?: string | null;
  isDelayed: boolean;
  isCapital: boolean;
  depreciationYears: number | null;
  capitalOwnerId: number | null;
}
interface Approval {
  id: number;
  lineItemId: number;
  ownerId: number | null;
  status: string;
  notes?: string | null;
}
interface Flag {
  id: number;
  kind: string;
  audience: string;
  detail: string | null;
  observed?: string | null;
  checkedOffAt: string | null;
}
interface Expense {
  id: string;
  vendorName: string | null;
  receiptDate: string | null;
  receiptTotalCents: number;
  taxCents: number;
  shippingCents: number;
  discountCents: number;
  currency: string;
  submittedAt: string;
  state: string;
  needsReimbursement: boolean;
  reimbursementFor?: string | null;
  reimburseePersonId?: number | null;
  backfill: boolean;
  isTestData?: boolean;
  qbMatchState?: string;
  qbTxnEntity?: string | null;
  qbVendorId?: string | null;
  qbMatchBaseline?: string | null;
  lineItems: Line[];
  approvals: Approval[];
  flags?: Flag[];
  holds?: Hold[];
}
type Act = "approve" | "sign" | "raise-exception" | "reject-exception" | "assign-bucket" | "resolve-bucket";
interface LineAction {
  act: Act;
  seat?: string;
  primary: boolean;
  noteRequired: boolean;
}
interface SignoffStatus {
  lineItemId: number;
  filled: string[];
  missing: string[];
  blocked: string[];
  actions?: LineAction[];
  awaiting?: string[];
  /** Same on every line: whether the caller may record the expense's Board authorization. */
  mayRecordBoardAuthorization: boolean;
}
interface Bucket {
  id: number;
  name: string;
}

/** The detail response: the bag, or the expense alone when the reasons were stripped. */
type Detail = Expense | { Expense: Expense; ExpenseQueueReason?: QueueReason[] };
const expenseOf = (d: Detail | null) => (d && "Expense" in d ? d.Expense : d);
/** The open reasons; null when the response carried none, so nothing is known about them. */
const reasonsOf = (d: Detail | null) => (d && "Expense" in d ? d.ExpenseQueueReason ?? null : null);

/** Why the QuickBooks drain is holding an expense back. */
const NOT_SENT: Record<string, string> = {
  NOT_TEST_DATA: "Not sent to QuickBooks: not test data",
  TEST_DATA_REFUSED: "Not sent to QuickBooks: test data is never posted in prod",
  NEEDS_FINANCE: "Not sent to QuickBooks: posting kept failing; fix the account mapping and retry",
  AMBIGUOUS: "Not sent to QuickBooks: waiting for finance to pick the matching entry or link the reimbursee's vendor",
  UNBOOKED: "Not sent to QuickBooks: the app does not book it on its own; finance books it or matches it",
  BEFORE_LINE: "Not sent to QuickBooks: the app does not book it on its own; finance books it or matches it",
};

const REVIEW_LABEL: Record<ReviewKind, { title: string; act: string }> = {
  QB_DUPLICATE_TO_VOID: { title: "Duplicate entry in QuickBooks needs voiding", act: "I voided it" },
  QB_DRIFT: { title: "Changed in QuickBooks after posting", act: "Accept the change" },
  QB_POST_HELD: { title: "Closed but not posted", act: "Mark handled" },
};

const SEAT_LABEL: Record<string, string> = { SUBMITTER: "Submitter", TREASURER: "Treasurer", BOARD: "Board" };

/** The button text, naming the role the caller acts in. */
function actLabel(a: LineAction): string {
  switch (a.act) {
    case "approve": return a.noteRequired ? "Approve as Board (program approver)" : "Approve as Program approver";
    case "sign": return `Sign as ${SEAT_LABEL[a.seat ?? ""] ?? a.seat}`;
    case "raise-exception": return "Raise exception";
    case "reject-exception": return "Reject exception";
    case "assign-bucket": return "Assign bucket";
    case "resolve-bucket": return "Resolve bucket";
  }
}

/** The approval route an act posts to; Assign bucket settles an exception or fills an unassigned line. */
function approvalRoute(act: Act, approval: Approval): string {
  switch (act) {
    case "reject-exception": return "reject";
    case "assign-bucket": return approval.status === "exception_raised" ? "finance-assign" : "assign-owner";
    case "resolve-bucket": return "resolve-unknown";
    default: return act;
  }
}

function Amount({ label, value }: { label: string; value: string }) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="sm">{value}</Text>
    </Stack>
  );
}

interface VendorLink {
  ExpenseReimburseeVendor: { qbVendorId: string } | null;
  ExpenseReimburseeView: { personId: number; name: string | null } | null;
}
interface VendorOption {
  id: string;
  displayName: string;
}

/**
 * Finance searches QuickBooks Vendors and links one after confirming its name, or creates one
 * under the reimbursee's recorded name.
 */
function VendorPicker({ base, reimbursee, onLinked }: { base: string; reimbursee: string | null; onLinked: () => void }) {
  const initial = reimbursee ?? "";
  const [text, setText] = useState(initial);
  const [query, setQuery] = useState(initial.trim().length >= 2 ? initial.trim() : "");
  const [picked, setPicked] = useState<VendorOption | null>(null);
  const options = useLoad<VendorOption[]>(query ? `${base}/reimbursee-vendor/options?q=${encodeURIComponent(query)}` : null);
  const link = async (body: unknown) => { if (await send(`${base}/reimbursee-vendor`, "PUT", body, "Vendor linked")) onLinked(); };

  if (options.error === QB_OFF) return <Text size="sm" c="dimmed">{options.error}</Text>;
  if (picked) {
    return (
      <Stack gap="xs">
        <Text size="sm">Link QuickBooks Vendor “{picked.displayName}” (#{picked.id}) as {reimbursee ?? "the reimbursee"}’s Vendor? Their Bills will be paid to it.</Text>
        <Group>
          <Button size="xs" onClick={() => link({ qbVendorId: picked.id })}>Confirm link</Button>
          <Button size="xs" variant="default" onClick={() => setPicked(null)}>Cancel</Button>
        </Group>
      </Stack>
    );
  }
  return (
    <Stack gap="xs">
      <Group>
        <TextInput placeholder="Search QuickBooks Vendors" value={text} onChange={(ev) => setText(ev.currentTarget.value)}
          onKeyDown={(ev) => { if (ev.key === "Enter") setQuery(text.trim()); }} />
        <Button variant="light" disabled={text.trim().length < 2} onClick={() => setQuery(text.trim())}>Search</Button>
      </Group>
      {options.error && <Text size="sm" c="red">{options.error}</Text>}
      {(options.data ?? []).map((v) => (
        <Group key={v.id}>
          <Text size="sm">{v.displayName}</Text>
          <Button size="xs" onClick={() => setPicked(v)}>Link</Button>
        </Group>
      ))}
      {options.data && options.data.length === 0 && <Text size="sm" c="dimmed">No unlinked Vendor matches “{query}”.</Text>}
      {reimbursee && (
        <Button size="xs" variant="subtle" w="fit-content" onClick={() => link({ createForReimbursee: true })}>Create “{reimbursee}” in QuickBooks</Button>
      )}
    </Stack>
  );
}

interface PersonOption {
  personId: number;
  name: string;
}

/**
 * Finance picks the reimbursee from live adults by name, or adds someone not on file as a
 * non-member adult, who becomes the reimbursee.
 */
function ReimburseePicker({ base, onSet }: { base: string; onSet: () => void }) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<PersonOption | null>(null);
  const [newPerson, setNewPerson] = useState<{ name: string; isAdult: boolean } | null>(null);
  const term = search.trim();
  const options = useLoad<PersonOption[]>(term.length >= 2 ? `${base}/reimbursee/options?q=${encodeURIComponent(term)}` : null);
  const body = newPerson ? { newPerson: { name: newPerson.name.trim(), isAdult: true } } : picked && { personId: picked.personId };
  const ready = newPerson ? newPerson.name.trim() !== "" && newPerson.isAdult : picked !== null;
  const people = [picked, ...(options.data ?? [])]
    .filter((p): p is PersonOption => p !== null)
    .filter((p, i, all) => all.findIndex((q) => q.personId === p.personId) === i);

  return (
    <Stack gap="xs">
      {!newPerson && (
        <Select
          label="Reimburse" placeholder="Search by name" searchable w={320}
          searchValue={search} onSearchChange={setSearch}
          data={people.map((p) => ({ value: String(p.personId), label: p.name }))}
          value={picked ? String(picked.personId) : null}
          onChange={(v) => setPicked(people.find((p) => String(p.personId) === v) ?? null)}
          filter={({ options: o }) => o}
          nothingFoundMessage={term.length >= 2 ? "No matching adults" : "Type at least two letters"}
        />
      )}
      {options.error && <Text size="sm" c="red">{options.error}</Text>}
      <Checkbox label="Not a member / not in the list" checked={newPerson !== null} onChange={(ev) => setNewPerson(ev.currentTarget.checked ? { name: "", isAdult: false } : null)} />
      {newPerson && (
        <>
          <TextInput label="Their full name" description="Adds them as a non-member, who is reimbursed" maxLength={200} w={320} required
            value={newPerson.name} onChange={(ev) => setNewPerson({ ...newPerson, name: ev.currentTarget.value })} />
          <Checkbox label="They are an adult (18 or over)" checked={newPerson.isAdult} onChange={(ev) => setNewPerson({ ...newPerson, isAdult: ev.currentTarget.checked })} />
        </>
      )}
      <Button w="fit-content" disabled={!ready}
        onClick={async () => { if (body && (await send(`${base}/reimbursee`, "PUT", body, "Reimbursee set"))) onSet(); }}
      >Set reimbursee</Button>
    </Stack>
  );
}

/** A field an open reason is about. */
function Marked({ on, children }: { on: boolean; children: ReactNode }) {
  return on ? <Mark color="red">{children}</Mark> : <>{children}</>;
}

/** "Waiting on finance:" and "Waiting on the Board:", one line per open reason and where it is answered. */
function ReasonsAlert({ reasons, currency }: { reasons: QueueReason[]; currency: string }) {
  const groups = [
    { title: "Waiting on finance:", rows: reasons.filter((r) => r.tab !== "board") },
    { title: "Waiting on the Board:", rows: reasons.filter((r) => r.tab === "board") },
  ].filter((g) => g.rows.length > 0);
  if (groups.length === 0) return null;
  return (
    <Alert color="orange">
      <Stack gap="xs">
        {groups.map((g) => (
          <Stack key={g.title} gap={2}>
            <Text size="sm" fw={600}>{g.title}</Text>
            {g.rows.map((r) => (
              <Text key={r.code} size="sm">{reasonText(r, currency)} · {REASON_PLACE[r.code]}</Text>
            ))}
          </Stack>
        ))}
      </Stack>
    </Alert>
  );
}

interface PostedEntry {
  key?: string;
  amountCents: number;
  accounts: string[];
  vendorId: string | null;
}

/** What the app expects QuickBooks to hold: what the drain posted, or the entry as it was when matched. */
function expectedEntry(e: Expense): PostedEntry | null {
  if (e.qbMatchState === "MATCHED") return e.qbMatchBaseline ? (JSON.parse(e.qbMatchBaseline) as PostedEntry) : null;
  return {
    key: "this expense's app key",
    amountCents: e.lineItems.reduce((sum, l) => sum + lineCents(l), 0),
    accounts: e.lineItems.map((l) => l.qbAccountId ?? "").sort(),
    vendorId: e.qbTxnEntity === "Bill" ? e.qbVendorId ?? null : null,
  };
}

/** The drifted fields: what the app posted or matched beside what QuickBooks shows now. */
function DriftValues({ e, observed }: { e: Expense; observed: string | null | undefined }) {
  const now = JSON.parse(observed ?? "{}") as Record<string, unknown>;
  const was = expectedEntry(e);
  const show = (field: string, v: unknown) =>
    field === "amount" && typeof v === "number" ? formatCents(v, e.currency)
    : Array.isArray(v) ? v.join(", ") || "—"
    : v == null ? "—" : String(v);
  const stored: Record<string, unknown> = { missing: "present", amount: was?.amountCents, accounts: was?.accounts, vendor: was?.vendorId, key: was?.key ?? null };
  const rows = Object.keys(now);
  if (rows.length === 0) return null;
  return (
    <Table>
      <Table.Thead>
        <Table.Tr><Table.Th>Field</Table.Th><Table.Th>Posted</Table.Th><Table.Th>QuickBooks now</Table.Th></Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((field) => (
          <Table.Tr key={field}>
            <Table.Td>{field}</Table.Td>
            <Table.Td>{show(field, stored[field])}</Table.Td>
            <Table.Td>{field === "missing" ? "removed" : show(field, now[field])}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** The open reviews, each closed with a required note saying what finance did. */
function ReviewsPanel({ e, reviews, onDecided }: { e: Expense; reviews: { flag: Flag; kind: ReviewKind }[]; onDecided: () => void }) {
  const [notes, setNotes] = useState<Record<number, string>>({});
  return (
    <Paper withBorder p="sm">
      <Text fw={600} mb="xs">Reviews</Text>
      <Stack>
        {reviews.map(({ flag, kind }) => {
          const note = notes[flag.id] ?? "";
          return (
            <Stack key={flag.id} gap="xs">
              <Text size="sm" fw={500}>{REVIEW_LABEL[kind].title}</Text>
              {flag.detail && <Text size="sm" c="dimmed">{flag.detail}</Text>}
              {kind === "QB_DRIFT" && <DriftValues e={e} observed={flag.observed} />}
              <Textarea
                label="What finance did"
                required
                value={note}
                onChange={(ev) => setNotes({ ...notes, [flag.id]: ev.currentTarget.value })}
              />
              <Button
                size="xs"
                w="fit-content"
                disabled={!note.trim()}
                onClick={async () => { if (await send(`/flags/${flag.id}/check-off`, "POST", { notes: note, shown: { detail: flag.detail, observed: flag.observed ?? null } }, "Review closed")) onDecided(); }}
              >{REVIEW_LABEL[kind].act}</Button>
            </Stack>
          );
        })}
      </Stack>
    </Paper>
  );
}

interface Candidate {
  id: string;
  txnDate: string;
  totalCents: number;
  accountRef: string | null;
  vendorRef: string | null;
}

/** QuickBooks entries the expense may match: pick one, or exclude one that belongs to nothing, with a reason. */
function MatchPicker({ base, currency, onDecided }: { base: string; currency: string; onDecided: () => void }) {
  const candidates = useLoad<Candidate[]>(`${base}/qb-candidates`);
  const [excluding, setExcluding] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  if (candidates.error) return <Text size="sm" c={candidates.error === QB_OFF ? "dimmed" : "red"}>{candidates.error}</Text>;
  if (!candidates.data) return <Text size="sm" c="dimmed">Loading QuickBooks entries…</Text>;
  if (candidates.data.length === 0) return <Text size="sm" c="dimmed">No unclaimed QuickBooks entry matches this expense.</Text>;
  return (
    <Stack gap="xs">
      {candidates.data.map((c) => (
        <Stack key={c.id} gap={4}>
          <Group>
            <Text size="sm">{c.txnDate} · {formatCents(c.totalCents, currency)}{c.vendorRef ? ` · ${c.vendorRef}` : ""} · entry #{c.id}</Text>
            <Button size="compact-xs" onClick={async () => { if (await send(`${base}/qb-match`, "POST", { qbTxnId: c.id }, "Matched to the QuickBooks entry")) onDecided(); }}>Pick</Button>
            <Button size="compact-xs" variant="subtle" onClick={() => { setExcluding(c.id); setWhy(""); }}>Exclude</Button>
          </Group>
          {excluding === c.id && (
            <Group align="end">
              <Textarea label="Why this entry belongs to no expense" required value={why} onChange={(ev) => setWhy(ev.currentTarget.value)} />
              <Button
                size="xs"
                disabled={!why.trim()}
                onClick={async () => {
                  if (await send("/qb-exclusions", "POST", { qbTxnId: c.id, reason: why }, "Entry excluded from matching")) {
                    setExcluding(null);
                    candidates.reload();
                  }
                }}
              >Confirm exclusion</Button>
            </Group>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * /expense/expenses/[id] — lines, bucket approvals, sign-off seats, and FINANCE's actions.
 * `listHref` is the page it was opened from, which the back link returns to.
 * `queueHref` is the queue it was opened from (a Finance review tab, or an approver's Expense approvals
 * list), which a decision returns to once nothing is left for the viewer.
 * `testDataToggle` is the host's word that this is dev or local; the route 404s anywhere else.
 */
export default function ExpenseDetailPage({ id, listHref = "/expense/expenses", queueHref, testDataToggle = false }: { id: string; listHref?: string; queueHref?: string; testDataToggle?: boolean }) {
  const base = `/expenses/${encodeURIComponent(id)}`;
  const { isFinance, isBoard } = useRoles();
  const expense = useLoad<Detail>(base);
  const approvals = useLoad<Approval[] | { LineItemOwnerApproval: Approval[]; ExpenseBucketView: Bucket[] }>(`${base}/line-item-approvals`);
  const signoffs = useLoad<SignoffStatus[]>(`${base}/signoffs`);
  const vendor = useLoad<VendorLink>(isFinance ? `${base}/reimbursee-vendor` : null);
  const bucketOptions = useBuckets(isFinance || isBoard);
  const [dialog, setDialog] = useState<{ action: LineAction; approval: Approval } | null>(null);
  const [text, setText] = useState("");
  const [bucket, setBucket] = useState<string | null>(null);
  const [permanent, setPermanent] = useState(false);
  const [final, setFinal] = useState(false);
  const [authorization, setAuthorization] = useState("");
  const [capital, setCapital] = useState<Record<number, { isCapital: boolean; years: number | ""; owner: string }>>({});
  const [taxNote, setTaxNote] = useState("");

  const reloadAll = () => { expense.reload(); approvals.reload(); signoffs.reload(); vendor.reload(); };
  // A decision goes back to the queue once the refreshed reasons and line acts leave the viewer nothing to act on.
  const decided = async () => {
    if (queueHref) {
      const [fresh, lines] = await Promise.all([api<Detail>(base).catch(() => null), api<SignoffStatus[]>(`${base}/signoffs`).catch(() => null)]);
      const left = reasonsOf(fresh);
      const target = backToQueue(queueHref, left === null || left.some((r) => r.actionable) || lines === null || lineWaitsOnViewer(lines));
      if (target) {
        goTo(target);
        return;
      }
    }
    reloadAll();
  };
  const e = expenseOf(expense.data);
  const reasons = reasonsOf(expense.data) ?? [];
  const open = (code: ReasonCode) => reasons.some((r) => r.code === code);
  const approvalBag = approvals.data;
  const approvalRows = Array.isArray(approvalBag) ? approvalBag : approvalBag?.LineItemOwnerApproval ?? [];
  const bucketNames = new Map((Array.isArray(approvalBag) ? [] : approvalBag?.ExpenseBucketView ?? []).map((b) => [b.id, b.name]));
  // A status without acts draws none, so a short response leaves the line as plain status.
  const statuses = (signoffs.data ?? []).map((s) => ({ ...s, actions: s.actions ?? [], awaiting: s.awaiting ?? [] }));
  const statusOf = new Map(statuses.map((s) => [s.lineItemId, s]));

  async function runAction() {
    if (!dialog) return;
    const { action, approval } = dialog;
    const route = approvalRoute(action.act, approval);
    const body =
      action.act === "approve" ? { reason: text || null }
      : action.act === "raise-exception" || action.act === "reject-exception" ? { notes: text }
      : route === "finance-assign" ? { ownerId: Number(bucket), final, note: final ? text : null }
      : { ownerId: Number(bucket), ...(route === "assign-owner" ? { permanent } : {}) };
    if (await send(`${base}/line-item-approvals/${approval.id}/${route}`, "POST", body, `${actLabel(action)} done`)) {
      setDialog(null);
      await decided();
    }
  }

  async function sign(lineItemId: number, seat: string) {
    if (await send(`${base}/line-items/${lineItemId}/signoffs`, "POST", { seat }, `Signed as ${SEAT_LABEL[seat] ?? seat}`)) await decided();
  }

  /** A seat signs at once; every other act opens the dialog for its note or bucket. */
  function take(lineItemId: number, action: LineAction, approval: Approval | undefined) {
    if (action.act === "sign") {
      void sign(lineItemId, action.seat ?? "");
      return;
    }
    if (!approval) return;
    setText(""); setBucket(null); setPermanent(false); setFinal(false);
    setDialog({ action, approval });
  }

  if (expense.error) return <LoadError what="the expense" message={expense.error} onRetry={expense.reload} />;
  if (!e) return <Text c="dimmed">Loading…</Text>;

  const capitalRows = e.lineItems.map((l) => ({ line: l, value: capital[l.id] ?? { isCapital: l.isCapital, years: l.depreciationYears ?? "", owner: l.capitalOwnerId ? String(l.capitalOwnerId) : "" } }));
  const needsBucket = dialog?.action.act === "assign-bucket" || dialog?.action.act === "resolve-bucket";
  const takesNote = !needsBucket && dialog !== null && (dialog.action.act !== "approve" || dialog.action.noteRequired);
  // "Always use this bucket" maps the line's GTIN, so a non-inventory line or one without a GTIN never offers it.
  const dialogLine = dialog ? e.lineItems.find((l) => l.id === dialog.approval.lineItemId) : undefined;
  const canMapPart = dialog !== null && approvalRoute(dialog.action.act, dialog.approval) === "assign-owner" && !!dialogLine?.gtin13 && !dialogLine.nonInventory;
  // Settling an exception, finance may make the bucket final; that takes a note.
  const canMakeFinal = dialog !== null && approvalRoute(dialog.action.act, dialog.approval) === "finance-assign";
  const finalNoteMissing = canMakeFinal && final && !text.trim();
  const waitingOnYou = e.lineItems.filter((l) => statusOf.get(l.id)?.actions.some((a) => a.primary)).length;
  const reviews = (e.flags ?? []).flatMap((flag) => {
    const kind = flag.checkedOffAt ? null : reviewKindOf(flag);
    return kind ? [{ flag, kind }] : [];
  });

  return (
    <Stack>
      <Anchor href={listHref} size="sm">← Back</Anchor>
      <Group>
        <Title order={3}>{e.vendorName ?? e.id}</Title>
        <Badge color={STATE_COLORS[e.state] ?? "gray"} variant="light">{STATE_LABELS[e.state] ?? e.state}</Badge>
        {e.backfill && <Badge color="gray">Backfill</Badge>}
        {e.isTestData && <Badge color="grape">Test data</Badge>}
      </Group>
      {isFinance && testDataToggle && (
        <Switch
          label="Test data"
          checked={e.isTestData ?? false}
          onChange={async (ev) => { if (await send(`${base}/test-data`, "PUT", { isTestData: ev.currentTarget.checked }, "Test data updated")) reloadAll(); }}
        />
      )}
      <ReasonsAlert reasons={reasons} currency={e.currency} />
      {e.qbMatchState && NOT_SENT[e.qbMatchState] && <Text size="sm" c="orange">{NOT_SENT[e.qbMatchState]}</Text>}
      {isFinance && (e.qbMatchState === "NEEDS_FINANCE" || open("QB_AWAITING_MATCH") || open("QB_VENDOR_MISSING") || open("QB_UNBOOKED")) && (
        <Paper withBorder p="sm">
          <Text fw={600} mb="xs">QuickBooks</Text>
          {e.qbMatchState === "NEEDS_FINANCE" && (
            <Button
              size="xs"
              onClick={async () => { if (await send(`/expense-holds/${encodeURIComponent(e.id)}/resubmit`, "POST", {}, "QuickBooks post retried")) await decided(); }}
            >
              Retry QuickBooks post
            </Button>
          )}
          {open("QB_UNBOOKED") && (
            <Stack gap="xs">
              <Text size="sm">Not in QuickBooks. Book it to have the app create the entry, or pick the entry finance already booked.</Text>
              <Button
                size="xs"
                onClick={async () => { if (await send(`/expense-holds/${encodeURIComponent(e.id)}/resubmit`, "POST", {}, "Booked in QuickBooks")) await decided(); }}
              >
                Book it
              </Button>
              <MatchPicker base={base} currency={e.currency} onDecided={() => void decided()} />
            </Stack>
          )}
          {open("QB_AWAITING_MATCH") && (
            <Stack gap="xs">
              <Text size="sm">Several QuickBooks entries match; pick one.</Text>
              <MatchPicker base={base} currency={e.currency} onDecided={() => void decided()} />
            </Stack>
          )}
          {open("QB_VENDOR_MISSING") && (
            <Text size="sm">The reimbursee has no QuickBooks vendor yet; link one in the Reimbursee panel below. The next drain then posts it.</Text>
          )}
        </Paper>
      )}
      <Text size="sm">
        {e.receiptDate ?? "No receipt date"}
        {e.needsReimbursement && ` · Reimbursement${e.reimbursementFor ? ` for ${e.reimbursementFor}` : ""}`}
      </Text>
      <Group gap="xl" align="start">
        <Marked on={open("BOARD_APPROVAL")}><Amount label="Total" value={formatCents(e.receiptTotalCents, e.currency)} /></Marked>
        <Marked on={open("TAX_NOT_REVIEWED")}><Amount label="Tax" value={formatCents(e.taxCents, e.currency)} /></Marked>
        {e.shippingCents !== 0 && <Amount label="Shipping" value={formatCents(e.shippingCents, e.currency)} />}
        {e.discountCents !== 0 && <Amount label="Discount" value={`−${formatCents(e.discountCents, e.currency)}`} />}
        <Amount label="Submitted" value={new Date(e.submittedAt).toLocaleString()} />
      </Group>
      {isFinance && open("TAX_NOT_REVIEWED") && (
        <Paper withBorder p="sm">
          <Text fw={600} mb="xs">Tax not reviewed on the receipt</Text>
          <Textarea label="Note" description="Optional" value={taxNote} onChange={(ev) => setTaxNote(ev.currentTarget.value)} />
          <Button
            mt="xs"
            onClick={async () => {
              if (await send(`${base}/tax-approval`, "POST", { note: taxNote.trim() || null }, "Tax approved")) {
                setTaxNote("");
                await decided();
              }
            }}
          >Approve tax</Button>
        </Paper>
      )}

      {signoffs.error && <LoadError what="the line actions" message={signoffs.error} onRetry={signoffs.reload} />}
      {waitingOnYou > 0 && <Text size="sm" fw={600}>{waitingOnYou} of {e.lineItems.length} lines wait on you.</Text>}
      <ApproveAllButton base={base} statuses={signoffs.data ?? []} approvals={approvalRows} onDone={() => void decided()} />
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>#</Table.Th>
            <Table.Th>Description</Table.Th>
            <Table.Th>Part #</Table.Th>
            <Table.Th>Manufacturer</Table.Th>
            <Table.Th ta="right">Qty</Table.Th>
            <Table.Th ta="right">Unit</Table.Th>
            <Table.Th ta="right">Total</Table.Th>
            <Table.Th>GTIN-13</Table.Th>
            <Table.Th>Bucket</Table.Th>
            <Table.Th>Approval</Table.Th>
            <Table.Th>Sign-off</Table.Th>
            <Table.Th>Action</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {e.lineItems.map((l) => {
            const a = approvalRows.find((r) => r.lineItemId === l.id);
            const s = statusOf.get(l.id);
            const main = s?.actions.find((x) => x.primary);
            const more = s?.actions.filter((x) => !x.primary) ?? [];
            return (
              <Table.Tr key={l.id} fw={main ? 700 : undefined} data-waiting-on-you={main ? true : undefined}>
                <Table.Td>{main && <span aria-label="Waits on you">→ </span>}{l.lineNumber}</Table.Td>
                <Table.Td>
                  {l.description}{l.nonInventory && <NonInventoryBadge />}
                  {(l.isDelayed || l.isCapital) && (
                    <Group gap={4} mt={2}>
                      {l.isDelayed && <Badge color="orange" size="xs">Delayed</Badge>}
                      {l.isCapital && <Badge color="indigo" size="xs">Capital</Badge>}
                    </Group>
                  )}
                </Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{l.partNumber ?? "—"}</Text></Table.Td>
                <Table.Td><Text size="xs">{l.manufacturer ?? "—"}</Text></Table.Td>
                <Table.Td ta="right">{l.quantity}</Table.Td>
                <Table.Td ta="right">{formatCents(l.unitPriceCents, e.currency)}</Table.Td>
                <Table.Td ta="right">{formatCents(l.totalPriceCents, e.currency)}</Table.Td>
                <Table.Td><Text size="xs" ff="monospace">{l.gtin13 ?? "—"}</Text></Table.Td>
                <Table.Td>
                  <Marked on={(open("BUCKET_TO_ASSIGN") && a?.ownerId == null) || (open("BUCKET_UNKNOWN") && a?.status === "unknown")}>
                    {a?.ownerId != null ? bucketNames.get(a.ownerId) ?? `#${a.ownerId}` : "—"}
                  </Marked>
                </Table.Td>
                <Table.Td>{a && <Badge variant="light">{a.status}</Badge>}</Table.Td>
                <Table.Td>
                  {s ? (
                    <Stack gap={2}>
                      {s.filled.map((seat) => <Text key={seat} size="xs">✓ {SEAT_LABEL[seat] ?? seat}</Text>)}
                      {s.awaiting.map((w) => <Text key={w} size="xs" c={w.startsWith("Held") ? "red" : "dimmed"}>{w}</Text>)}
                    </Stack>
                  ) : "—"}
                </Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    {main && (
                      <Button size="compact-xs" onClick={() => take(l.id, main, a)}>{actLabel(main)}</Button>
                    )}
                    {more.length > 0 && (
                      <Menu position="bottom-end">
                        <Menu.Target>
                          <Button size="compact-xs" variant="subtle">More</Button>
                        </Menu.Target>
                        <Menu.Dropdown>
                          {more.map((x) => (
                            <Menu.Item key={`${x.act}-${x.seat ?? ""}`} onClick={() => take(l.id, x, a)}>{actLabel(x)}</Menu.Item>
                          ))}
                        </Menu.Dropdown>
                      </Menu>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>

      <AccountHoldsPanel expenseId={e.id} holds={e.holds ?? []} lines={e.lineItems} currency={e.currency} isFinance={isFinance} onChanged={() => void decided()} />

      {isFinance && reviews.length > 0 && <ReviewsPanel e={e} reviews={reviews} onDecided={() => void decided()} />}

      {statuses.some((s) => s.mayRecordBoardAuthorization) && (
        <Paper withBorder p="sm">
          <Text fw={600} mb="xs">Board authorization</Text>
          <Textarea
            label="What the Board authorized"
            description="What the Board decided in writing: its own authorization, or the line of the approved program budget that covers this purchase. Recording it is not an approval. Recorded once; it cannot be changed. A Board member records it only when no finance holder without a conflict can."
            required
            value={authorization}
            onChange={(ev) => setAuthorization(ev.currentTarget.value)}
          />
          <Button
            mt="xs"
            disabled={!authorization.trim()}
            onClick={async () => {
              if (await send(`${base}/board-authorization`, "POST", { authorization }, "Board authorization recorded")) {
                setAuthorization("");
                await decided();
              }
            }}
          >Record Board authorization</Button>
        </Paper>
      )}

      {isFinance && e.needsReimbursement && !e.backfill && (
        <Paper withBorder p="sm">
          <Text fw={600} mb="xs">
            Reimbursee{" "}
            <Marked on={open("REIMBURSEE_TO_NAME") || open("QB_VENDOR_MISSING")}>
              {e.reimburseePersonId ? (vendor.data?.ExpenseReimburseeView?.name ?? `person #${e.reimburseePersonId}`) : "(unknown — held)"}
            </Marked>
          </Text>
          {!e.reimburseePersonId && <ReimburseePicker base={base} onSet={() => void decided()} />}
          {!!e.reimburseePersonId && vendor.data && (vendor.data.ExpenseReimburseeVendor
            ? <Text size="sm">QuickBooks Vendor #{vendor.data.ExpenseReimburseeVendor.qbVendorId}</Text>
            : <VendorPicker base={base} reimbursee={vendor.data.ExpenseReimburseeView?.name ?? null} onLinked={() => void decided()} />)}
        </Paper>
      )}

      {isFinance && (e.state === "capital_review" || e.state === "set_depreciation_cycle") && (
        <Paper withBorder p="sm">
          <Text fw={600} mb="xs">{e.state === "capital_review" ? "Capital review" : "Depreciation cycle"}</Text>
          {capitalRows
            .filter(({ line }) => e.state === "capital_review" || line.isCapital)
            .map(({ line, value }) => (
              <Group key={line.id} mb={4}>
                <Text size="sm" w={240} truncate>{line.description}</Text>
                {e.state === "capital_review" && (
                  <Checkbox label="Capital" checked={value.isCapital} onChange={(ev) => setCapital({ ...capital, [line.id]: { ...value, isCapital: ev.currentTarget.checked } })} />
                )}
                {e.state === "set_depreciation_cycle" && (
                  <Select
                    w={200} placeholder="Owner bucket" aria-label={`Owner bucket for ${line.description}`} data={bucketOptions} searchable
                    value={value.owner || null} onChange={(v) => setCapital({ ...capital, [line.id]: { ...value, owner: v ?? "" } })}
                  />
                )}
                <NumberInput w={140} placeholder="Years" min={1} value={value.years} onChange={(v) => setCapital({ ...capital, [line.id]: { ...value, years: typeof v === "number" ? v : "" } })} />
              </Group>
            ))}
          <Button
            mt="xs"
            disabled={e.state === "set_depreciation_cycle" && capitalRows.some(({ line, value }) => line.isCapital && (!value.owner || value.years === ""))}
            onClick={async () => {
              const ok = e.state === "capital_review"
                ? await send(`${base}/capital-review/submit`, "POST", {
                    lineItems: capitalRows.map(({ line, value }) => ({
                      lineItemId: line.id, isCapital: value.isCapital, depreciationYears: value.years === "" ? null : value.years,
                    })),
                  }, "Capital review submitted")
                : await send(`${base}/set-depreciation-cycle/submit`, "POST", {
                    items: capitalRows.filter(({ line }) => line.isCapital).map(({ line, value }) => ({
                      lineItemId: line.id, depreciationYears: Number(value.years), ownerId: Number(value.owner),
                    })),
                  }, "Depreciation cycle set");
              if (ok) await decided();
            }}
          >Submit</Button>
        </Paper>
      )}

      <Modal opened={dialog !== null} onClose={() => setDialog(null)} title={dialog ? actLabel(dialog.action) : ""}>
        <Stack>
          {needsBucket ? (
            <>
              <Select label="Bucket" data={bucketOptions} value={bucket} onChange={setBucket} searchable />
              {canMapPart && (
                <Checkbox label="Always use this bucket for this part" checked={permanent} onChange={(ev) => setPermanent(ev.currentTarget.checked)} />
              )}
              {canMakeFinal && (
                <Checkbox
                  label="Make this final"
                  description="No further exception can be raised; the bucket's approver approves it, or a Board member stands in. This is not an approval."
                  checked={final}
                  onChange={(ev) => setFinal(ev.currentTarget.checked)}
                />
              )}
              {canMakeFinal && final && (
                <Textarea label="Why this bucket is final" required value={text} onChange={(ev) => setText(ev.currentTarget.value)} />
              )}
            </>
          ) : takesNote && (
            <Textarea
              label={dialog?.action.act === "approve" ? "Reason for approving in place of the bucket's approvers" : "Notes"}
              required={dialog?.action.noteRequired}
              value={text}
              onChange={(ev) => setText(ev.currentTarget.value)}
            />
          )}
          <Button onClick={() => void runAction()} disabled={needsBucket ? !bucket || finalNoteMissing : !!dialog?.action.noteRequired && !text.trim()}>
            Confirm
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
