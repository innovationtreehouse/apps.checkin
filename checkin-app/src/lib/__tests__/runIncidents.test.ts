/**
 * @jest-environment node
 */
import { getCronJobStatuses } from "@/lib/cronRuns";
import { evaluateIncidents, purgeClosedIncidents } from "@/lib/opsIncidents";
import prisma from "@/lib/prisma";
import { evaluateRun } from "../runIncidents";

jest.mock("@/lib/cronRuns", () => ({ getCronJobStatuses: jest.fn() }));
jest.mock("@/lib/opsIncidents", () => ({ evaluateIncidents: jest.fn(), purgeClosedIncidents: jest.fn() }));
jest.mock("@/lib/email-templates/send", () => ({ sendTemplated: jest.fn() }));

const findSettings = jest.fn();

beforeEach(() => {
    jest.clearAllMocks();
    prisma.boardSettings.findUnique = findSettings;
    jest.mocked(getCronJobStatuses).mockResolvedValue([
        { job: "nightly", lastSuccessAt: new Date(), stale: false },
        { job: "post-event", lastSuccessAt: new Date(0), stale: true },
    ]);
});

describe("evaluateRun", () => {
    it("adds every stopped job and sends to the alert and Board addresses", async () => {
        findSettings.mockResolvedValue({ alertEmailAddress: "alerts@example.org", boardEmailAddress: " board@example.org " });

        await evaluateRun({ lanes: ["nightly"], failures: [] });

        const [report, delivery] = jest.mocked(evaluateIncidents).mock.calls[0];
        expect(report).toEqual({ lanes: ["nightly"], failures: [], staleJobs: ["post-event"] });
        expect(delivery).toMatchObject({ alertTo: ["alerts@example.org"], boardTo: ["board@example.org"], timeZone: "America/Chicago" });
        expect(purgeClosedIncidents).toHaveBeenCalled();
    });

    it("an unset address means nobody to send to: no fallback", async () => {
        findSettings.mockResolvedValue({ alertEmailAddress: null, boardEmailAddress: "" });

        await evaluateRun({ lanes: ["nightly"], failures: [] });

        expect(jest.mocked(evaluateIncidents).mock.calls[0][1]).toMatchObject({ alertTo: [], boardTo: [] });
    });

    it("never throws: a failed evaluation is logged and the job goes on", async () => {
        findSettings.mockResolvedValue(null);
        jest.mocked(evaluateIncidents).mockRejectedValue(new Error("db down"));
        const logged = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
            await expect(evaluateRun({ lanes: ["nightly"], failures: [] })).resolves.toBeUndefined();
            expect(logged).toHaveBeenCalled();
        } finally {
            logged.mockRestore();
        }
    });
});
