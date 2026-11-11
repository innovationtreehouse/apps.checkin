import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { orgCalendarDay } from "@/lib/time";

export const GET = withAuth(
    { roles: ['isSysadmin', 'isBoardMember', 'isKeyholder'] },
    async () => {
        try {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

            const metrics = await prisma.systemMetricLog.findMany({
                where: {
                    metric: "scan_response_time",
                    timestamp: {
                        gte: thirtyDaysAgo,
                    },
                },
                select: {
                    value: true,
                    timestamp: true,
                },
                orderBy: {
                    timestamp: "asc",
                },
            });

            const groupedByDay: Record<string, number[]> = {};
            
            const today = orgCalendarDay();
            for (let i = 29; i >= 0; i--) {
                const date = new Date(today);
                date.setUTCDate(date.getUTCDate() - i);
                const dateStr = date.toISOString().split('T')[0];
                groupedByDay[dateStr] = [];
            }

            metrics.forEach((m: { timestamp: Date; value: number }) => {
                const dateStr = orgCalendarDay(m.timestamp).toISOString().split('T')[0];
                if (groupedByDay[dateStr]) {
                    groupedByDay[dateStr].push(m.value);
                }
            });

            const getPercentile = (data: number[], p: number) => {
                if (data.length === 0) return 0;
                data.sort((a, b) => a - b);
                const index = (p / 100) * (data.length - 1);
                if (Math.floor(index) === index) {
                    return data[index];
                }
                const i = Math.floor(index);
                const fraction = index - i;
                return data[i] + (data[i + 1] - data[i]) * fraction;
            };

            const dailyStats = Object.keys(groupedByDay).map(date => {
                const values = groupedByDay[date];
                return {
                    date,
                    count: values.length,
                    median: Math.round(getPercentile(values, 50)),
                    p90: Math.round(getPercentile(values, 90)),
                    p99: Math.round(getPercentile(values, 99)),
                };
            });

            prisma.systemMetricLog
                .deleteMany({
                    where: {
                        timestamp: {
                            lt: thirtyDaysAgo,
                        },
                    },
                })
                .catch((err: unknown) => logger.error("Failed to delete old system metrics:", err));

            return NextResponse.json({
                days: dailyStats
            });
        } catch (error) {
            logger.error("Failed to fetch system health metrics:", error);
            return apiError("Internal Server Error", 500);
        }
    }
);
