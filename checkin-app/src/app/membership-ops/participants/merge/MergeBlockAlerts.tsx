import { Alert, List } from "@mantine/core";
import type { Collision } from "./mergeView";

export function MergeBlockAlerts({ membershipBlockReason, swapClearsMembershipBlock, collisions }: {
  membershipBlockReason: string | null;
  swapClearsMembershipBlock: boolean;
  collisions: Collision[];
}) {
  return (
    <>
      {membershipBlockReason && (
        <Alert color="red" variant="light" fw={700} title="Household membership blocks this merge">
          {membershipBlockReason}
          {swapClearsMembershipBlock && " Swapping which record is kept clears this."}
        </Alert>
      )}

      {collisions.length > 0 && (
        <Alert color="red" variant="light" title="These records collide">
          <List size="sm">
            {collisions.map((c, i) => (
              <List.Item key={i}>
                {c.message}
                {c.attestationIds && c.attestationIds.length > 0 && ` Attestation IDs: ${c.attestationIds.join(", ")}.`}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}
    </>
  );
}
