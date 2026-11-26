import type { Dispatch, SetStateAction } from "react";
import { Alert, Box, Card, Group, Radio, Stack, Title } from "@mantine/core";
import { FIELD_LABELS, formatFieldValue, identityOptionLabel, type ConflictField, type ParticipantMergeView } from "./mergeView";

export function ConflictResolver({ keepParticipant, mergeParticipant, conflicts, identityConflict, fieldChoices, setFieldChoices }: {
  keepParticipant: ParticipantMergeView;
  mergeParticipant: ParticipantMergeView;
  conflicts: ConflictField[];
  identityConflict: boolean;
  fieldChoices: Record<string, "keep" | "merge">;
  setFieldChoices: Dispatch<SetStateAction<Record<string, "keep" | "merge">>>;
}) {
  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={5} mb="sm">Resolve conflicting fields</Title>
      <Stack gap="md">
        {identityConflict && (
          <Radio.Group
            label="Login identity"
            description="Email, Google sign-in, and verified status move together as one unit — picking a side replaces the kept record's whole login, so choosing an email-only side drops the other's Google sign-in."
            value={fieldChoices.identity ?? "keep"}
            onChange={(v) => setFieldChoices((prev) => ({ ...prev, identity: v as "keep" | "merge" }))}
          >
            <Stack mt="xs" gap="xs">
              <Radio value="keep" label={identityOptionLabel(keepParticipant)} />
              <Radio value="merge" label={identityOptionLabel(mergeParticipant)} />
            </Stack>
          </Radio.Group>
        )}
        {conflicts.map((field) => {
          const radioGroup = (
            <Radio.Group
              label={FIELD_LABELS[field]}
              value={fieldChoices[field] ?? "keep"}
              onChange={(v) => setFieldChoices((prev) => ({ ...prev, [field]: v as "keep" | "merge" }))}
            >
              <Group mt="xs">
                <Radio value="keep" label={formatFieldValue(field, keepParticipant[field])} />
                <Radio value="merge" label={formatFieldValue(field, mergeParticipant[field])} />
              </Group>
            </Radio.Group>
          );

          // DOB conflicts get warning treatment, not a plain radio: differing
          // birth dates are a much stronger "these might not be the same
          // person" signal than a differing email or phone.
          if (field === "dateOfBirth") {
            return (
              <Alert key={field} color="yellow" variant="light" title="Birth date conflict">
                Different birth dates may mean these are NOT the same person — verify before merging.
                <Box mt="xs">{radioGroup}</Box>
              </Alert>
            );
          }

          return <Box key={field}>{radioGroup}</Box>;
        })}
      </Stack>
    </Card>
  );
}
