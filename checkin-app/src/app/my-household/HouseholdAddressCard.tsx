"use client";

import { Button, Card, Group, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import type { AddressField, StructuredAddress } from '@/lib/address';

type AddressErrors = Partial<Record<AddressField, string>>;

export default function HouseholdAddressCard({ address, onAddressChange, errors, onErrorsChange, saving, onSave }: {
  address: StructuredAddress;
  onAddressChange: (address: StructuredAddress) => void;
  errors: AddressErrors;
  onErrorsChange: (errors: AddressErrors) => void;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" align="center" mb="md">
        <Title order={3} c="blue">Household Address</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">The main address associated with this household.</Text>
      <Stack gap="xs">
        <TextInput label="Street Address" required value={address.line1 ?? ""} error={errors.line1} onChange={(e) => { onAddressChange({ ...address, line1: e.currentTarget.value }); onErrorsChange({ ...errors, line1: undefined }); }} placeholder="123 Main St" />
        <TextInput label="Apt / Suite (optional)" value={address.line2 ?? ""} onChange={(e) => onAddressChange({ ...address, line2: e.currentTarget.value })} placeholder="Apt 4B" />
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput label="City" required value={address.city ?? ""} error={errors.city} onChange={(e) => { onAddressChange({ ...address, city: e.currentTarget.value }); onErrorsChange({ ...errors, city: undefined }); }} />
          <TextInput label="State" required maxLength={2} value={address.state ?? ""} error={errors.state} onChange={(e) => { onAddressChange({ ...address, state: e.currentTarget.value }); onErrorsChange({ ...errors, state: undefined }); }} placeholder="TX" />
          <TextInput label="ZIP" required value={address.postalCode ?? ""} error={errors.postalCode} onChange={(e) => { onAddressChange({ ...address, postalCode: e.currentTarget.value }); onErrorsChange({ ...errors, postalCode: undefined }); }} placeholder="78701" />
        </SimpleGrid>
      </Stack>
      <Button onClick={onSave} disabled={saving} loading={saving} fullWidth mt="md">
        Save household details
      </Button>
    </Card>
  );
}
