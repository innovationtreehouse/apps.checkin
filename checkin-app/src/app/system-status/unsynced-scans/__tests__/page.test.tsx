import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders, mockFetchJson, resetRtl } from "@/test-helpers/rtl";
import SystemStatusUnsyncedScansPage from "../page";

beforeEach(() => resetRtl());

const scan = (over: Record<string, unknown> = {}) => ({
    id: 5,
    // 40 minutes ago, so the D7 "40 min late" is a real computation, not a fixture string.
    timestamp: new Date(Date.now() - 40 * 60_000).toISOString(),
    location: "Main Entrance",
    reviewReason: "stale_replay",
    person: { id: 12, name: "Ada Lovelace" },
    ...over,
});

describe("SystemStatusUnsyncedScansPage", () => {
    it("renders the D7 row copy for a parked scan", async () => {
        mockFetchJson({ "/api/system-status/unsynced-scans": { scans: [scan()] } });
        renderWithProviders(<SystemStatusUnsyncedScansPage />);

        // "Person X, scanned 2:14pm, 40 min late" — the time is formatted in the
        // org zone, so match the parts that do not depend on it.
        const row = await screen.findByText(/Ada Lovelace, scanned .*, 40 min late/);
        expect(row).toBeInTheDocument();
        expect(screen.getByText(/queued scan arrived after the freshness window/)).toBeInTheDocument();
    });

    // The fallback numbers the PERSON, not the RawBadgeLog row — two different
    // ids that only diverge when they differ, which is why this needs its own case.
    it("falls back to the person's id, not the scan row's, when the name is blank", async () => {
        mockFetchJson({
            "/api/system-status/unsynced-scans": {
                scans: [scan({ id: 5, person: { id: 12, name: null } })],
            },
        });
        renderWithProviders(<SystemStatusUnsyncedScansPage />);

        expect(await screen.findByText(/Person #12, scanned /)).toBeInTheDocument();
        expect(screen.queryByText(/Person #5,/)).not.toBeInTheDocument();
    });

    it("shows an unresolvable read by its raw value, dismissible but not recordable", async () => {
        mockFetchJson({
            "/api/system-status/unsynced-scans": {
                scans: [scan({ person: null, scannedValue: "1234512345", reviewReason: "client_dead:unresolvable" })],
            },
        });
        renderWithProviders(<SystemStatusUnsyncedScansPage />);

        expect(await screen.findByText(/Unreadable badge "1234512345", scanned /)).toBeInTheDocument();
        expect(screen.getByText(/matches no one on record/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Record visit" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    });

    it("records a closed visit: departure entered, POSTed with the row id, row dropped", async () => {
        const fetchMock = mockFetchJson({
            "/api/system-status/unsynced-scans/5": {},
            "/api/system-status/unsynced-scans": { scans: [scan()] },
        });
        renderWithProviders(<SystemStatusUnsyncedScansPage />);

        fireEvent.click(await screen.findByRole("button", { name: "Record visit" }));
        const dialog = await screen.findByRole("dialog");
        // "They left" is the pre-selected outcome; the button holds until a
        // departure is supplied.
        const confirm = within(dialog).getByRole("button", { name: "Record visit" });
        expect(confirm).toBeDisabled();
        fireEvent.change(within(dialog).getByLabelText("Departure time"), {
            target: { value: "2026-08-20T21:00" },
        });
        fireEvent.click(confirm);

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system-status/unsynced-scans/5",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    action: "record",
                    departedAt: new Date("2026-08-20T21:00").toISOString(),
                }),
            }),
        );
        expect(await screen.findByText("● No scans awaiting review.")).toBeInTheDocument();
    });

    it("records a leave-open visit without a departedAt", async () => {
        const fetchMock = mockFetchJson({
            "/api/system-status/unsynced-scans/5": {},
            "/api/system-status/unsynced-scans": { scans: [scan()] },
        });
        renderWithProviders(<SystemStatusUnsyncedScansPage />);

        fireEvent.click(await screen.findByRole("button", { name: "Record visit" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByLabelText("They are still here — leave the visit open"));
        fireEvent.click(within(dialog).getByRole("button", { name: "Record visit" }));

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system-status/unsynced-scans/5",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "record" }) }),
        );
        expect(await screen.findByText("● No scans awaiting review.")).toBeInTheDocument();
    });

    it("surfaces the server's refusal and keeps the row", async () => {
        const fetchMock = mockFetchJson({
            "/api/system-status/unsynced-scans/5": {},
            "/api/system-status/unsynced-scans": { scans: [scan()] },
        });
        fetchMock.mockImplementationOnce(() =>
            Promise.resolve({ ok: true, json: () => Promise.resolve({ scans: [scan()] }) } as unknown as Response),
        );
        renderWithProviders(<SystemStatusUnsyncedScansPage />);
        fireEvent.click(await screen.findByRole("button", { name: "Record visit" }));
        fetchMock.mockImplementationOnce(() =>
            Promise.resolve({
                ok: false,
                status: 409,
                json: () => Promise.resolve({ error: "A visit already covers that scan time — dismiss the row instead." }),
            } as unknown as Response),
        );
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByLabelText("They are still here — leave the visit open"));
        fireEvent.click(within(dialog).getByRole("button", { name: "Record visit" }));

        expect(
            await screen.findByText("A visit already covers that scan time — dismiss the row instead."),
        ).toBeInTheDocument();
        expect(screen.queryByText("● No scans awaiting review.")).not.toBeInTheDocument();
    });

    it("dismisses a row by POSTing to it, then drops it from the list", async () => {
        // Longest key first: mockFetchJson matches by substring, so the list
        // route would otherwise swallow the dismiss URL.
        const fetchMock = mockFetchJson({
            "/api/system-status/unsynced-scans/5": {},
            "/api/system-status/unsynced-scans": { scans: [scan()] },
        });
        renderWithProviders(<SystemStatusUnsyncedScansPage />);

        fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system-status/unsynced-scans/5",
            expect.objectContaining({ method: "POST" }),
        );
        expect(await screen.findByText("● No scans awaiting review.")).toBeInTheDocument();
    });

    it("shows an empty state when nothing is awaiting review", async () => {
        mockFetchJson({ "/api/system-status/unsynced-scans": { scans: [] } });
        renderWithProviders(<SystemStatusUnsyncedScansPage />);

        expect(await screen.findByText("● No scans awaiting review.")).toBeInTheDocument();
    });
});
