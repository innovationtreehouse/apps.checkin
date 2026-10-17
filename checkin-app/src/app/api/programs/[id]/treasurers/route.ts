import { handler, badRequest } from "@/security/handler";
import { listProgramTreasurers } from "@/lib/finance/budgetOwners";

export const dynamic = "force-dynamic";

export const GET = handler<{ id: string }>("GET /api/programs/[id]/treasurers", async ({ params }) => {
    const programId = Number(params.id);
    if (!Number.isInteger(programId)) throw badRequest("Invalid program id");
    return { ProgramVolunteer: await listProgramTreasurers(programId) };
});
