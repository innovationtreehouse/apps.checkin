"use client";

import { useRef, useState } from "react";
import { Button, Group, Select, Stack, Text } from "@mantine/core";
import type { Person } from "./applicationRows";

// The body of the mark-check-started dialog: confirming with no lead picked flags the Lead field.
export function LeadPickConfirm({ leads, onCancel, onConfirm }: {
  leads: Person[];
  onCancel: () => void;
  onConfirm: (personId: number) => void;
}) {
  const [personId, setPersonId] = useState<string | null>(leads.length === 1 ? String(leads[0].id) : null);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const confirm = () => {
    if (personId === null) {
      setError("Pick a lead.");
      field.current?.focus();
      return;
    }
    onConfirm(Number(personId));
  };
  return (
    <Stack gap="xs">
      <Text size="sm">Pick the lead whose check was started in the background-check tool. Their review goes to the reviewers.</Text>
      <Select
        ref={field}
        label="Lead"
        required
        data={leads.map((p) => ({ value: String(p.id), label: p.name || p.email || `Person #${p.id}` }))}
        value={personId}
        error={error}
        onChange={(v) => { setPersonId(v); setError(null); }}
      />
      <Group justify="flex-end" mt="sm">
        <Button variant="default" onClick={onCancel}>Cancel</Button>
        <Button onClick={confirm}>Mark check started</Button>
      </Group>
    </Stack>
  );
}
