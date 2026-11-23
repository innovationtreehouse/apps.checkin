"use client";

import { LoadError } from '@checkin/component-ui';
import { Alert, Badge, Button, Card, Group, Paper, SimpleGrid, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core';
import EmergencyContactNotice from '@/components/ui/EmergencyContactNotice';
import { formatPhone } from '@/lib/phone';
import type { EmergencyContact } from './household';
import type { EmergencyContactForm } from './useEmergencyContactForm';

export default function EmergencyContactsCard({ contacts, loaded, loadError, onRetry, form }: {
  contacts: EmergencyContact[];
  loaded: boolean;
  loadError: string | null | undefined;
  onRetry: () => void;
  form: EmergencyContactForm;
}) {
  const { values, setValues, open, saving, errors, setErrors } = form;
  return (
    <Card withBorder radius="md" padding="lg" id="emergency-contact" style={{ scrollMarginTop: 80 }}>
      <Group justify="space-between" align="center" mb="xs">
        <Title order={3} c="yellow">Emergency Contacts</Title>
        {!open && <Button size="compact-xs" variant="light" onClick={form.startAdd}>+ Add Contact</Button>}
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        At least one is required.
      </Text>
      <EmergencyContactNotice mb="sm" />


      {loadError && <LoadError what="emergency contacts" message={loadError} onRetry={onRetry} />}

      {loaded && contacts.length === 0 && !open && (
        <Alert color="red" variant="light">No emergency contact on file. Add at least one.</Alert>
      )}

      <Stack gap="xs">
        {contacts.map((c) => {
          // Can't remove the only valid contact — a household must keep at least one.
          const validCount = contacts.filter((x) => !x.invalid).length;
          const isLastValid = !c.invalid && validCount <= 1;
          return (
          <Paper key={c.id} withBorder radius="sm" p="sm" bg={c.invalid ? 'var(--mantine-color-red-light)' : undefined}>
            <Group justify="space-between" wrap="nowrap">
              <div>
                <Group gap="xs">
                  <Text fw={600}>{c.name || "Unnamed"}</Text>
                  {c.relationship && <Badge variant="light" color="gray">{c.relationship}</Badge>}
                  {c.invalid && <Badge variant="light" color="red">Invalid — is a household member</Badge>}
                </Group>
                <Text size="sm" c="dimmed">{formatPhone(c.phone)}{c.email ? ` • ${c.email}` : ''}</Text>
              </div>
              <Group gap="xs" wrap="nowrap">
                <Button size="compact-xs" variant="subtle" color="gray" onClick={() => form.startEdit(c)}>Edit</Button>
                <Tooltip label="Can't remove last emergency contact. Add a new one first." disabled={!isLastValid}>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    data-disabled={isLastValid || undefined}
                    onClick={(e) => {
                      if (isLastValid) {
                        e.preventDefault();
                        return;
                      }
                      form.remove(c.id);
                    }}
                  >Remove</Button>
                </Tooltip>
              </Group>
            </Group>
          </Paper>
          );
        })}
      </Stack>

      {open && (
        <form onSubmit={form.save}>
          <Stack gap="xs" mt="sm">
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="Contact Name" value={values.name} error={errors.name} onChange={(e) => { setValues({ ...values, name: e.currentTarget.value }); setErrors({ ...errors, name: undefined }); }} placeholder="Full Name" />
              <TextInput type="tel" label="Phone" value={values.phone} error={errors.phone} onChange={(e) => { setValues({ ...values, phone: e.currentTarget.value }); setErrors({ ...errors, phone: undefined }); }} placeholder="(555) 555-5555" />
              <TextInput inputMode="email" label="Email (optional)" value={values.email} error={errors.email} onChange={(e) => { setValues({ ...values, email: e.currentTarget.value }); setErrors({ ...errors, email: undefined }); }} />
              <TextInput label="Relationship (optional)" value={values.relationship} onChange={(e) => setValues({ ...values, relationship: e.currentTarget.value })} placeholder="Aunt, Neighbor…" />
            </SimpleGrid>
            <Group gap="xs">
              <Button type="submit" size="xs" fz={15} loading={saving}>{values.id !== null ? "Save Contact" : "Add Contact"}</Button>
              <Button type="button" size="xs" fz={15} variant="default" onClick={form.cancel}>Cancel</Button>
            </Group>
          </Stack>
        </form>
      )}
    </Card>
  );
}
