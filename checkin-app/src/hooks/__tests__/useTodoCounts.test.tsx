import { act, renderHook, waitFor } from "@testing-library/react";
import { useTodoCounts } from "../useTodoCounts";
import { NAV_COUNTS_EVENT } from "@/lib/nav-refresh";
import type { TodoCounts } from "@/lib/nav/todoCounts";

let mockSession: { user: { id: number } } | null = { user: { id: 1 } };
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: mockSession, status: mockSession ? "authenticated" : "unauthenticated" }),
}));

const okResponse = (data: TodoCounts) => ({ ok: true, json: () => Promise.resolve(data) });

const makeCounts = (building: number): TodoCounts =>
  ({
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building,
    buildingHousehold: 0,
    buildingReachable: true,
    activePrograms: 0,
  }) as TodoCounts;

// useTodoCounts keeps one shared snapshot in module scope for every consumer
// (see the hook's own comment). That means these cases can't be reset between
// tests the way a plain hook could — they intentionally run in order, each
// building on the store state the previous case left behind, the same way
// two real badges reading the hook in sequence would.
describe("useTodoCounts", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  it("returns null and fetches nothing while disabled", () => {
    const { result } = renderHook(() => useTodoCounts(false));
    expect(result.current).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches on mount and returns the resolved counts", async () => {
    const data = makeCounts(4);
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(data) });

    const { result } = renderHook(() => useTodoCounts(true));

    await waitFor(() => expect(result.current).toEqual(data));
    expect(fetchMock).toHaveBeenCalledWith("/api/nav/todo-counts");
  });

  it("keeps the last snapshot when a fetch response is not ok", async () => {
    const priorSnapshot = makeCounts(4); // left behind by the previous test
    fetchMock.mockResolvedValue({ ok: false });

    const { result } = renderHook(() => useTodoCounts(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toEqual(priorSnapshot);
  });

  it("keeps the last snapshot when a fetch rejects", async () => {
    const priorSnapshot = makeCounts(4);
    fetchMock.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useTodoCounts(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toEqual(priorSnapshot);
  });

  it("refetches and updates every consumer when NAV_COUNTS_EVENT fires", async () => {
    const updated = makeCounts(9);
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(updated) });
    const { result } = renderHook(() => useTodoCounts(true));
    await waitFor(() => expect(result.current).toEqual(updated));

    const afterEvent = makeCounts(11);
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(afterEvent) });

    act(() => {
      window.dispatchEvent(new Event(NAV_COUNTS_EVENT));
    });

    await waitFor(() => expect(result.current).toEqual(afterEvent));
  });

  it("returns null while disabled even once a previous consumer populated the store", () => {
    const { result } = renderHook(() => useTodoCounts(false));
    expect(result.current).toBeNull();
  });

  it("shows nothing from the previous viewer once another tab switches the session", async () => {
    const forFirst = makeCounts(5);
    fetchMock.mockResolvedValue(okResponse(forFirst));
    const { result, rerender } = renderHook(() => useTodoCounts(true));
    await waitFor(() => expect(result.current).toEqual(forFirst));

    let answerSecond: (res: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => { answerSecond = resolve; }));
    fetchMock.mockClear();
    mockSession = { user: { id: 2 } };
    rerender();
    expect(result.current).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const forSecond = makeCounts(6);
    await act(async () => answerSecond(okResponse(forSecond)));
    await waitFor(() => expect(result.current).toEqual(forSecond));
  });

  it("drops a read for the previous viewer that answers after the switch", async () => {
    let answerLate: (res: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { answerLate = resolve; }));
    const { result, rerender } = renderHook(() => useTodoCounts(true));

    const forThird = makeCounts(8);
    fetchMock.mockResolvedValue(okResponse(forThird));
    mockSession = { user: { id: 3 } };
    rerender();

    await act(async () => answerLate(okResponse(makeCounts(7))));
    expect(result.current).not.toEqual(makeCounts(7));
    await waitFor(() => expect(result.current).toEqual(forThird));
  });

  it("returns null and fetches nothing when signed out, even if enabled", () => {
    mockSession = null;
    const { result } = renderHook(() => useTodoCounts(true));
    expect(result.current).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
