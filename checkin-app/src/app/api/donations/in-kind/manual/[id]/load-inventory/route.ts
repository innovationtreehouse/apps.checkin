// Re-export stub: mounts a bulk-donation route factory under /api/donations/*
// through checkin's handler(). The endpoint string MUST match its
// src/security/registry/donation.ts entry.
import { handler } from "@/security/handler";
import { donationRoute } from "@/lib/bulkDonation/route";
import { routes } from "@checkin/bulk-donation";

export const POST = handler("POST /api/donations/in-kind/manual/[id]/load-inventory", donationRoute(routes.inKind.loadInventory));
