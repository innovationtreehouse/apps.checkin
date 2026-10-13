import { notFound } from "next/navigation";
import { config } from "@/lib/config";
import BulkImportParticipants from "./ImportParticipantsClient";

export const dynamic = "force-dynamic";

// Optional CSV import module: 404s unless CSV_IMPORT_ENABLED=true.
export default function BulkImportPage() {
    if (!config.csvImportEnabled()) notFound();
    return <BulkImportParticipants />;
}
