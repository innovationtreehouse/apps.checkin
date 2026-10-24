"use client";

import { Button, Card, Center, Checkbox, Group, Loader, Modal, Radio, Stack, Text, Title } from '@mantine/core';
import { SCHOLARSHIP_REQUEST_KIND_OPTIONS } from '@/lib/scholarshipRequestKind';
import FirstTimeIntakePanel from './FirstTimeIntakePanel';
import type { EnrollmentPickerControls } from './useProgramEnrollment';

/** The household picker: who to enroll, checkout, the scholarship request and first-time setup. */
export default function EnrollmentPicker({ ageGated, ageRange, hasPrice, isClosed, viewerIsYouth, controls }: {
  ageGated: boolean;
  ageRange: string | null;
  hasPrice: boolean;
  isClosed: boolean;
  viewerIsYouth: boolean;
  controls: EnrollmentPickerControls;
}) {
  const {
    showIntake, setShowIntake, handleIntakeSaved, loadingHousehold, householdMembers, enrollBlock, needsSetup,
    selectedParticipantIds, setSelectedParticipantIds, enrolling, handleEnroll, repeatPayments, setRepeatPayments,
    planKind, setPlanKind, confirmPlanOpened, openConfirmPlan, closeConfirmPlan, handleRequestPaymentPlan,
  } = controls;

  return (
    <Card withBorder radius="md" padding="lg" w="100%" maw={showIntake ? 640 : 500}>
      {showIntake ? (
        <FirstTimeIntakePanel
          ageGated={ageGated}
          onSaved={handleIntakeSaved}
        />
      ) : (
      <>
      <Title order={4} mb="lg">Which of your household wants to enroll?</Title>

      {loadingHousehold ? (
        <Center py="md"><Loader size="sm" /></Center>
      ) : (
        <Checkbox.Group
          value={selectedParticipantIds.map(String)}
          onChange={(vals) => setSelectedParticipantIds(vals.map(Number))}
          mb="lg"
        >
          <Stack>
            {householdMembers.map((member) => {
              const { reason, label } = enrollBlock(member);
              const disabled = reason !== null && reason !== 'pending';

              return (
                <Card key={member.id} withBorder radius="md" padding="sm" opacity={disabled ? 0.5 : 1}>
                  <Group justify="space-between">
                    <Checkbox
                      value={String(member.id)}
                      disabled={disabled}
                      label={member.name || 'Unnamed Participant'}
                    />
                    {reason === 'enrolled' && <Text size="sm" c="green">({label})</Text>}
                    {reason === 'pending' && <Text size="sm" c="yellow">({label})</Text>}
                    {disabled && reason !== 'enrolled' && <Text size="sm" c="red">({label})</Text>}
                  </Group>
                </Card>
              );
            })}
          </Stack>
        </Checkbox.Group>
      )}

      {!loadingHousehold && needsSetup ? (
        // Replaces the old dead-end "no eligible participants" alert: a
        // first-time user finishes their household here, then enrolls.
        <Stack align="center" gap="sm">
          <Text c="dimmed" size="sm" ta="center">
            Finish setting up your household to enroll{ageRange ? ` (${ageRange})` : ''}.
          </Text>
          <Button fullWidth size="md" onClick={() => setShowIntake(true)}>
            Finish setting up your household to enroll
          </Button>
        </Stack>
      ) : (
      <Stack align="center">
        {selectedParticipantIds.length === 0 && (
          <Text size="sm" c="dimmed" ta="center">
            Check the box next to each person you want to enroll.
          </Text>
        )}

        <Button
          fullWidth
          size="md"
          onClick={() => handleEnroll()}
          disabled={enrolling || selectedParticipantIds.length === 0 || loadingHousehold}
          loading={enrolling}
        >
          {hasPrice ? "Pay on Shopify" : "Complete Enrollment"}
        </Button>

        {hasPrice && !isClosed && !viewerIsYouth && (
          <Button
            fullWidth
            size="md"
            variant="light"
            type="button"
            onClick={openConfirmPlan}
            disabled={enrolling || selectedParticipantIds.length === 0 || loadingHousehold}
            styles={{ root: { height: 'auto', paddingBlock: 'var(--mantine-spacing-xs)' }, label: { whiteSpace: 'normal' } }}
          >
            Request a scholarship or payment plan from the Scholarship Review Team
          </Button>
        )}

        <Modal opened={repeatPayments.length > 0} onClose={() => setRepeatPayments([])} title="Pay again?" centered>
          <Stack gap="xs">
            {repeatPayments.map((r) => (
              <Text key={r.personId} size="sm">{r.name} is already paid.</Text>
            ))}
            <Text size="sm">Pay again anyway?</Text>
          </Stack>
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={() => setRepeatPayments([])}>Cancel</Button>
            <Button color="yellow" onClick={() => { setRepeatPayments([]); handleEnroll(true); }}>
              Pay again anyway
            </Button>
          </Group>
        </Modal>

        <Modal opened={confirmPlanOpened} onClose={closeConfirmPlan} title="Request a scholarship or payment plan?" centered>
          <Text size="sm">
            This enrolls the people you selected as pending and sends your request to the
            board&apos;s Scholarship Review Team, who will follow up with you. You won&apos;t be
            charged anything now, and the spot is held while they review.
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
            <Button onClick={handleRequestPaymentPlan} disabled={!planKind || enrolling} loading={enrolling}>
              Send request
            </Button>
          </Group>
        </Modal>
      </Stack>
      )}

      {/* No force-enroll here: this picker only ever offers the caller's
          own household, so every enrollment from this page is conflicted
          and the server refuses the limit override. The refusal reason
          shows in the red message Alert above. Comping someone else is
          program-ops (ProgramRosterTab). */}
      </>
      )}
    </Card>
  );
}
