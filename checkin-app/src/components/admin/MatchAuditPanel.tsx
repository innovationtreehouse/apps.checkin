"use client";

import { useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Group, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { formatCents } from "@checkin/money";
// Type-only imports: erased at compile time, so the server modules' prisma
// imports never reach the client bundle — and a server-side reshape is a
// compile error here instead of a silent drift.
import type { MatchAuditResult } from "@/lib/finance/matchAudit";
import type { TrackBody } from "@/app/api/finance-ops/s-read/match-audit/track/route";

/**
 * Board-facing Shopify ↔ activation match audit (lib/finance/matchAudit.ts via
 * GET /api/finance-ops/s-read/match-audit). Button-fired, never on page load —
 * the audit sweeps the whole mirror-relevant surface and wakes the scale-to-zero
 * cluster, so a human asks for it when something looks wrong.
 *
 * Rendering rule: clean buckets collapse to a one-line count; only the gap
 * buckets (unclaimed paid orders, activations with no payment basis, order ids
 * missing from the mirror) get row-level tables. Manual/scholarship rows are
 * listed too — they are legitimate, but "who recorded what" is exactly what an
 * auditor is here to see.
 */

export function MatchAuditPanel() {
  const [result, setResult] = useState<MatchAuditResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tracking, setTracking] = useState<Set<string>>(new Set());

  // Optimistic local bucket flip → TRACKED_EXCEPTION. Deliberately NOT a re-run of
  // the audit: a re-run re-sweeps the whole mirror and wakes the scale-to-zero
  // cluster for what is a one-row state change. The next real "Run
  // match audit" reconciles from the DB (matchAudit.ts's tracked lookup) anyway.
  const track = async (key: string, body: TrackBody) => {
    setTracking((s) => new Set(s).add(key));
    try {
      const res = await fetch('/api/finance-ops/s-read/match-audit/track', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        notifications.show({ color: 'red', autoClose: false, message: data.error || 'Failed to track this gap.' });
        return;
      }
      // Flip the matching row's bucket in-place; the memo re-buckets it out of the
      // gap table and into the tracked count.
      setResult((prev) => prev && {
        ...prev,
        orders: prev.orders.map((o) => body.kind === 'order' && o.orderLegacyId === body.shopifyOrderId ? { ...o, bucket: 'TRACKED_EXCEPTION' as const } : o),
        memberships: prev.memberships.map((m) => body.kind === 'membership' && m.processId === body.processId ? { ...m, bucket: 'TRACKED_EXCEPTION' as const } : m),
        enrollments: prev.enrollments.map((e) => body.kind === 'enrollment' && e.programId === body.programId && e.personId === body.personId ? { ...e, bucket: 'TRACKED_EXCEPTION' as const } : e),
      });
      notifications.show({ message: 'Gap tracked as a payment problem.' });
    } catch {
      notifications.show({ color: 'red', autoClose: false, message: 'Network error tracking this gap.' });
    } finally {
      setTracking((s) => { const n = new Set(s); n.delete(key); return n; });
    }
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/finance-ops/s-read/match-audit');
      if (res.status === 503) {
        setResult(null);
        setError('The Shopify mirror is not wired in this environment.');
        return;
      }
      if (!res.ok) throw new Error();
      setResult((await res.json()) as MatchAuditResult);
    } catch {
      setResult(null);
      setError('Match audit failed to run — see the server log, or run diagnostics on the System Status page.');
    } finally {
      setRunning(false);
    }
  };

  // One memoized pass per result: this panel re-renders on every keystroke in
  // the page's resolve-exception modal, and the audit arrays can be large.
  const { unclaimedPaid, unclaimedUnpaid, membershipGaps, enrollmentGaps, manual, scholarships, comped, reversedMemberships, reversedEnrollments, preMirrorCount, matched } = useMemo(() => {
    const matchedCounts = { orders: 0, tracked: 0, memberships: 0, enrollments: 0 };
    let preMirrorCount = 0;
    const groups = {
      unclaimedPaid: [] as NonNullable<typeof result>['orders'],
      unclaimedUnpaid: [] as NonNullable<typeof result>['orders'],
      membershipGaps: [] as NonNullable<typeof result>['memberships'],
      enrollmentGaps: [] as NonNullable<typeof result>['enrollments'],
      manual: [] as NonNullable<typeof result>['memberships'],
      scholarships: [] as NonNullable<typeof result>['enrollments'],
      comped: [] as NonNullable<typeof result>['enrollments'],
      reversedMemberships: [] as NonNullable<typeof result>['memberships'],
      reversedEnrollments: [] as NonNullable<typeof result>['enrollments'],
      matched: matchedCounts,
    };
    for (const o of result?.orders ?? []) {
      if (o.bucket === 'UNCLAIMED_PAID') groups.unclaimedPaid.push(o);
      else if (o.bucket === 'UNCLAIMED_UNPAID') groups.unclaimedUnpaid.push(o);
      else if (o.bucket === 'MATCHED') matchedCounts.orders++;
      else if (o.bucket === 'TRACKED_EXCEPTION') matchedCounts.tracked++;
    }
    for (const m of result?.memberships ?? []) {
      if (m.bucket === 'NO_PAYMENT_BASIS' || m.bucket === 'ORDER_NOT_IN_MIRROR' || m.bucket === 'NO_PROCESS') groups.membershipGaps.push(m);
      else if (m.bucket === 'MANUAL_PAYMENT') groups.manual.push(m);
      else if (m.bucket === 'ORDER_REVERSED') groups.reversedMemberships.push(m);
      else if (m.bucket === 'PRE_MIRROR') preMirrorCount++;
      else if (m.bucket === 'TRACKED_EXCEPTION') matchedCounts.tracked++;
      else matchedCounts.memberships++; // ORDER_MATCHED
    }
    for (const e of result?.enrollments ?? []) {
      if (e.bucket === 'NO_PAYMENT_BASIS' || e.bucket === 'ORDER_NOT_IN_MIRROR') groups.enrollmentGaps.push(e);
      else if (e.bucket === 'SCHOLARSHIP_APPROVED') groups.scholarships.push(e);
      else if (e.bucket === 'ADMIN_COMPED') groups.comped.push(e);
      else if (e.bucket === 'ORDER_REVERSED') groups.reversedEnrollments.push(e);
      else if (e.bucket === 'PRE_MIRROR') preMirrorCount++;
      else if (e.bucket === 'TRACKED_EXCEPTION') matchedCounts.tracked++;
      else matchedCounts.enrollments++; // ORDER_MATCHED
    }
    return { ...groups, preMirrorCount };
  }, [result]);
  const gapCount = unclaimedPaid.length + membershipGaps.length + enrollmentGaps.length;

  const count = (label: string, n: number) => (
    <Text size="sm" component="span" mr="md">{label}: <b>{n}</b></Text>
  );

  return (
    <Card withBorder radius="md" padding="lg" mt="md">
      <Group justify="space-between" mb="xs">
        <Title order={4}>Shopify ↔ Activation Match Audit</Title>
        <Button size="xs" variant="light" onClick={run} loading={running}>Run match audit</Button>
      </Group>
      <Text size="sm" c="dimmed">
        Checks that every membership/program purchase (matched by variant) has an activation, and every
        activation has an order, a manually recorded payment, or an approved scholarship behind it. Donations and
        merchandise never match a known variant and are not expected to reconcile.
      </Text>

      {error && <Alert color="red" mt="md">{error}</Alert>}

      {result && (
        <>
          {result.configuredVariants === 0 && (
            <Alert color="red" mt="md">
              No membership or program variant ids are configured in checkin, so nothing tells this audit
              which orders should reconcile — the order side below is empty because it is <b>blind</b>, not
              because it is clean. Set the variant ids in Board Settings / on the programs first.
            </Alert>
          )}
          {result.variantCoverage.withVariant === 0 && result.variantCoverage.lines > 0 && (
            <Alert color="red" mt="md">
              The mirror has {result.variantCoverage.lines} order lines but none carry a variant id — it predates
              variant mirroring. The order side of this audit is blind until an s-read <b>backfill</b> sync runs.
            </Alert>
          )}
          {result.variantCoverage.withVariant > 0 && result.variantCoverage.withVariant < result.variantCoverage.lines && (
            <Alert color="yellow" mt="md">
              {result.variantCoverage.lines - result.variantCoverage.withVariant} of {result.variantCoverage.lines} mirror
              order lines still have no variant id (a backfill is incomplete or predates variant mirroring for part of
              history). Orders made of only those lines are <b>absent</b> from this report, not shown as gaps.
            </Alert>
          )}

          <Group mt="md" gap="xs">
            {gapCount === 0
              ? <Badge>No gaps</Badge>
              : <Badge color="red">{gapCount} gap(s)</Badge>}
            {count('Orders matched', matched.orders)}
            {count('Tracked as exceptions', matched.tracked)}
            {count('Memberships matched', matched.memberships)}
            {count('Enrollments matched', matched.enrollments)}
            {count('Manually recorded payments', manual.length)}
            {count('Scholarships', scholarships.length)}
            {count('Comped', comped.length)}
            {preMirrorCount > 0 && count('Pre-mirror (before mirror history)', preMirrorCount)}
          </Group>

          {unclaimedPaid.length > 0 && (
            <>
              <Title order={5} mt="md" c="red">Paid orders with no activation</Title>
              <Table striped withTableBorder mt="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Order</Table.Th><Table.Th>Email</Table.Th><Table.Th>Total</Table.Th><Table.Th>Expected</Table.Th><Table.Th>Codes</Table.Th><Table.Th>Action</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {unclaimedPaid.map((o, i) => (
                    <Table.Tr key={o.orderLegacyId ?? `row-${i}`}>
                      <Table.Td>{o.name ?? o.orderLegacyId}</Table.Td>
                      <Table.Td>{o.customerEmail}</Table.Td>
                      <Table.Td>{formatCents(o.totalCents)}</Table.Td>
                      <Table.Td>{o.expected.join(', ')}</Table.Td>
                      <Table.Td>{(o.discountCodes ?? []).join(', ')}</Table.Td>
                      <Table.Td>
                        <Button size="xs" variant="light"
                          loading={tracking.has(o.orderLegacyId ?? '')}
                          disabled={!o.orderLegacyId || tracking.has(o.orderLegacyId ?? '')}
                          onClick={() => track(o.orderLegacyId!, { kind: 'order', shopifyOrderId: o.orderLegacyId! })}>
                          Track
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}

          {unclaimedUnpaid.length > 0 && (
            <>
              <Title order={5} mt="md">Unpaid orders with a membership/program item</Title>
              <Text size="xs" c="dimmed" mb="xs">
                Orders carrying a known variant that aren&apos;t currently paid — refunded, cancelled, voided,
                or authorized-but-not-captured — and that no activation claims. Informational: most are money
                returned with no access granted, but an <b>authorized</b>/<b>pending</b> one is a purchase that
                never captured. Not trackable until it settles.
              </Text>
              <Table striped withTableBorder mt="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Order</Table.Th><Table.Th>Email</Table.Th><Table.Th>Status</Table.Th><Table.Th>Total</Table.Th><Table.Th>Expected</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {unclaimedUnpaid.map((o, i) => (
                    <Table.Tr key={o.orderLegacyId ?? `uu-${i}`}>
                      <Table.Td>{o.name ?? o.orderLegacyId}</Table.Td>
                      <Table.Td>{o.customerEmail}</Table.Td>
                      <Table.Td>{o.financialStatus ?? '—'}</Table.Td>
                      <Table.Td>{formatCents(o.totalCents)}</Table.Td>
                      <Table.Td>{o.expected.join(', ')}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}

          {(membershipGaps.length > 0 || enrollmentGaps.length > 0) && (
            <>
              <Title order={5} mt="md" c="red">Activations without a payment basis</Title>
              <Table striped withTableBorder mt="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>What</Table.Th><Table.Th>Who</Table.Th><Table.Th>Problem</Table.Th><Table.Th>Action</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {membershipGaps.map((m) => (
                    <Table.Tr key={m.processId != null ? `m-${m.processId}` : `mm-${m.membershipId}`}>
                      <Table.Td>{m.processId != null ? `Membership process ${m.processId}` : `Membership — ${m.householdName ?? m.membershipId}`}</Table.Td>
                      <Table.Td>{m.householdName}</Table.Td>
                      <Table.Td>{
                        m.bucket === 'NO_PAYMENT_BASIS' ? 'No order and no manually recorded payment'
                        : m.bucket === 'NO_PROCESS' ? 'Active membership with no INITIAL/RENEWAL process'
                        : `Order ${m.shopifyOrderId} not in the mirror`
                      }</Table.Td>
                      <Table.Td>
                        {/* NO_PROCESS rows have no processId — no entity to key a PaymentException
                            on, so no Track button (see matchAudit.ts). */}
                        {m.processId != null && (
                          <Button size="xs" variant="light"
                            loading={tracking.has(`m-${m.processId}`)}
                            disabled={tracking.has(`m-${m.processId}`)}
                            onClick={() => track(`m-${m.processId}`, { kind: 'membership', processId: m.processId! })}>
                            Track
                          </Button>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                  {enrollmentGaps.map((e) => (
                    <Table.Tr key={`e-${e.programId}-${e.personId}`}>
                      <Table.Td>{e.programName}</Table.Td>
                      <Table.Td>{e.personName}</Table.Td>
                      <Table.Td>{e.bucket === 'NO_PAYMENT_BASIS' ? 'No order and no scholarship approval' : `Order ${e.shopifyOrderId} not in the mirror`}</Table.Td>
                      <Table.Td>
                        <Button size="xs" variant="light"
                          loading={tracking.has(`e-${e.programId}-${e.personId}`)}
                          disabled={tracking.has(`e-${e.programId}-${e.personId}`)}
                          onClick={() => track(`e-${e.programId}-${e.personId}`, { kind: 'enrollment', programId: e.programId, personId: e.personId })}>
                          Track
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}

          {(manual.length > 0 || scholarships.length > 0 || comped.length > 0) && (
            <>
              <Title order={5} mt="md">Manual — legitimate, listed for audit</Title>
              <Table striped withTableBorder mt="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>What</Table.Th><Table.Th>Who</Table.Th><Table.Th>Basis</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {manual.map((m) => (
                    <Table.Tr key={`man-${m.processId}`}>
                      <Table.Td>Membership process {m.processId}</Table.Td>
                      <Table.Td>{m.householdName}</Table.Td>
                      <Table.Td>Payment recorded manually by {m.manualPaymentByName}</Table.Td>
                    </Table.Tr>
                  ))}
                  {scholarships.map((e) => (
                    <Table.Tr key={`sch-${e.programId}-${e.personId}`}>
                      <Table.Td>{e.programName}</Table.Td>
                      <Table.Td>{e.personName}</Table.Td>
                      <Table.Td>Scholarship / payment plan approved</Table.Td>
                    </Table.Tr>
                  ))}
                  {comped.map((e) => (
                    <Table.Tr key={`comp-${e.programId}-${e.personId}`}>
                      <Table.Td>{e.programName}</Table.Td>
                      <Table.Td>{e.personName}</Table.Td>
                      <Table.Td>Comped by {e.compedByName}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}

          {(reversedMemberships.length > 0 || reversedEnrollments.length > 0) && (
            <>
              <Title order={5} mt="md" c="yellow">Reversed after activation — already in the exceptions queue</Title>
              <Table striped withTableBorder mt="xs">
                <Table.Thead><Table.Tr><Table.Th>What</Table.Th><Table.Th>Who</Table.Th><Table.Th>Order</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {reversedMemberships.map((m) => (
                    <Table.Tr key={`rm-${m.processId}`}>
                      <Table.Td>Membership process {m.processId}</Table.Td><Table.Td>{m.householdName}</Table.Td><Table.Td>{m.shopifyOrderId}</Table.Td>
                    </Table.Tr>
                  ))}
                  {reversedEnrollments.map((e) => (
                    <Table.Tr key={`re-${e.programId}-${e.personId}`}>
                      <Table.Td>{e.programName}</Table.Td><Table.Td>{e.personName}</Table.Td><Table.Td>{e.shopifyOrderId}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}
        </>
      )}
    </Card>
  );
}
