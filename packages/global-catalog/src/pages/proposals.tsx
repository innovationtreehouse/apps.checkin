"use client";
import { Tabs, Title } from "@mantine/core";
import ItemReferenceProposalsClient from "../components/ItemReferenceProposalsClient";
import ProvisionalProposalsClient from "../components/ProvisionalProposalsClient";

/**
 * /catalog/proposals — the two organization-submitted proposal queues combined
 * under tabs (design §7 collapses the source's separate proposal sub-pages into
 * one nav entry). Conversion challenges keep their own screen.
 */
export default function ProposalsPage() {
  return (
    <>
      <Title order={3} mb="md">Proposals</Title>
      <Tabs defaultValue="item-references">
        <Tabs.List mb="md">
          <Tabs.Tab value="item-references">Item References</Tabs.Tab>
          <Tabs.Tab value="provisional">Provisional Items</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="item-references"><ItemReferenceProposalsClient /></Tabs.Panel>
        <Tabs.Panel value="provisional"><ProvisionalProposalsClient /></Tabs.Panel>
      </Tabs>
    </>
  );
}
