"use client";

import { useState } from "react";
import { Button, Group, Modal, Select, Text } from "@mantine/core";
import { grantableYears } from "@/lib/programYear";
import { useMembershipYearBoundary, YearBoundaryError } from "@/app/program-ops/ProgramYearField";

/**
 * The Board names the membership year an individual agreement it opens is for. No year is
 * preselected, and Open stays disabled until one is picked.
 */
export function AgreementYearModal({ opened, onClose, onConfirm }: {
  opened: boolean;
  onClose: () => void;
  onConfirm: (year: number) => void;
}) {
  const load = useMembershipYearBoundary(opened);
  const [year, setYear] = useState<number | null>(null);
  const close = () => { setYear(null); onClose(); };
  const confirm = () => {
    if (year === null) return;
    setYear(null);
    onConfirm(year);
  };
  return (
    <Modal opened={opened} onClose={close} title={<Text span fw={700} fz="lg">Open individual agreement</Text>} centered>
      <YearBoundaryError load={load} />
      <Select
        label="Membership year this agreement is for"
        placeholder="Choose a year"
        data={grantableYears(load.boundary, new Date()).map((y) => ({ value: String(y.year), label: y.label }))}
        value={year === null ? null : String(year)}
        onChange={(v) => setYear(v === null ? null : Number(v))}
        mb="lg"
        required
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={close}>Cancel</Button>
        <Button onClick={confirm} disabled={year === null}>Open agreement</Button>
      </Group>
    </Modal>
  );
}
