"use client";
import GlobalInventoryClient from "../components/GlobalInventoryClient";

/** /catalog/items — the global catalog (items, learned references, conflicts). */
export default function ItemsPage({ unresolvedConflicts = 0 }: { unresolvedConflicts?: number }) {
  return <GlobalInventoryClient unresolvedConflicts={unresolvedConflicts} />;
}
