"use client";
import { useState } from "react";
import {
  Anchor, Badge, Button, Checkbox, Group, Modal, NumberInput, Paper, Select, Stack, Switch, Table, Text, TextInput, Textarea, Title,
} from "@mantine/core";
import { formatCents } from "@checkin/money";
import { QB_OFF, STATE_COLORS, STATE_LABELS } from "../lib/expense-constants";
import { reimburseeUnknown } from "../lib/signoff";
import { send, useBuckets, useLoad, useRoles } from "../components/api";
import LoadError from "../components/LoadError";
import NonInventoryBadge from "../components/NonInventoryBadge";
import AccountHoldsPanel, { type Hold } from "../components/AccountHoldsPanel";

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
interface SignoffStatus {
  lineItemId: number;
  filled: string[];
  missing: string[];
  blocked: string[];
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

type Action = "approve" | "raise-exception" | "reject" | "finance-assign" | "assign-owner" | "resolve-unknown";
const ACTION_LABEL: Record<Action, string> = {
  approve: "Approve",
  "raise-exception": "Raise exception",
  reject: "Reject exception",
  "finance-assign": "Assign bucket",
  "assign-owner": "Assign bucket",
  "resolve-unknown": "Resolve bucket",
};
const SEAT_LABEL: Record<string, string> = { SUBMITTER: "Submitter", PROGRAM_APPROVER: "Program approver", TREASURER: "Treasurer", BOARD: "Board" };

/** Which approval actions the caller may take on a row; the routes check again. */
function actionsFor(a: Approval, state: string, isFinance: boolean): Action[] {
  if (a.status === "pending" && state === "owner_approval") return ["approve", "raise-exception"];
  if (!isFinance) return [];
  if (a.status === "exception_raised") return ["reject", "finance-assign"];
  if (a.status === "unknown") return ["resolve-unknown"];
  if (state === "assign_ownership" && a.ownerId === null) return ["assign-owner"];
  return [];
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
  const [dialog, setDialog] = useState<{ action: Action; approval: Approval } | null>(null);
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
    const body =
      action === "approve" ? { overrideComment: text || null }
      : action === "raise-exception" || action === "reject" ? { notes: text }
      : { ownerId: Number(bucket), ...(action === "assign-owner" ? { permanent } : {}) };
    if (await send(`${base}/line-item-approvals/${approval.id}/${action}`, "POST", body, `${ACTION_LABEL[action]} done`)) {
      setDialog(null);
      reloadAll();
    }
  }

  async function sign(lineItemId: number, seat: string) {
    if (await send(`${base}/line-items/${lineItemId}/signoffs`, "POST", { seat }, `Signed as ${SEAT_LABEL[seat] ?? seat}`)) reloadAll();
  }

  if (expense.error) return <LoadError what="the expense" message={expense.error} onRetry={expense.reload} />;
  if (!e) return <Text c="dimmed">Loading…</Text>;

  const capitalRows = e.lineItems.map((l) => ({ line: l, value: capital[l.id] ?? { isCapital: l.isCapital, years: l.depreciationYears ?? "", owner: l.capitalOwnerId ? String(l.capitalOwnerId) : "" } }));
  const needsBucket = dialog && ["finance-assign", "assign-owner", "resolve-unknown"].includes(dialog.action);
  // "Always use this bucket" maps the line's GTIN, so a non-inventory line or one without a GTIN never offers it.
  const dialogLine = dialog ? e.lineItems.find((l) => l.id === dialog.approval.lineItemId) : undefined;
  const canMapPart = dialog?.action === "assign-owner" && !!dialogLine?.gtin13 && !dialogLine.nonInventory;
  // The reimbursee is FINANCE-only; when the response omits it the server stays the only check.
  const awaitingBoard = (signoffs.data ?? []).some((s) => s.missing.includes("BOARD") || s.missing.includes("BOARD_APPROVAL"));
  const held = e.reimburseePersonId !== undefined
    && reimburseeUnknown({ needsReimbursement: e.needsReimbursement, backfill: e.backfill, reimburseePersonId: e.reimburseePersonId });

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
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {e.lineItems.map((l) => {
            const a = approvalRows.find((r) => r.lineItemId === l.id);
            const s = statusOf.get(l.id);
            const noBucket = a?.ownerId == null;
            return (
              <Table.Tr key={l.id}>
                <Table.Td>{l.lineNumber}</Table.Td>
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
                <Table.Td>
                  {a && <Badge variant="light">{a.status}</Badge>}
                  <Group gap={4} mt={4}>
                    {a && actionsFor(a, e.state, isFinance).map((action) => (
                      <Button key={action} size="compact-xs" variant="light" onClick={() => { setText(""); setBucket(null); setPermanent(false); setDialog({ action, approval: a }); }}>
                        {ACTION_LABEL[action]}
                      </Button>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td>
                  {s ? (
                    <Stack gap={2}>
                      {s.filled.map((seat) => <Text key={seat} size="xs">✓ {SEAT_LABEL[seat] ?? seat}</Text>)}
                      {s.missing.filter((seat) => seat !== "BOARD_APPROVAL").map((seat) => (
                        <Button key={seat} size="compact-xs" variant="outline" disabled={held || (seat === "PROGRAM_APPROVER" && noBucket)} onClick={() => void sign(l.id, seat)}>
                          Sign as {SEAT_LABEL[seat] ?? seat}
                        </Button>
                      ))}
                      {held && s.missing.length > 0 && <Text size="xs" c="dimmed">Held until FINANCE sets the reimbursee</Text>}
                      {noBucket && s.missing.includes("PROGRAM_APPROVER") && <Text size="xs" c="dimmed">Waiting for Finance to assign a budget bucket</Text>}
                      {s.missing.includes("BOARD_APPROVAL") && <Text size="xs" c="dimmed">Held until the Board approval of this purchase is recorded</Text>}
                      {s.blocked.length > 0 && <Text size="xs" c="red">Held: {s.blocked.map((x) => SEAT_LABEL[x] ?? x).join(", ")}</Text>}
                    </Stack>
                  ) : "—"}
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

      {(isFinance || isBoard) && awaitingBoard && (
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
              if (ok) reloadAll();
            }}
          >Submit</Button>
        </Paper>
      )}

      <Modal opened={dialog !== null} onClose={() => setDialog(null)} title={dialog ? ACTION_LABEL[dialog.action] : ""}>
        <Stack>
          {needsBucket ? (
            <>
              <Select label="Bucket" data={bucketOptions} value={bucket} onChange={setBucket} searchable />
              {canMapPart && (
                <Checkbox label="Always use this bucket for this part" checked={permanent} onChange={(ev) => setPermanent(ev.currentTarget.checked)} />
              )}
            </>
          ) : (
            <Textarea
              label={dialog?.action === "approve" ? "Comment (required when FINANCE approves outside its own buckets)" : "Notes"}
              value={text}
              onChange={(ev) => setText(ev.currentTarget.value)}
            />
          )}
          <Button onClick={() => void runAction()} disabled={needsBucket ? !bucket : dialog?.action !== "approve" && !text.trim()}>
            Confirm
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
