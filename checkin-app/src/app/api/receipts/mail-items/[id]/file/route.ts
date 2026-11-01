// Mounts a receipt file factory through checkin's fileHandler(), which fixes the delivery headers
// per type. The endpoint string MUST match its src/security/registry/receipt.ts entry.
import { routes } from "@checkin/receipt";
import { fileHandler } from "@/security/fileHandler";
import { receiptFileRoute } from "@/lib/receipt/route";

export const GET = fileHandler("GET /api/receipts/mail-items/[id]/file", receiptFileRoute(routes.mail.file));
