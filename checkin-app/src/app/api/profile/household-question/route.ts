import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { answerHouseholdQuestion, householdQuestion, JoinQuestionError, type JoinRefusal } from "@/lib/household/joinQuestion";

const REFUSALS: Record<JoinRefusal, { message: string; status: number }> = {
    not_pending: { message: "There is no question to answer.", status: 409 },
    youth: { message: "A youth cannot answer this. Please ask the Board.", status: 403 },
    denied: { message: "This household cannot be answered for. Please ask the Board.", status: 403 },
};

function respond(error: unknown) {
    if (error instanceof JoinQuestionError) {
        const { message, status } = REFUSALS[error.refusal];
        return apiError(message, status);
    }
    logger.error("Household question error:", error);
    return apiError("Internal Server Error", 500);
}

export const GET = withAuth({ allowJoinPending: true }, async (_req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    try {
        return NextResponse.json(await householdQuestion(auth.user.id));
    } catch (error) {
        return respond(error);
    }
});

export const POST = withAuth({ allowJoinPending: true }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const { join } = await req.json();
    if (typeof join !== "boolean") return apiError("join must be true or false", 400);
    try {
        await answerHouseholdQuestion(auth.user.id, join);
        return NextResponse.json({ joined: join });
    } catch (error) {
        return respond(error);
    }
});
