"use client";

import { Alert, Anchor, Button, Card, Group, Modal, Radio, Stack, Text, Title } from "@mantine/core";
import DevMockPaymentButton from "@/components/dev/DevMockPaymentButton";
import { useIsLocalInstance } from "@/components/EnvProvider";
import { SCHOLARSHIP_REQUEST_KIND_OPTIONS } from "@/lib/scholarshipRequestKind";
import type { PaymentControls } from "./useMembershipPage";

/** The PENDING_PAYMENT step: membership fee, Shopify checkout and the scholarship/payment-plan request. */
export default function PaymentPanel({ processId, bgCleared, saving, setSaving, controls }: {
  processId: number;
  bgCleared: boolean;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  controls: PaymentControls;
}) {
  const isLocalInstance = useIsLocalInstance();
  const {
    payment, awaitingPayment, clearAwaitingPayment, handlePayClick, onMockPaid, onMockFailed,
    planRequested, planKind, setPlanKind, confirmPlanOpened, openConfirmPlan, closeConfirmPlan, requestPaymentPlan,
  } = controls;

  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={2} mb="sm">Membership fee</Title>
      {payment ? (
        <>
          <Text c="dimmed">
            Your annual household membership fee is <strong>${(payment.amountCents / 100).toFixed(2)}</strong>.
          </Text>
          {awaitingPayment ? (
            <Stack gap="xs" mt="md" align="flex-start">
              <Text>
                We&apos;ll update your status here when we receive your payment — refresh
                this page after you finish checkout.
              </Text>
              <Anchor component="button" type="button" size="sm" c="dimmed" onClick={clearAwaitingPayment}>
                Show the payment button again
              </Anchor>
            </Stack>
          ) : payment.checkoutUrl ? (
            <Button component="a" href={payment.checkoutUrl} target="_blank" rel="noopener noreferrer" mt="md" onClick={handlePayClick}>
              Pay here with Shopify →
            </Button>
          ) : isLocalInstance ? (
            <DevMockPaymentButton processId={processId} saving={saving} setSaving={setSaving} onPaid={onMockPaid} onFailed={onMockFailed} />
          ) : (
            <Text c="yellow" mt="md">The payment link isn&apos;t available yet. Please check back shortly.</Text>
          )}
          <Modal opened={confirmPlanOpened} onClose={closeConfirmPlan} title="Request a scholarship or payment plan?" centered>
            <Text size="sm">
              This sends your request to the board&apos;s Scholarship Review Team, who will review
              your household&apos;s membership fee and follow up with you. You won&apos;t be charged
              anything now, and you can still pay online at any time.
            </Text>
            <Radio.Group
              mt="md"
              value={planKind}
              onChange={setPlanKind}
              label="What would help?"
              description="So the team opens the right conversation. Nothing here commits you to anything."
            >
              <Stack gap="xs" mt="xs">
                {SCHOLARSHIP_REQUEST_KIND_OPTIONS.map((o) => (
                  <Radio key={o.value} value={o.value} label={o.label} description={o.description} />
                ))}
              </Stack>
            </Radio.Group>
            <Group justify="flex-end" mt="md">
              <Button variant="default" onClick={closeConfirmPlan}>Cancel</Button>
              <Button onClick={requestPaymentPlan} disabled={!planKind}>Send request</Button>
            </Group>
          </Modal>
          {planRequested ? (
            <Text c="green" mt="md">Scholarship or payment plan requested — the Scholarship Review Team will follow up.</Text>
          ) : (
            <Button
              variant="light"
              type="button"
              mt="md"
              onClick={openConfirmPlan}
              styles={{ root: { height: 'auto', paddingBlock: 'var(--mantine-spacing-xs)' }, label: { whiteSpace: 'normal' } }}
            >
              Request a scholarship or payment plan from the Scholarship Review Team
            </Button>
          )}
          {!bgCleared && (
            <Alert color="blue" variant="light" mt="md">
              Your background check is being reviewed in the background — you can pay now.
              Your membership activates as soon as both the payment and the check are done.
            </Alert>
          )}
          <Text size="sm" c="dimmed" mt="md">
            For any questions, please email{" "}
            <Anchor href="mailto:finance@innovationtreehouse.org">finance@innovationtreehouse.org</Anchor>.
          </Text>
        </>
      ) : (
        <Text c="dimmed">Preparing your invoice…</Text>
      )}
    </Card>
  );
}
