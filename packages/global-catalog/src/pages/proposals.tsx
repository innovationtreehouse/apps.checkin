"use client";
import { Badge, Tabs, Title } from "@mantine/core";
import ItemReferenceProposalsClient from "../components/ItemReferenceProposalsClient";
import ProvisionalProposalsClient from "../components/ProvisionalProposalsClient";

/** A queue tab's count pill, in the host CountBadge's action look; nothing at zero. */
function PendingCount({ count }: { count: number }) {
  if (count === 0) return null;
  return <Badge size="sm" variant="filled" color="treehouseGreen" c="black" aria-label={`${count} to review`}>{count}</Badge>;
}

/**
 * /catalog/proposals — the two organization-submitted proposal queues combined
 * under tabs (design §7 collapses the source's separate proposal sub-pages into
 * one nav entry). Conversion challenges keep their own screen.
 */
export default function ProposalsPage({ pendingItemReferences = 0, pendingProvisionalItems = 0 }: {
  pendingItemReferences?: number;
  pendingProvisionalItems?: number;
}) {
  return (
    <>
      <Title order={3} mb="md">Proposals</Title>
      <Tabs defaultValue="item-references">
        <Tabs.List mb="md">
          <Tabs.Tab value="item-references" rightSection={<PendingCount count={pendingItemReferences} />}>Item References</Tabs.Tab>
          <Tabs.Tab value="provisional" rightSection={<PendingCount count={pendingProvisionalItems} />}>Provisional Items</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="item-references"><ItemReferenceProposalsClient /></Tabs.Panel>
        <Tabs.Panel value="provisional"><ProvisionalProposalsClient /></Tabs.Panel>
      </Tabs>
    </>
  );
}
