import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { logBackendError } from "@/lib/logger";
import { apiError } from "@/lib/api-response";
import { uniqueViolationFields } from "@/lib/prismaUniqueViolation";
import {
    RoleMatrixError,
    LastBoardMemberError,
    DeniedHouseholdBoardError,
    OwnHouseholdRoleError,
} from "@/lib/roles";
import { AlreadyMergedError, MergeRefusedError, executeMerge, prepareMerge } from "@/lib/person/merge/execute";

export const dynamic = 'force-dynamic';

export const POST = withAuth(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async (req, auth) => {
        try {
            const body = await req.json();
            const { keepId, mergeId, fieldChoices } = body;

            if (!keepId || !mergeId || keepId === mergeId) {
                return apiError("Invalid participant IDs provided.", 400);
            }

            const actor = auth.type === 'session' ? auth.user : null;
            const prepared = await prepareMerge(actor, keepId, mergeId, fieldChoices);
            if ('refused' in prepared) {
                const { status, error, collisions } = prepared.refused;
                return collisions
                    ? NextResponse.json({ error, collisions }, { status })
                    : apiError(error, status);
            }

            await executeMerge(prepared.plan, actor);
            return NextResponse.json({ success: true });
        } catch (error: unknown) {
            if (error instanceof AlreadyMergedError) {
                return apiError("Cannot merge: this participant has already been merged.", 409);
            }
            if (error instanceof MergeRefusedError) {
                return apiError(error.refusal.error, error.refusal.status);
            }
            if (error instanceof OwnHouseholdRoleError) {
                return apiError("You cannot merge a record in your own household — someone outside your household must.", 403);
            }
            if (error instanceof RoleMatrixError) {
                return apiError(`Cannot merge: ${error.message}`, 403);
            }
            if (error instanceof LastBoardMemberError) {
                return apiError("Cannot merge: it would remove the last board member.", 409);
            }
            if (error instanceof DeniedHouseholdBoardError) {
                return apiError("Cannot merge: the kept record's household has been denied membership, so it cannot take the board role.", 409);
            }
            const field = prismaUniqueConflictField(error);
            if (field) {
                const label = field === 'googleId' ? 'the Google identity'
                    : field === 'email' ? 'the email address'
                    : field === 'phone' ? 'the phone number'
                    : `the ${field} field`;
                return apiError(`Merge conflict: ${label} is already attached to another record.`, 409);
            }
            await logBackendError(error, "POST /api/membership-ops/participants/merge");
            return apiError("Failed to merge participants — check server logs for details.", 500);
        }
    }
);

// First colliding field name, or undefined if this isn't a P2002.
function prismaUniqueConflictField(error: unknown): string | undefined {
    const fields = uniqueViolationFields(error);
    if (!fields) return undefined;
    return fields[0] ?? 'unique';
}
