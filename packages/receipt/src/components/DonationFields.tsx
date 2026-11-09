"use client";
import { Checkbox, Group, SegmentedControl, TextInput } from "@mantine/core";
import { DONOR_COMPANY_MAX, DONOR_NAME_MAX } from "@checkin/receipt-types";
import { DonorInputSchema, type DonorInput } from "../lib/schemas";

export interface Donation {
  isInKind: boolean;
  selfDonor: boolean;
  donor: { firstName: string; lastName: string; companyName: string };
}

export const NO_DONATION: Donation = { isInKind: false, selfDonor: true, donor: { firstName: "", lastName: "", companyName: "" } };

/** The donor as the service reads it, or null when the service would refuse the typed name. */
export function donorInput(d: Donation): DonorInput | null {
  const parsed = DonorInputSchema.safeParse(d.selfDonor ? { self: true } : { ...d.donor, companyName: d.donor.companyName.trim() || null });
  return parsed.success ? parsed.data : null;
}

/** "This is a donation" and its donor. `disabledHint` turns the toggle off and says why. */
export default function DonationFields({ value, onChange, disabledHint }: { value: Donation; onChange: (next: Donation) => void; disabledHint?: string }) {
  const setDonor = (patch: Partial<Donation["donor"]>) => onChange({ ...value, donor: { ...value.donor, ...patch } });
  return (
    <>
      <Checkbox
        label="This is a donation"
        description={disabledHint}
        disabled={disabledHint !== undefined}
        checked={value.isInKind}
        onChange={(e) => onChange({ ...value, isInKind: e.currentTarget.checked })}
      />
      {value.isInKind && (
        <>
          <SegmentedControl
            value={value.selfDonor ? "self" : "other"}
            onChange={(v) => onChange({ ...value, selfDonor: v === "self" })}
            data={[{ value: "self", label: "I am the donor" }, { value: "other", label: "Someone else donated" }]}
          />
          {!value.selfDonor && (
            <Group grow>
              <TextInput label="Donor first name" value={value.donor.firstName} onChange={(e) => setDonor({ firstName: e.currentTarget.value })} maxLength={DONOR_NAME_MAX} required />
              <TextInput label="Donor last name" value={value.donor.lastName} onChange={(e) => setDonor({ lastName: e.currentTarget.value })} maxLength={DONOR_NAME_MAX} required />
              <TextInput label="Company (optional)" value={value.donor.companyName} onChange={(e) => setDonor({ companyName: e.currentTarget.value })} maxLength={DONOR_COMPANY_MAX} />
            </Group>
          )}
        </>
      )}
    </>
  );
}
