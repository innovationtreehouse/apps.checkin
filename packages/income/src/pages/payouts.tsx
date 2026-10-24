"use client";
import { Fragment, useState } from "react";
import { Anchor, Badge, Code, Table, Text, Title } from "@mantine/core";
import { money, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

interface PayoutRow {
  payoutGid: string;
  issuedAt: string;
  status: string;
  netCents: number;
  currency: string | null;
  source: "api" | "hand_loaded";
}

interface TxnRow {
  txnGid: string;
  type: string;
  orderName: string | null;
  amountCents: number;
  feeCents: number;
  netCents: number;
  source: "api" | "hand_loaded";
}

interface ReconRow {
  status: string;
  kind: string | null;
  depositId: string | null;
  depositTxnDate: string | null;
  reason: string | null;
}

interface PayoutDetail {
  IncomeBalanceTxnView: TxnRow[];
  PayoutReconciliation: ReconRow | null;
}

function SourceBadge({ source }: { source: string }) {
  return source === "hand_loaded" ? <Badge size="sm" color="gray">loaded history</Badge> : null;
}

function Detail({ gid }: { gid: string }) {
  const detail = useLoad<PayoutDetail>(`/payouts/${encodeURIComponent(gid)}`);
  if (detail.error) return <LoadError what="payout detail" message={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Text c="dimmed">Loading…</Text>;
  const recon = detail.data.PayoutReconciliation;
  return (
    <>
      <Text size="sm" mb="xs">
        Reconciliation:{" "}
        {recon ? <><Badge size="sm">{recon.status}</Badge> {recon.kind ?? ""} {recon.depositId ? `deposit ${recon.depositId} (${recon.depositTxnDate})` : ""}</>
          : "not reconciled yet"}
      </Text>
      <Table withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Type</Table.Th>
            <Table.Th>Order</Table.Th>
            <Table.Th>Amount</Table.Th>
            <Table.Th>Fee</Table.Th>
            <Table.Th>Net</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {detail.data.IncomeBalanceTxnView.map((t) => (
            <Table.Tr key={t.txnGid}>
              <Table.Td>{t.type}</Table.Td>
              <Table.Td>{t.orderName ?? "—"}</Table.Td>
              <Table.Td>{money(t.amountCents)}</Table.Td>
              <Table.Td>{money(t.feeCents)}</Table.Td>
              <Table.Td>{money(t.netCents)}</Table.Td>
              <Table.Td><SourceBadge source={t.source} /></Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  );
}

/** /income/payouts — paid Shopify payouts from the mirror, with each one's transactions. */
export default function PayoutsPage() {
  const payouts = useLoad<PayoutRow[]>("/payouts");
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <Title order={3} mb="md">Payouts</Title>
      {payouts.error && <LoadError what="payouts" message={payouts.error} onRetry={payouts.reload} />}
      {payouts.data === null ? <Text c="dimmed">Loading…</Text>
        : payouts.data.length === 0 ? <Text c="dimmed">No paid payouts in the store mirror.</Text>
        : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Issued</Table.Th>
                <Table.Th>Net</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Payout</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {payouts.data.map((p) => (
                <Fragment key={p.payoutGid}>
                  <Table.Tr>
                    <Table.Td>{new Date(p.issuedAt).toLocaleDateString()}</Table.Td>
                    <Table.Td>{money(p.netCents)}</Table.Td>
                    <Table.Td>{p.status} <SourceBadge source={p.source} /></Table.Td>
                    <Table.Td><Code>{p.payoutGid}</Code></Table.Td>
                    <Table.Td>
                      <Anchor size="sm" onClick={() => setOpen(open === p.payoutGid ? null : p.payoutGid)}>
                        {open === p.payoutGid ? "Hide" : "Details"}
                      </Anchor>
                    </Table.Td>
                  </Table.Tr>
                  {open === p.payoutGid && (
                    <Table.Tr>
                      <Table.Td colSpan={5}><Detail gid={p.payoutGid} /></Table.Td>
                    </Table.Tr>
                  )}
                </Fragment>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </>
  );
}
