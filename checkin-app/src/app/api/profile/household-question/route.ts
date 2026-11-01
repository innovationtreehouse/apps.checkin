import { ApiResponseError, handler } from "@/security/handler";
import { answerHouseholdQuestion, householdQuestion, JoinQuestionError, type JoinRefusal } from "@/lib/household/joinQuestion";

const REFUSALS: Record<JoinRefusal, { message: string; status: number }> = {
    not_pending: { message: "There is no question to answer.", status: 409 },
    youth: { message: "A youth cannot answer this. Please ask the Board.", status: 403 },
    denied: { message: "This household cannot be answered for. Please ask the Board.", status: 403 },
};

async function refusingAsResponse<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (!(error instanceof JoinQuestionError)) throw error;
        const { message, status } = REFUSALS[error.refusal];
        throw new ApiResponseError(status, message);
    }
}

export const GET = handler("GET /api/profile/household-question", async ({ auth }) => {
    if (auth.type !== "session") throw new ApiResponseError(401, "Unauthorized");
    const userId = auth.user.id;
    return { Household: await refusingAsResponse(() => householdQuestion(userId)) };
});

export const POST = handler("POST /api/profile/household-question", async ({ req, auth }) => {
    if (auth.type !== "session") throw new ApiResponseError(401, "Unauthorized");
    const userId = auth.user.id;
    const { join } = await req.json();
    if (typeof join !== "boolean") throw new ApiResponseError(400, "join must be true or false");
    await refusingAsResponse(() => answerHouseholdQuestion(userId, join));
    return {};
});
