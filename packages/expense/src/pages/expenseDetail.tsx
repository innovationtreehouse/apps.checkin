"use client";
import { useState } from "react";
import {
  Anchor, Badge, Button, Checkbox, Group, Menu, Modal, NumberInput, Paper, Select, Stack, Switch, Table, Text, TextInput, Textarea, Title,
} from "@mantine/core";
import { formatCents } from "@checkin/money";
import { QB_OFF, STATE_COLORS, STATE_LABELS } from "../lib/expense-constants";
import { send, useBuckets, useLoad, useRoles } from "../components/api";
import LoadError from "../components/LoadError";
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
  actions: LineAction[];
  awaiting: string[];
  /** Same on every line: whether the caller may record the expense's Board authorization. */
  mayRecordBoardAuthorization: boolean;
}
interface Bucket {
  id: number;
  name: string;
}

/** Why the QuickBooks drain is holding an expense back. */
const NOT_SENT: Record<string, string> = {
  NOT_TEST_DATA: "Not sent to QuickBooks: not test data",
  TEST_DATA_REFUSED: "Not sent to QuickBooks: test data is never posted in prod",
  NEEDS_FINANCE: "Not sent to QuickBooks: posting kept failing; fix the account mapping and retry",
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

/**
 * /expense/expenses/[id] — lines, bucket approvals, sign-off seats, and FINANCE's actions.
 * `listHref` is the page it was opened from, which the back link returns to.
 * `testDataToggle` is the host's word that this is dev or local; the route 404s anywhere else.
 */
export default function ExpenseDetailPage({ id, listHref = "/expense/expenses", testDataToggle = false }: { id: string; listHref?: string; testDataToggle?: boolean }) {
  const base = `/expenses/${encodeURIComponent(id)}`;
  const { isFinance, isBoard } = useRoles();
  const expense = useLoad<Expense>(base);
  const approvals = useLoad<Approval[] | { LineItemOwnerApproval: Approval[]; ExpenseBucketView: Bucket[] }>(`${base}/line-item-approvals`);
  const signoffs = useLoad<SignoffStatus[]>(`${base}/signoffs`);
  const vendor = useLoad<VendorLink>(isFinance ? `${base}/reimbursee-vendor` : null);
  const bucketOptions = useBuckets(isFinance || isBoard);
  const [dialog, setDialog] = useState<{ action: LineAction; approval: Approval } | null>(null);
  const [text, setText] = useState("");
  const [bucket, setBucket] = useState<string | null>(null);
  const [permanent, setPermanent] = useState(false);
  const [reimbursee, setReimbursee] = useState("");
  const [authorization, setAuthorization] = useState("");
  const [capital, setCapital] = useState<Record<number, { isCapital: boolean; years: number | ""; owner: string }>>({});

  const reloadAll = () => { expense.reload(); approvals.reload(); signoffs.reload(); vendor.reload(); };
  const e = expense.data;
  const approvalBag = approvals.data;
  const approvalRows = Array.isArray(approvalBag) ? approvalBag : approvalBag?.LineItemOwnerApproval ?? [];
  const bucketNames = new Map((Array.isArray(approvalBag) ? [] : approvalBag?.ExpenseBucketView ?? []).map((b) => [b.id, b.name]));
  const statusOf = new Map((signoffs.data ?? []).map((s) => [s.lineItemId, s]));

  async function runAction() {
    if (!dialog) return;
    const { action, approval } = dialog;
    const route = approvalRoute(action.act, approval);
    const body =
      action.act === "approve" ? { reason: text || null }
      : action.act === "raise-exception" || action.act === "reject-exception" ? { notes: text }
      : { ownerId: Number(bucket), ...(route === "assign-owner" ? { permanent } : {}) };
    if (await send(`${base}/line-item-approvals/${approval.id}/${route}`, "POST", body, `${actLabel(action)} done`)) {
      setDialog(null);
      reloadAll();
    }
  }

  async function sign(lineItemId: number, seat: string) {
    if (await send(`${base}/line-items/${lineItemId}/signoffs`, "POST", { seat }, `Signed as ${SEAT_LABEL[seat] ?? seat}`)) reloadAll();
  }

  /** A seat signs at once; every other act opens the dialog for its note or bucket. */
  function take(lineItemId: number, action: LineAction, approval: Approval | undefined) {
    if (action.act === "sign") {
      void sign(lineItemId, action.seat ?? "");
      return;
    }
    if (!approval) return;
    setText(""); setBucket(null); setPermanent(false);
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
  const waitingOnYou = e.lineItems.filter((l) => statusOf.get(l.id)?.actions.some((a) => a.primary)).length;

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
      {e.qbMatchState && NOT_SENT[e.qbMatchState] && <Text size="sm" c="orange">{NOT_SENT[e.qbMatchState]}</Text>}
      {isFinance && e.qbMatchState === "NEEDS_FINANCE" && (
        <Group>
          <Button
            size="xs"
            onClick={async () => { if (await send(`/expense-holds/${encodeURIComponent(e.id)}/resubmit`, "POST", {}, "QuickBooks post retried")) reloadAll(); }}
          >
            Retry QuickBooks post
          </Button>
        </Group>
      )}
      <Text size="sm">
        {e.receiptDate ?? "No receipt date"}
        {e.needsReimbursement && ` · Reimbursement${e.reimbursementFor ? ` for ${e.reimbursementFor}` : ""}`}
      </Text>
      <Group gap="xl" align="start">
        <Amount label="Total" value={formatCents(e.receiptTotalCents, e.currency)} />
        <Amount label="Tax" value={formatCents(e.taxCents, e.currency)} />
        {e.shippingCents !== 0 && <Amount label="Shipping" value={formatCents(e.shippingCents, e.currency)} />}
        {e.discountCents !== 0 && <Amount label="Discount" value={`−${formatCents(e.discountCents, e.currency)}`} />}
        <Amount label="Submitted" value={new Date(e.submittedAt).toLocaleString()} />
      </Group>

      {waitingOnYou > 0 && <Text size="sm" fw={600}>{waitingOnYou} of {e.lineItems.length} lines wait on you.</Text>}
      <ApproveAllButton base={base} statuses={signoffs.data ?? []} approvals={approvalRows} onDone={reloadAll} />
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
                <Table.Td>{a?.ownerId != null ? bucketNames.get(a.ownerId) ?? `#${a.ownerId}` : "—"}</Table.Td>
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

      <AccountHoldsPanel expenseId={e.id} holds={e.holds ?? []} lines={e.lineItems} currency={e.currency} isFinance={isFinance} onChanged={reloadAll} />

      {(e.flags ?? []).filter((f) => !f.checkedOffAt).length > 0 && (
        <Paper withBorder p="sm">
          <Text fw={600} mb="xs">Open flags</Text>
          {(e.flags ?? []).filter((f) => !f.checkedOffAt).map((f) => (
            <Text key={f.id} size="sm">🚩 {f.kind} ({f.audience}){f.detail ? ` — ${f.detail}` : ""}</Text>
          ))}
          <Anchor href="/expense/flags" size="sm">Check off on the Flags screen</Anchor>
        </Paper>
      )}

      {(signoffs.data ?? []).some((s) => s.mayRecordBoardAuthorization) && (
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
                reloadAll();
              }
            }}
          >Record Board authorization</Button>
        </Paper>
      )}

      {isFinance && e.needsReimbursement && !e.backfill && (
        <Paper withBorder p="sm">
          <Text fw={600} mb="xs">
            Reimbursee {e.reimburseePersonId ? (vendor.data?.ExpenseReimburseeView?.name ?? `person #${e.reimburseePersonId}`) : "(unknown — held)"}
          </Text>
          {!e.reimburseePersonId && (
            <Group>
              <TextInput placeholder="Person id" value={reimbursee} onChange={(ev) => setReimbursee(ev.currentTarget.value)} />
              <Button
                disabled={!/^\d+$/.test(reimbursee)}
                onClick={async () => { if (await send(`${base}/reimbursee`, "PUT", { personId: Number(reimbursee) }, "Reimbursee set")) reloadAll(); }}
              >Set reimbursee</Button>
            </Group>
          )}
          {!!e.reimburseePersonId && vendor.data && (vendor.data.ExpenseReimburseeVendor
            ? <Text size="sm">QuickBooks Vendor #{vendor.data.ExpenseReimburseeVendor.qbVendorId}</Text>
            : <VendorPicker base={base} reimbursee={vendor.data.ExpenseReimburseeView?.name ?? null} onLinked={reloadAll} />)}
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
                  <TextInput w={140} placeholder="Owner person id" value={value.owner} onChange={(ev) => setCapital({ ...capital, [line.id]: { ...value, owner: ev.currentTarget.value } })} />
                )}
                <NumberInput w={140} placeholder="Years" min={1} value={value.years} onChange={(v) => setCapital({ ...capital, [line.id]: { ...value, years: typeof v === "number" ? v : "" } })} />
              </Group>
            ))}
          <Button
            mt="xs"
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
              if (ok) reloadAll();
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
            </>
          ) : takesNote && (
            <Textarea
              label={dialog?.action.act === "approve" ? "Reason for approving in place of the bucket's approvers" : "Notes"}
              required={dialog?.action.noteRequired}
              value={text}
              onChange={(ev) => setText(ev.currentTarget.value)}
            />
          )}
          <Button onClick={() => void runAction()} disabled={needsBucket ? !bucket : !!dialog?.action.noteRequired && !text.trim()}>
            Confirm
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
