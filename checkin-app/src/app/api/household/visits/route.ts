import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";

const DAY_MS = 24 * 60 * 60 * 1000;

export const GET = withAuth(
    {},
    async (req, auth) => {
        try {
            if (auth.type !== 'session') return apiError("Unauthorized", 401);
            const userId = auth.user.id;

            const { searchParams } = new URL(req.url);
            const filterDateStr = searchParams.get('date');

            let startDate: Date;
            let endDate: Date;

            if (filterDateStr) {
                // The date-only filter parses to UTC midnight, so shift the window in UTC
                // too — getDate/setDate read local fields and skew the bounds by the
                // server's DST offset across a transition.
                const baseMs = new Date(filterDateStr).getTime();
                startDate = new Date(baseMs - 7 * DAY_MS);
                endDate = new Date(baseMs + 7 * DAY_MS);
            } else {
                endDate = new Date();
                startDate = new Date();
                startDate.setDate(endDate.getDate() - 7);
            }

            const user = await prisma.person.findUnique({
                where: { id: userId },
                select: { householdId: true }
            });

            if (!user || !user.householdId) {
                return NextResponse.json({ visits: [] }, { status: 200 });
            }

            const visits = await prisma.visit.findMany({
                where: {
                    person: {
                        householdId: user.householdId
                    },
                    deletedAt: null,
                    arrivedAt: {
                        gte: startDate,
                        lte: endDate
                    }
                },
                orderBy: { arrivedAt: 'desc' },
                include: {
                    person: { select: { id: true, name: true } },
                    event: { select: { id: true, name: true } }
                }
            });

            return NextResponse.json({ visits }, { status: 200 });
        } catch (error) {
            logger.error("Household Visits GET Error:", error);
            return apiError("Internal Server Error", 500);
        }
    }
);
