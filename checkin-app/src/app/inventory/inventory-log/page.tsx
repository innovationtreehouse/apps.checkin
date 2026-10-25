"use client";
// The screen lives in the local-inventory library; the host links its receipts to Part mapping.
import { useSession } from "next-auth/react";
import InventoryLogPage from "@checkin/local-inventory/pages/inventoryLog";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { linkGate } from "@/lib/nav/gates";
import { INVENTORY } from "@/lib/nav/sections/inventory";
import { receivedReceiptIds } from "@/lib/inventory/partMappingLinks";

const canOpenPartMapping = linkGate(INVENTORY, "/inventory/receiving");

export default function InventoryLog() {
  const { data: session, status } = useSession();
  const counts = useTodoCounts(status === "authenticated");
  const linked = canOpenPartMapping(session?.user, counts);
  return <InventoryLogPage receivedReceiptIds={linked ? receivedReceiptIds : undefined} />;
}
