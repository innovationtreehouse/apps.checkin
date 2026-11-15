import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { message, withTimeout, type ConfigCheck } from "@/lib/configHealth";
import { openProcess } from "@/lib/membership/lifecycle";

const id = "membership-legacy-check-flag";
const label = "Applications on the old household check flag";

/** Open applications that `legacyHouseholdCheckStarted` still reads as "check started". */
export const legacyCheckFlagWhere: Prisma.OrgMembershipProcessWhereInput = {
    ...openProcess.where,
    kind: { in: ["INITIAL", "RENEWAL"] },
    bgConsentAt: { not: null },
    bgClearedAt: null,
};

/**
 * The System Status row for step 3 of docs/in-design/BG_CHECK_STARTED-migration.md: a count only.
 * Green whatever the count, since it drains as applications finish; the Board handles stuck ones.
 */
export async function legacyCheckFlagCheck(): Promise<ConfigCheck> {
    try {
        const count = await withTimeout(prisma.orgMembershipProcess.count({ where: legacyCheckFlagWhere }), "The application count");
        return count === 0
            ? { id, label, ok: true, detail: "0. The legacy clause can be removed (step 3 of the check-started cutover)." }
            : { id, label, ok: true, detail: `${count} open. They drain as applications finish; remove the legacy clause once this reads 0.` };
    } catch (err) {
        return { id, label, ok: false, detail: `Could not read it: ${message(err)}.` };
    }
}
