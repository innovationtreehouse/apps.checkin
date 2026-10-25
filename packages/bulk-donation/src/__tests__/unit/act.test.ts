/** act(): the write wrapper every donation page uses to toast an outcome. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const show = vi.fn();
vi.mock("@mantine/notifications", () => ({ notifications: { show: (o: unknown) => show(o) } }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));

import { act } from "../../components/api";

beforeEach(() => show.mockReset());

describe("act", () => {
  it("keeps a failure's chip up with the route's error text", async () => {
    const reload = vi.fn();
    const ok = await act(() => Promise.reject(new Error('Could not import the CSV: line 13 (T1), "Match Amount": not a number: "x"')), "Upload imported", reload);
    expect(ok).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith({
      message: 'Could not import the CSV: line 13 (T1), "Match Amount": not a number: "x"',
      color: "red",
      autoClose: false,
    });
  });

  it("lets a success chip close on its own", async () => {
    await act(() => Promise.resolve(null), "Upload imported", () => undefined);
    expect(show).toHaveBeenCalledWith({ message: "Upload imported", color: "green" });
  });
});
