/** act(): the write wrapper every donation page uses to toast an outcome. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidElement } from "react";

const show = vi.fn<(o: { message: unknown }) => void>();
vi.mock("@mantine/notifications", () => ({ notifications: { show: (o: { message: unknown }) => show(o), update: vi.fn() } }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));

import { HttpError } from "@checkin/component-ui";
import { act } from "../../components/api";

beforeEach(() => show.mockReset());

describe("act", () => {
  it("keeps a failure's chip up with the route's error text", async () => {
    const reload = vi.fn();
    const ok = await act(() => Promise.reject(new HttpError('Could not import the CSV: line 13 (T1), "Match Amount": not a number: "x"', 400)), "Upload imported", reload);
    expect(ok).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    const text = 'Could not import the CSV: line 13 (T1), "Match Amount": not a number: "x"';
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ id: text, color: "red", autoClose: false }));
    const pane: unknown = show.mock.calls[0][0].message;
    expect(isValidElement(pane) && pane.props).toEqual({ style: expect.objectContaining({ whiteSpace: "pre-line" }), children: text });
  });

  it("lets a success chip close on its own", async () => {
    await act(() => Promise.resolve(null), "Upload imported", () => undefined);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: "Upload imported", color: "green" }));
  });
});
