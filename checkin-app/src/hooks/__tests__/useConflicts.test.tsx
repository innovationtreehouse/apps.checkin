import { act, renderHook, waitFor } from "@testing-library/react";
import { useConflicts } from "../useConflicts";
import type { AttendanceConflict } from "@/lib/attendanceConflicts";

const makeConflict = (participantId: number): AttendanceConflict =>
  ({
    participantId,
    participantName: "Kid One",
    eventId: 10,
    eventName: "Robotics",
    visits: [],
  }) as AttendanceConflict;

const answer = (conflicts: AttendanceConflict[]) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify({ conflicts }) }) as Response;

describe("useConflicts", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  it("returns null and fetches nothing while disabled", () => {
    const { result } = renderHook(() => useConflicts(false));
    expect(result.current.conflicts).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches on mount and returns the resolved conflicts", async () => {
    const conflicts = [makeConflict(1)];
    fetchMock.mockResolvedValue(answer(conflicts));

    const { result } = renderHook(() => useConflicts(true));

    await waitFor(() => expect(result.current.conflicts).toEqual(conflicts));
    expect(fetchMock).toHaveBeenCalledWith("/api/my-programs/conflicts", expect.anything());
  });

  it("gives two consumers one read", async () => {
    fetchMock.mockResolvedValue(answer([makeConflict(1)]));

    const first = renderHook(() => useConflicts(true));
    const second = renderHook(() => useConflicts(true));

    await waitFor(() => expect(first.result.current.conflicts).not.toBeNull());
    await waitFor(() => expect(second.result.current.conflicts).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the last answer and reports the error when a refresh is refused", async () => {
    const conflicts = [makeConflict(1)];
    fetchMock.mockResolvedValue(answer(conflicts));
    const { result } = renderHook(() => useConflicts(true));
    await waitFor(() => expect(result.current.conflicts).toEqual(conflicts));

    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => JSON.stringify({ error: "Forbidden" }) } as Response);
    act(() => { void result.current.refresh(); });

    await waitFor(() => expect(result.current.error).toBe("Forbidden"));
    expect(result.current.conflicts).toEqual(conflicts);
  });

  it("refresh() re-fetches and updates the answer", async () => {
    fetchMock.mockResolvedValue(answer([makeConflict(2)]));
    const { result } = renderHook(() => useConflicts(true));
    await waitFor(() => expect(result.current.conflicts).toEqual([makeConflict(2)]));

    fetchMock.mockResolvedValue(answer([makeConflict(3)]));
    act(() => { void result.current.refresh(); });

    await waitFor(() => expect(result.current.conflicts).toEqual([makeConflict(3)]));
  });
});
