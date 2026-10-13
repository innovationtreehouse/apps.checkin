"use client";
import { useState } from "react";
import {
  Anchor, Badge, Button, Checkbox, Group, Modal, NumberInput, Paper, Select, Stack, Table, Text, TextInput, Textarea, Title,
} from "@mantine/core";
import { formatCents } from "@inventory/money";
import { STATE_COLORS, STATE_LABELS } from "../lib/expense-constants";
import { send, useBuckets, useLoad, useRoles } from "../components/api";
import LoadError from "../components/LoadError";

interface Line {
  id: number;
  lineNumber: number;
  description: string;
  partNumber: string | null;
  quantity: number;
  totalPriceCents: number;
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
  currency: string;
  state: string;
  needsReimbursement: boolean;
  reimbursementFor?: string | null;
  reimburseePersonId?: number | null;
  backfill: boolean;
  lineItems: Line[];
  approvals: Approval[];
  flags?: Flag[];
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

type Action = "approve" | "raise-exception" | "reject" | "finance-assign" | "assign-owner" | "resolve-unknown";
const ACTION_LABEL: Record<Action, string> = {
  approve: "Approve",
  "raise-exception": "Raise exception",
  reject: "Reject exception",
  "finance-assign": "Assign bucket",
  "assign-owner": "Assign bucket",
  "resolve-unknown": "Resolve bucket",
};
const SEAT_LABEL: Record<string, string> = { SUBMITTER: "Submitter", PROGRAM_APPROVER: "Program approver", TREASURER: "Treasurer" };

/** Which approval actions the caller may take on a row; the routes check again. */
function actionsFor(a: Approval, state: string, isFinance: boolean): Action[] {
  if (a.status === "pending" && state === "owner_approval") return ["approve", "raise-exception"];
  if (!isFinance) return [];
  if (a.status === "exception_raised") return ["reject", "finance-assign"];
  if (a.status === "unknown") return ["resolve-unknown"];
  if (state === "assign_ownership" && a.ownerId === null) return ["assign-owner"];
  return [];
}

/** /expense/expenses/[id] — lines, bucket approvals, sign-off seats, and FINANCE's actions. */
export default function ExpenseDetailPage({ id, listHref = "/expense/expenses" }: { id: string; listHref?: string }) {
  const base = `/expenses/${encodeURIComponent(id)}`;
  const { isFinance, isBoard } = useRoles();
  const expense = useLoad<Expense>(base);
  const approvals = useLoad<Approval[] | { LineItemOwnerApproval: Approval[]; ExpenseBucketView: Bucket[] }>(`${base}/line-item-approvals`);
  const signoffs = useLoad<SignoffStatus[]>(`${base}/signoffs`);
  const bucketOptions = useBuckets(isFinance || isBoard);
  const [dialog, setDialog] = useState<{ action: Action; approval: Approval } | null>(null);
  const [text, setText] = useState("");
  const [bucket, setBucket] = useState<string | null>(null);
  const [permanent, setPermanent] = useState(false);
  const [reimbursee, setReimbursee] = useState("");
  const [capital, setCapital] = useState<Record<number, { isCapital: boolean; years: number | ""; owner: string }>>({});

  const reloadAll = () => { expense.reload(); approvals.reload(); signoffs.reload(); };
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

  return (
    <Stack>
      <Anchor href={listHref} size="sm">← Expenses</Anchor>
      <Group>
        <Title order={3}>{e.vendorName ?? e.id}</Title>
        <Badge color={STATE_COLORS[e.state] ?? "gray"} variant="light">{STATE_LABELS[e.state] ?? e.state}</Badge>
        {e.backfill && <Badge color="gray">Backfill</Badge>}
      </Group>
      <Text size="sm">
        {e.receiptDate ?? "No receipt date"} · {formatCents(e.receiptTotalCents, e.currency)}
        {e.needsReimbursement && ` · Reimbursement${e.reimbursementFor ? ` for ${e.reimbursementFor}` : ""}`}
      </Text>

      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>#</Table.Th>
            <Table.Th>Description</Table.Th>
            <Table.Th>Total</Table.Th>
            <Table.Th>Bucket</Table.Th>
            <Table.Th>Approval</Table.Th>
            <Table.Th>Sign-off</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {e.lineItems.map((l) => {
            const a = approvalRows.find((r) => r.lineItemId === l.id);
            const s = statusOf.get(l.id);
            return (
              <Table.Tr key={l.id}>
                <Table.Td>{l.lineNumber}</Table.Td>
                <Table.Td>{l.description}{l.partNumber && <Text size="xs" c="dimmed">{l.partNumber}</Text>}</Table.Td>
                <Table.Td>{formatCents(l.totalPriceCents, e.currency)}</Table.Td>
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
                      {s.missing.map((seat) => (
                        <Button key={seat} size="compact-xs" variant="outline" onClick={() => void sign(l.id, seat)}>
                          Sign as {SEAT_LABEL[seat] ?? seat}
                        </Button>
                      ))}
                      {s.blocked.length > 0 && <Text size="xs" c="red">Held: {s.blocked.map((x) => SEAT_LABEL[x] ?? x).join(", ")}</Text>}
                    </Stack>
                  ) : "—"}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>

      {(e.flags ?? []).filter((f) => !f.checkedOffAt).length > 0 && (
        <Paper withBorder p="sm">
          <Text fw={600} mb="xs">Open flags</Text>
          {(e.flags ?? []).filter((f) => !f.checkedOffAt).map((f) => (
            <Text key={f.id} size="sm">🚩 {f.kind} ({f.audience}){f.detail ? ` — ${f.detail}` : ""}</Text>
          ))}
          <Anchor href="/expense/flags" size="sm">Check off on the Flags screen</Anchor>
        </Paper>
      )}

      {isFinance && e.needsReimbursement && !e.backfill && (
        <Paper withBorder p="sm">
          <Text fw={600} mb="xs">Reimbursee {e.reimburseePersonId ? `(person #${e.reimburseePersonId})` : "(unknown — held)"}</Text>
          <Group>
            <TextInput placeholder="Person id" value={reimbursee} onChange={(ev) => setReimbursee(ev.currentTarget.value)} />
            <Button
              disabled={!/^\d+$/.test(reimbursee)}
              onClick={async () => { if (await send(`${base}/reimbursee`, "PUT", { personId: Number(reimbursee) }, "Reimbursee set")) reloadAll(); }}
            >Set reimbursee</Button>
          </Group>
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

      <Modal opened={dialog !== null} onClose={() => setDialog(null)} title={dialog ? ACTION_LABEL[dialog.action] : ""}>
        <Stack>
          {needsBucket ? (
            <>
              <Select label="Bucket" data={bucketOptions} value={bucket} onChange={setBucket} searchable />
              {dialog?.action === "assign-owner" && (
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
