import { Alert, Button, Card, Group, List, Text, TextInput, Title } from "@mantine/core";
import { formatDateOnly } from "@/lib/time";
import type { BgNotice, ParticipantMergeView } from "./mergeView";

export function MergePreview({ mergeParticipant, keepParticipant, bgNotice, emailChangeReason, setEmailChangeReason, merging, onCancel, onConfirm }: {
  mergeParticipant: ParticipantMergeView;
  keepParticipant: ParticipantMergeView;
  bgNotice: BgNotice | null;
  emailChangeReason: string;
  setEmailChangeReason: (v: string) => void;
  merging: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Card withBorder radius="md" padding="lg" style={{ borderColor: "var(--mantine-color-yellow-6)" }}>
      <Title order={2} c="yellow.7">Preview &amp; Confirm Merge</Title>
      <Text my="sm"><strong>This action is extremely difficult to undo.</strong> Please review the changes below.</Text>

      <List spacing="xs" my="lg">
        <List.Item><strong>{mergeParticipant.name || mergeParticipant.email || `ID ${mergeParticipant.id}`}</strong> will be deleted, and an archive of the record will name the kept participant.</List.Item>
        <List.Item>All visits, program enrollments, RSVPs, and fee payments will be transferred to <strong>{keepParticipant.name || keepParticipant.email || `ID ${keepParticipant.id}`}</strong>.</List.Item>
        <List.Item>Missing personal info on the kept participant will be filled in from the merged participant.</List.Item>
        <List.Item>Raw badge scans will move to the kept participant.</List.Item>
      </List>

      {bgNotice && (
        <Alert color="yellow" variant="light" mb="md" title="Background-check date will change">
          <strong>{keepParticipant.name || keepParticipant.email || `ID ${keepParticipant.id}`}</strong> will
          end up with the background-check date {formatDateOnly(bgNotice.date)}, carried over
          from <strong>{mergeParticipant.name || mergeParticipant.email || `ID ${mergeParticipant.id}`}</strong>.
        </Alert>
      )}

      <TextInput
        mb="md"
        label="Reason for the sign-in email change"
        description="A board member must give one when either person holds a position of trust."
        value={emailChangeReason}
        onChange={(e) => setEmailChangeReason(e.currentTarget.value)}
      />

      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel} disabled={merging}>Cancel</Button>
        <Button color="red" onClick={onConfirm} disabled={merging} loading={merging}>Confirm Merge &amp; Delete</Button>
      </Group>
    </Card>
  );
}
