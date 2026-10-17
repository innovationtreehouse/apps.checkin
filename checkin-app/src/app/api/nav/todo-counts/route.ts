import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { todoCounts } from "@/lib/nav/todoCounts";

export const GET = withAuth({}, async (_req, auth) => {
    if (auth.type !== "session") {
        return apiError("Unauthorized", 401);
    }
    return NextResponse.json(await todoCounts(auth.user));
});
