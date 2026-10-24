import { sendCheckinNotifications } from "@/lib/notifications";
import { sendEmail } from "@/lib/email";

// Track how many sendEmail calls are in flight at once. Parallel dispatch
// (Promise.all) lets all 11 enter before any resolves, so maxInFlight === 11.
// A sequential `for await` loop would cap maxInFlight at 1.
//
// The resolve is deferred with a macrotask (setTimeout), not a microtask, so an
// in-flight send survives the `await prisma.person.findMany` (household leads) that
// sits between the participant send and the 10 household-lead sends — otherwise the
// participant email would resolve during that await and cap the count at 10.
let inFlight = 0;
let maxInFlight = 0;

jest.mock("@/lib/email", () => ({
    sendEmail: jest.fn().mockImplementation(() => new Promise<void>(resolve => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => {
            inFlight--;
            resolve();
        }, 0);
    }))
}));

jest.mock("@/lib/prisma", () => ({
    person: {
        findUnique: jest.fn().mockResolvedValue({
            id: 1,
            name: "Test Participant",
            email: "participant@example.com",
            notificationSettings: {
                emailCheckinReceipts: true
            },
            householdId: 1
        }),
        findMany: jest.fn().mockResolvedValue(
            Array.from({ length: 10 }).map((_, i) => ({
                id: 2 + i,
                name: `Lead ${i}`,
                email: `lead${i}@example.com`,
                notificationSettings: {
                    emailDependentCheckins: true
                }
            }))
        )
    }
}));

describe("Performance: sendCheckinNotifications", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        inFlight = 0;
        maxInFlight = 0;
    });

    it("should send notifications in parallel", async () => {
        await sendCheckinNotifications(1, "checkin");

        expect(sendEmail).toHaveBeenCalledTimes(11);
        // All 11 emails must be in flight simultaneously — proves parallel
        // dispatch. If the code regressed to sequential sends, this drops to 1.
        expect(maxInFlight).toBe(11);
    });
});

describe("sendCheckinNotifications event time", () => {
    beforeEach(() => jest.clearAllMocks());

    // A replayed or held scan must report when it happened, not when it synced.
    it("renders the passed scan time, not the send time", async () => {
        await sendCheckinNotifications(1, "checkin", "SCANNER", new Date("2026-03-04T15:00:00Z"));

        const html = (sendEmail as jest.Mock).mock.calls[0][2] as string;
        expect(html).toContain("March 4");
    });
});
