jest.mock("@mantine/notifications", () => ({ notifications: { show: jest.fn() } }));
jest.mock("@mantine/modals", () => ({ modals: { openConfirmModal: jest.fn() } }));

import { useState } from "react";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { notifications } from "@mantine/notifications";
import { modals } from "@mantine/modals";
import { renderWithProviders, resetRtl } from "@/test-helpers/rtl";
import { RolesEditModal, type RolesEditTarget } from "../RolesEditModal";

beforeEach(() => {
    resetRtl();
    (notifications.show as jest.Mock).mockClear();
    (modals.openConfirmModal as jest.Mock).mockClear();
});

// Jane: keyholder only. Bob: board member only. Distinct active-role sets so
// the switch-state assertions can't cross-match.
const jane: RolesEditTarget = {
    id: 1, name: "Jane Doe", email: "jane@example.com",
    isSysadmin: false, isBoardMember: false, isKeyholder: true, isBackgroundCheckReviewer: false, isOperations: false,
};
const bob: RolesEditTarget = {
    id: 2, name: "Bob Board", email: "bob@example.com",
    isSysadmin: false, isBoardMember: true, isKeyholder: false, isBackgroundCheckReviewer: false, isOperations: false,
};
const stagingTarget: RolesEditTarget = {
    id: 3, name: "Staging Candidate", email: "candidate@example.com",
    isSysadmin: false, isBoardMember: false, isKeyholder: false, isBackgroundCheckReviewer: false, isOperations: false,
    canAccessStaging: false,
};

describe("RolesEditModal", () => {
    it("is closed (nothing rendered) when target is null", () => {
        renderWithProviders(<RolesEditModal target={null} me={{ isBoardMember: true }} onClose={jest.fn()} onSaved={jest.fn()} />);
        expect(screen.queryByText(/Edit Roles/)).not.toBeInTheDocument();
    });

    it("renders five switches reflecting the target's current flags", () => {
        renderWithProviders(<RolesEditModal target={jane} me={{ isBoardMember: true }} onClose={jest.fn()} onSaved={jest.fn()} />);

        expect(screen.getByLabelText("Sysadmin")).not.toBeChecked();
        expect(screen.getByLabelText("Board")).not.toBeChecked();
        expect(screen.getByLabelText("Keyholder")).toBeChecked();
        expect(screen.getByLabelText("BG Reviewer")).not.toBeChecked();
        expect(screen.getByLabelText("Operations")).not.toBeChecked();
    });

    it("re-seeds the switches when a different target is opened", () => {
        function Harness() {
            const [target, setTarget] = useState<RolesEditTarget>(jane);
            return (
                <>
                    <button onClick={() => setTarget(bob)}>Switch to Bob</button>
                    <RolesEditModal target={target} me={{ isBoardMember: true }} onClose={jest.fn()} onSaved={jest.fn()} />
                </>
            );
        }
        renderWithProviders(<Harness />);
        expect(screen.getByLabelText("Keyholder")).toBeChecked();

        fireEvent.click(screen.getByText("Switch to Bob"));

        expect(screen.getByLabelText("Keyholder")).not.toBeChecked();
        expect(screen.getByLabelText("Board")).toBeChecked();
    });

    it("board actor: no switch is disabled, even for a target who is already board", () => {
        renderWithProviders(<RolesEditModal target={bob} me={{ isBoardMember: true }} onClose={jest.fn()} onSaved={jest.fn()} />);

        expect(screen.getByLabelText("Board")).toBeEnabled();
        expect(screen.getByLabelText("Sysadmin")).toBeEnabled();
    });

    it("sysadmin-only actor: Board switch is disabled only when currently on", () => {
        const signedJane = { ...jane, isKeyVolunteer: true, kvaSignedCurrent: true };
        const { unmount } = renderWithProviders(
            <RolesEditModal target={signedJane} me={{ isSysadmin: true }} onClose={jest.fn()} onSaved={jest.fn()} />,
        );
        // Jane: board off -> enabled (sysadmin-only may grant it).
        expect(screen.getByLabelText("Board")).toBeEnabled();
        unmount();

        renderWithProviders(
            <RolesEditModal target={bob} me={{ isSysadmin: true }} onClose={jest.fn()} onSaved={jest.fn()} />,
        );
        // Bob: board on -> disabled (sysadmin-only may never remove it).
        expect(screen.getByLabelText("Board")).toBeDisabled();
    });

    it("gated roles grant only to a Key Volunteer signed at the current version", () => {
        const { unmount } = renderWithProviders(<RolesEditModal target={jane} me={{ isBoardMember: true }} onClose={jest.fn()} onSaved={jest.fn()} />);
        // Not a Key Volunteer: Board, BG reviewer and Finance can't be granted; Keyholder can.
        expect(screen.getByLabelText("Board")).toBeDisabled();
        expect(screen.getByLabelText("BG Reviewer")).toBeDisabled();
        expect(screen.getByLabelText("Finance")).toBeDisabled();
        expect(screen.getByLabelText("Keyholder")).toBeEnabled();
        unmount();

        renderWithProviders(
            <RolesEditModal target={{ ...jane, isKeyVolunteer: true, kvaSignedCurrent: false }} me={{ isBoardMember: true }} onClose={jest.fn()} onSaved={jest.fn()} />,
        );
        expect(screen.getByLabelText("Board")).toBeDisabled();
        expect(screen.getByText("Has not signed the current agreement")).toBeInTheDocument();
    });

    it("Key Volunteer: board-only, and not removable while a gated role is on", () => {
        const kv = { ...jane, isBackgroundCheckReviewer: true, isKeyVolunteer: true, kvaSignedCurrent: true, kvaSignedAt: "2026-10-01T12:00:00.000Z" };
        const { unmount } = renderWithProviders(<RolesEditModal target={kv} me={{ isBoardMember: true }} onClose={jest.fn()} onSaved={jest.fn()} />);
        // BG reviewer is on, so Key Volunteer can't be switched off until it is; her Keyholder role doesn't block it.
        expect(screen.getByLabelText("Key Volunteer")).toBeDisabled();
        fireEvent.click(screen.getByLabelText("BG Reviewer"));
        expect(screen.getByLabelText("Key Volunteer")).toBeEnabled();
        expect(screen.getByLabelText("Board")).toBeEnabled();
        unmount();

        const { unmount: unmount2 } = renderWithProviders(<RolesEditModal target={stagingTarget} me={{ isSysadmin: true }} onClose={jest.fn()} onSaved={jest.fn()} />);
        expect(screen.getByLabelText("Key Volunteer")).toBeDisabled();
        unmount2();

        // A sysadmin manages Key Volunteers while no board member exists.
        renderWithProviders(<RolesEditModal target={stagingTarget} me={{ isSysadmin: true }} noBoard onClose={jest.fn()} onSaved={jest.fn()} />);
        expect(screen.getByLabelText("Key Volunteer")).toBeEnabled();
    });

    it("records an open agreement as signed by hand", async () => {
        (modals.openConfirmModal as jest.Mock).mockImplementation((opts: { onConfirm: () => void }) => opts.onConfirm());
        const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
        global.fetch = fetchMock as unknown as typeof fetch;
        const onSaved = jest.fn();
        const kv = { ...stagingTarget, isKeyVolunteer: true, kvaSignedCurrent: false, kvaOpenProcessId: 41 };
        renderWithProviders(<RolesEditModal target={kv} me={{ isBoardMember: true }} onClose={jest.fn()} onSaved={onSaved} />);

        fireEvent.click(screen.getByRole("button", { name: "Record signed by hand" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ kvaSignedCurrent: true, kvaOpenProcessId: null })));
        expect(fetchMock).toHaveBeenCalledWith("/api/membership-ops/applications/external", expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ processId: 41, action: "mark-contract" }),
        }));
        (modals.openConfirmModal as jest.Mock).mockReset();
    });

    it("no-delta Save closes without opening a confirm modal or calling onSaved", () => {
        const onClose = jest.fn();
        const onSaved = jest.fn();
        renderWithProviders(<RolesEditModal target={jane} me={{ isBoardMember: true }} onClose={onClose} onSaved={onSaved} />);

        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(modals.openConfirmModal).not.toHaveBeenCalled();
        expect(onSaved).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Save with a delta opens a confirm modal restating the delta, PATCHes only the delta, calls onSaved + onClose on success", async () => {
        const onSaved = jest.fn();
        const onClose = jest.fn();
        renderWithProviders(<RolesEditModal target={jane} me={{ isBoardMember: true }} onClose={onClose} onSaved={onSaved} />);

        fireEvent.click(screen.getByLabelText("Operations")); // grant
        fireEvent.click(screen.getByLabelText("Keyholder")); // revoke (was checked)
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(modals.openConfirmModal).toHaveBeenCalledTimes(1);
        const call = (modals.openConfirmModal as jest.Mock).mock.calls[0][0];
        // Rendered into its own detached container (and unmounted immediately after)
        // so its text doesn't collide with anything already on the page.
        const { container, unmount } = renderWithProviders(call.children);
        expect(container.textContent).toContain("Grant Operations");
        expect(container.textContent).toContain("Revoke Keyholder");
        expect(container.textContent).toContain("Jane Doe");
        unmount();

        const updatedUser = { id: 1, name: "Jane Doe", email: "jane@example.com", isSysadmin: false, isBoardMember: false, isKeyholder: false, isBackgroundCheckReviewer: false, isOperations: true };
        const patchFetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ message: "Roles updated successfully", user: updatedUser }),
        }));
        global.fetch = patchFetch as unknown as typeof fetch;

        await act(async () => {
            await call.onConfirm();
        });

        await waitFor(() => expect(patchFetch).toHaveBeenCalled());
        const [calledUrl, calledInit] = patchFetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(calledUrl).toBe("/api/roles");
        expect(calledInit.method).toBe("PATCH");
        expect(JSON.parse(calledInit.body as string)).toEqual({ targetUserId: 1, isKeyholder: false, isOperations: true });

        expect(onSaved).toHaveBeenCalledWith(updatedUser);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    describe("canAccessStaging (ops-stg gate, sysadmin-only, not one of the five ROLE_FLAGS)", () => {
        it("is hidden for a board-only actor (not board-symmetric like the five switches above)", () => {
            renderWithProviders(<RolesEditModal target={stagingTarget} me={{ isBoardMember: true }} onClose={jest.fn()} onSaved={jest.fn()} />);
            expect(screen.queryByLabelText(/Staging access/)).not.toBeInTheDocument();
        });

        it("is visible and togglable for a sysadmin actor", () => {
            renderWithProviders(<RolesEditModal target={stagingTarget} me={{ isSysadmin: true }} onClose={jest.fn()} onSaved={jest.fn()} />);
            expect(screen.getByLabelText(/Staging access/)).not.toBeChecked();
        });

        it("Save with only a staging delta PATCHes canAccessStaging and nothing else", async () => {
            const onSaved = jest.fn();
            const onClose = jest.fn();
            renderWithProviders(<RolesEditModal target={stagingTarget} me={{ isSysadmin: true }} onClose={onClose} onSaved={onSaved} />);

            fireEvent.click(screen.getByLabelText(/Staging access/));
            fireEvent.click(screen.getByRole("button", { name: "Save" }));

            expect(modals.openConfirmModal).toHaveBeenCalledTimes(1);
            const call = (modals.openConfirmModal as jest.Mock).mock.calls[0][0];
            const { container, unmount } = renderWithProviders(call.children);
            expect(container.textContent).toContain("Grant staging access");
            unmount();

            const updatedUser = { ...stagingTarget, canAccessStaging: true };
            const patchFetch = jest.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => ({ message: "Roles updated successfully", user: updatedUser }),
            }));
            global.fetch = patchFetch as unknown as typeof fetch;

            await act(async () => {
                await call.onConfirm();
            });

            await waitFor(() => expect(patchFetch).toHaveBeenCalled());
            const [, calledInit] = patchFetch.mock.calls[0] as unknown as [string, RequestInit];
            expect(JSON.parse(calledInit.body as string)).toEqual({ targetUserId: 3, canAccessStaging: true });
            expect(onSaved).toHaveBeenCalledWith(updatedUser);
        });
    });

    it("reverts the switches and toasts on a 409, without calling onSaved/onClose", async () => {
        const onSaved = jest.fn();
        const onClose = jest.fn();
        renderWithProviders(<RolesEditModal target={jane} me={{ isBoardMember: true }} onClose={onClose} onSaved={onSaved} />);

        fireEvent.click(screen.getByLabelText("Operations")); // grant
        fireEvent.click(screen.getByLabelText("Keyholder")); // revoke (was checked)
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        const call = (modals.openConfirmModal as jest.Mock).mock.calls[0][0];
        const patchFetch = jest.fn(async () => ({
            ok: false,
            status: 409,
            json: async () => ({ error: "Cannot remove the last board member" }),
        }));
        global.fetch = patchFetch as unknown as typeof fetch;

        await act(async () => {
            await call.onConfirm();
        });

        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(
                expect.objectContaining({ color: "red", message: "Cannot remove the last board member" }),
            ),
        );

        // Reverted: the modal's own switches snap back to Jane's last-known-good state.
        expect(screen.getByLabelText("Keyholder")).toBeChecked();
        expect(screen.getByLabelText("Operations")).not.toBeChecked();
        expect(onSaved).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("toasts a network error and reverts when the PATCH fetch rejects", async () => {
        const spy = jest.spyOn(console, "error").mockImplementation(() => {});
        const onSaved = jest.fn();
        const onClose = jest.fn();
        renderWithProviders(<RolesEditModal target={jane} me={{ isBoardMember: true }} onClose={onClose} onSaved={onSaved} />);

        fireEvent.click(screen.getByLabelText("Operations")); // grant
        fireEvent.click(screen.getByLabelText("Keyholder")); // revoke (was checked)
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        const call = (modals.openConfirmModal as jest.Mock).mock.calls[0][0];
        // Reject the fetch itself (not ok:false) so the catch runs, not the else branch.
        global.fetch = jest.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;

        await act(async () => {
            await call.onConfirm();
        });

        await waitFor(() =>
            expect(notifications.show).toHaveBeenCalledWith(
                expect.objectContaining({ color: "red", message: "Network error updating roles" }),
            ),
        );
        expect(spy).toHaveBeenCalledWith(expect.stringContaining("Failed to update roles"), expect.anything());

        // The catch (unlike the ok:false branch) does not revert; it only toasts.
        // Neither success callback fires.
        expect(onSaved).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
