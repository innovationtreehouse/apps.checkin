import { ServiceError, type StuckItem } from "@checkin/component-kit";
import type { ClearanceStep } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { logBackendError } from "@/lib/logger";
import { raisePaymentException } from "@/lib/finance/reconcile/exceptions";
import { openPersonBgForNewMember } from "@/lib/membership/personBgTriggers";
import { openPersonAgreementForNewMember } from "@/lib/membership/personAgreementTriggers";

/** Each step's name on the Problems list. */
const STEP_NAMES: Record<ClearanceStep, string> = {
    REFUNDED_ORDER_RAISE: "refunded order raise",
    PERSON_BG_TRIGGER: "person background-check trigger",
    PERSON_AGREEMENT_TRIGGER: "person agreement trigger",
};

const stepNamed = (name: string): ClearanceStep | undefined =>
    (Object.keys(STEP_NAMES) as ClearanceStep[]).find((step) => STEP_NAMES[step] === name);

/** Whether a Problems list step name is one of these steps. */
export const isClearanceStepName = (name: string): boolean => stepNamed(name) !== undefined;

/** What a step needs to run, from its application. */
type StepTarget = { processId: number; householdId: number | null; shopifyOrderId: string | null; asOf: Date };

/** Runs one step. Every step is safe to repeat: each skips what is already raised or opened. */
async function runStep(step: ClearanceStep, target: StepTarget): Promise<void> {
    const { processId, householdId, shopifyOrderId, asOf } = target;
    if (step === "REFUNDED_ORDER_RAISE") {
        if (!shopifyOrderId) throw new Error(`application ${processId} has no order to raise`);
        await raisePaymentException("REVERSED_BEFORE_ACTIVATION", { processId, shopifyOrderId, severity: "CRITICAL" });
        return;
    }
    if (householdId === null) throw new Error(`application ${processId} has no household`);
    if (step === "PERSON_BG_TRIGGER") await openPersonBgForNewMember(householdId, asOf);
    else await openPersonAgreementForNewMember(householdId, processId, asOf);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

/**
 * Runs a step owed after a clearance committed, so it never throws. A failure is logged and kept
 * as a stuck item on the Problems list, timed by its first failure, until a Retry succeeds.
 */
export async function runClearanceStep(step: ClearanceStep, target: StepTarget): Promise<void> {
    try {
        await runStep(step, target);
    } catch (error) {
        const context = { householdId: target.householdId, processId: target.processId };
        await logBackendError(error, `clearance ${STEP_NAMES[step]}`, context);
        try {
            await prisma.clearanceStepFailure.upsert({
                where: { processId_step: { processId: target.processId, step } },
                create: { processId: target.processId, step, failedAt: target.asOf, error: errorText(error) },
                update: { error: errorText(error) },
            });
        } catch (recordError) {
            await logBackendError(recordError, "recording a stuck clearance step", context);
        }
    }
}

/** Steps owed after a clearance that failed, each named by its application id and timed by its first failure. */
export async function stuckClearanceSteps(): Promise<StuckItem[]> {
    const rows = await prisma.clearanceStepFailure.findMany({
        select: { processId: true, step: true, failedAt: true, process: { select: { orgMembership: { select: { householdId: true } } } } },
    });
    return rows.map((r) => ({
        id: String(r.processId),
        step: STEP_NAMES[r.step],
        href: r.process.orgMembership ? `/membership-ops/households/${r.process.orgMembership.householdId}` : null,
        failedAt: r.failedAt,
    }));
}

/**
 * Runs a stuck step once, as of its first failure. Success deletes the item; a failure keeps it
 * with its first failure time, records the new error and answers 409 with no error text. An item
 * that is not stuck answers 404.
 */
export async function retryClearanceStep({ id, step: name }: { id: string; step: string }): Promise<void> {
    const step = stepNamed(name);
    if (!step || !/^[1-9]\d*$/.test(id)) throw new ServiceError(404, `No step ${name} in membership`);
    const processId = Number(id);
    const stuck = await prisma.clearanceStepFailure.findUnique({
        where: { processId_step: { processId, step } },
        select: { id: true, failedAt: true, process: { select: { shopifyOrderId: true, orgMembership: { select: { householdId: true } } } } },
    });
    if (!stuck) throw new ServiceError(404, "No stuck clearance step for that application");
    const target = { processId, householdId: stuck.process.orgMembership?.householdId ?? null, shopifyOrderId: stuck.process.shopifyOrderId, asOf: stuck.failedAt };
    try {
        await runStep(step, target);
    } catch (error) {
        await logBackendError(error, `clearance ${name} retry`, { householdId: target.householdId, processId });
        await prisma.clearanceStepFailure.updateMany({ where: { id: stuck.id }, data: { error: errorText(error) } });
        throw new ServiceError(409, "The step failed again");
    }
    await prisma.clearanceStepFailure.deleteMany({ where: { id: stuck.id } });
}
