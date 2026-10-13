import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import {
    ROLE_FLAGS,
    type RoleFlag,
    rolesToFlags,
    setRoleFlag,
    RoleMatrixError,
    LastBoardMemberError,
    DeniedHouseholdBoardError,
} from "@/lib/roles";
import { LIVE_PERSON } from "@/lib/person/filters";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { isYouth } from "@/lib/time";

const PERSON_SELECT = {
    id: true,
    email: true,
    name: true,
    // Read here (not derived from `roles`) so the PATCH handler below has the
    // pre-write value for the audit log without a second query.
    canAccessStaging: true,
} as const;

/** Thrown inside the tx when `targetUserId` does not resolve to a Person. */
class TargetNotFoundError extends Error {}

export const GET = withAuth(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async () => {
        try {
            const rows = await prisma.person.findMany({
                where: LIVE_PERSON,
                select: {
                    id: true,
                    email: true,
                    name: true,
                    dateOfBirth: true,
                    roles: { select: { role: true } },
                    // NOT one of the five ROLE_FLAGS — a plain column exposed alongside them
                    // (sysadmin-only settable; see the PATCH handler below).
                    canAccessStaging: true,
                },
                orderBy: { name: "asc" },
            });
            // Don't leak dob (PII); expose only a youth flag for filtering. isOperations has
            // no column, so every flag is derived through the one `roles` relation.
            const people = rows.map(({ dateOfBirth, roles, ...p }) => ({
                ...p,
                ...rolesToFlags(roles),
                isYouth: isYouth(dateOfBirth),
            }));
            return NextResponse.json({ people });
        } catch (error) {
            logger.error("Error fetching roles:", error);
            return apiError("Internal server error", 500);
        }
    }
);

export const PATCH = withAuth(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async (req, auth) => {
        try {
            if (auth.type !== 'session') {
                return apiError("Forbidden", 403);
            }
            const actor = auth.user;

            const body = await req.json();
            // canAccessStaging is pulled out separately: it is NOT one of the five
            // PersonRole-backed ROLE_FLAGS (see lib/roles.ts) and does not go through
            // setRoleFlag's board-symmetric authority matrix. It has its own,
            // stricter rule below — sysadmin-only, full stop, mirroring the pre-
            // roles-table "only sysadmins may modify isSysadmin" guard this route used
            // to have — so leaving it in `roleUpdates` would either 400 as an unknown
            // flag or (worse) let a board-only actor set it via the symmetric matrix.
            const { targetUserId, canAccessStaging, ...roleUpdates } = body;

            if (!targetUserId) {
                return apiError("Missing 'targetUserId'", 400);
            }

            const unknownKey = Object.keys(roleUpdates).find((k) => !ROLE_FLAGS.includes(k as RoleFlag));
            if (unknownKey) {
                return apiError(`Unknown role flag: ${unknownKey}`, 400);
            }

            const requested: Partial<Record<RoleFlag, boolean>> = {};
            for (const field of ROLE_FLAGS) {
                if (roleUpdates[field] !== undefined) {
                    requested[field] = Boolean(roleUpdates[field]);
                }
            }

            const settingStaging = canAccessStaging !== undefined;
            if (settingStaging && !actor.isSysadmin) {
                return apiError("Only Sysadmins can modify staging access", 403);
            }

            if (Object.keys(requested).length === 0 && !settingStaging) {
                return apiError("No valid role fields provided", 400);
            }

            const result = await prisma.$transaction(async (tx) => {
                const target = await tx.person.findUnique({
                    where: { id: targetUserId },
                    select: PERSON_SELECT,
                });
                if (!target) throw new TargetNotFoundError();

                // Delta + audit are built from setRoleFlag's post-lock read, so the
                // no-op check and the recorded before/after are consistent with the
                // write (thpr C). One call per requested flag; no-ops report changed:false.
                // TWO accumulators because these are two different tables. Role flags are
                // PersonRole rows; canAccessStaging is a plain column on Person. Folding
                // both into one AuditLog row would file a Person change under
                // tableName "PersonRole" — the exact metadata drift #1179 is cleaning up
                // elsewhere, and it would make the staging grant unfindable by anyone
                // querying the audit log for Person changes.
                const oldData: Partial<Record<RoleFlag, boolean>> = {};
                const newData: Partial<Record<RoleFlag, boolean>> = {};
                const stagingOld: Partial<Record<'canAccessStaging', boolean>> = {};
                const stagingNew: Partial<Record<'canAccessStaging', boolean>> = {};
                for (const field of Object.keys(requested) as RoleFlag[]) {
                    const { changed, before, after } = await setRoleFlag(
                        tx, targetUserId, field, requested[field]!, actor,
                    );
                    if (changed) {
                        oldData[field] = before;
                        newData[field] = after;
                    }
                }

                // Plain column write — no matrix, no mirror, no PersonRole row. Sysadmin-only
                // gate already enforced above (fail closed before any write happens).
                let canAccessStagingAfter = target.canAccessStaging;
                if (settingStaging) {
                    const after = Boolean(canAccessStaging);
                    if (after !== target.canAccessStaging) {
                        await tx.person.update({ where: { id: targetUserId }, data: { canAccessStaging: after } });
                        stagingOld.canAccessStaging = target.canAccessStaging;
                        stagingNew.canAccessStaging = after;
                    }
                    canAccessStagingAfter = after;
                }

                if (Object.keys(newData).length > 0) {
                    await tx.auditLog.create({
                        data: {
                            actorId: actor.id,
                            action: "EDIT",
                            tableName: "PersonRole",
                            affectedEntityId: targetUserId,
                            oldData,
                            newData,
                        },
                    });
                }

                // Separate row, tableName "Person": canAccessStaging is a column there, not
                // a PersonRole row. Same tx, so a PATCH that changes both still audits both
                // atomically — it just files each under the table it actually touched.
                if (Object.keys(stagingNew).length > 0) {
                    await tx.auditLog.create({
                        data: {
                            actorId: actor.id,
                            action: "EDIT",
                            tableName: "Person",
                            affectedEntityId: targetUserId,
                            oldData: stagingOld,
                            newData: stagingNew,
                        },
                    });
                }

                // Post-write read for the response's full flag set (lock already held).
                const rows = await tx.personRole.findMany({
                    where: { personId: targetUserId },
                    select: { role: true },
                });
                return {
                    user: {
                        id: target.id, email: target.email, name: target.name,
                        ...rolesToFlags(rows),
                        canAccessStaging: canAccessStagingAfter,
                    },
                };
            });
            // isKeyholder drives the roster's keyholder count and the close logic.
            invalidateAttendanceCache();

            return NextResponse.json({ message: "Roles updated successfully", user: result.user });
        } catch (error) {
            if (error instanceof TargetNotFoundError) {
                return apiError("No such user", 404);
            }
            if (error instanceof RoleMatrixError) {
                return apiError(error.message, 403);
            }
            if (error instanceof LastBoardMemberError) {
                return apiError("Cannot remove the last board member", 409);
            }
            if (error instanceof DeniedHouseholdBoardError) {
                return apiError("This person's household has been denied membership. Restore the household's membership before granting the board role.", 409);
            }
            logger.error("Error updating role:", error);
            return apiError("Internal server error", 500);
        }
    }
);
