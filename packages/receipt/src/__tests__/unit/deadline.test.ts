import { afterEach, describe, expect, it, vi } from "vitest";
import { byDeadline, DeadlineError } from "../../lib/deadline";
import { callDeadlines, captureDeadlines, drainDeadline, MAIL_CATCH_UP_BUDGET_MS, MAIL_TIME_BUDGET_MS, mailLeaseUntil } from "../../services/mailIntake";
import { DRAIN_BUDGET_MS } from "../../services/ocrDrain";

const hung = () => new Promise<never>(() => {});

describe("byDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("abandons a hung call at its deadline, not before", async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 5_000;
    const settled = vi.fn();
    const call = byDeadline(deadline, "the reader", hung).catch((err: unknown) => {
      settled(err);
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await call;
    expect(settled).toHaveBeenCalledWith(expect.any(DeadlineError));
    expect(settled.mock.calls[0][0]).toMatchObject({ kind: "system" });
  });

  it("never starts a call once its deadline has passed", async () => {
    const call = vi.fn(hung);
    await expect(byDeadline(Date.now() - 1, "the reader", call)).rejects.toBeInstanceOf(DeadlineError);
    expect(call).not.toHaveBeenCalled();
  });

  it("passes an answer or a failure through before the deadline", async () => {
    await expect(byDeadline(Date.now() + 60_000, "the reader", async () => 7)).resolves.toBe(7);
    await expect(byDeadline(Date.now() + 60_000, "the reader", async () => Promise.reject(new Error("refused")))).rejects.toThrow("refused");
  });

  it("sets no timer for an infinite deadline", async () => {
    vi.useFakeTimers();
    await expect(byDeadline(Infinity, "the reader", async () => 7)).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("callDeadlines", () => {
  it.each([MAIL_TIME_BUDGET_MS, MAIL_CATCH_UP_BUDGET_MS])("ends every call before the lease of a %i ms run, reading calls first", (budgetMs) => {
    const started = Date.now();
    const leaseUntil = mailLeaseUntil(started, budgetMs);
    const { read, end } = callDeadlines(leaseUntil);
    expect(read).toBeGreaterThan(started + budgetMs);
    expect(read).toBeLessThan(end);
    expect(end).toBeLessThan(leaseUntil);
  });
});

describe("captureDeadlines", () => {
  it.each([MAIL_TIME_BUDGET_MS, MAIL_CATCH_UP_BUDGET_MS])("ends a %i ms run's capture calls with its budget, and its end-of-run calls before the lease's call deadlines", (budgetMs) => {
    const started = Date.now();
    const leaseUntil = mailLeaseUntil(started, budgetMs);
    const { read, end } = captureDeadlines(started, budgetMs, leaseUntil);
    expect(read).toBe(started + budgetMs);
    expect(end).toBeGreaterThan(read);
    expect(end).toBeLessThan(callDeadlines(leaseUntil).read);
  });

  it("keeps the daily run's every call inside the scheduler's 60-second wait", () => {
    const { end } = captureDeadlines(0, MAIL_TIME_BUDGET_MS, mailLeaseUntil(0, MAIL_TIME_BUDGET_MS));
    expect(end).toBeLessThan(60_000);
  });
});

describe("drainDeadline", () => {
  it.each([MAIL_TIME_BUDGET_MS, MAIL_CATCH_UP_BUDGET_MS])("gives a drain started when a %i ms run's intake ends its full budget, before the lease's reading deadline", (budgetMs) => {
    const started = Date.now();
    const leaseUntil = mailLeaseUntil(started, budgetMs);
    const drainStart = started + budgetMs;
    expect(drainDeadline(leaseUntil, drainStart)).toBe(drainStart + DRAIN_BUDGET_MS);
    expect(drainDeadline(leaseUntil, drainStart)).toBeLessThan(callDeadlines(leaseUntil).read);
  });

  it("never runs past the lease's reading deadline, however late the drain starts", () => {
    const started = Date.now();
    const leaseUntil = mailLeaseUntil(started, MAIL_TIME_BUDGET_MS);
    expect(drainDeadline(leaseUntil, leaseUntil)).toBe(callDeadlines(leaseUntil).read);
  });

  it("holds the daily run's lease to 20 and a half minutes and a catch-up's to 30", () => {
    expect(mailLeaseUntil(0, MAIL_TIME_BUDGET_MS)).toBe(20.5 * 60_000);
    expect(mailLeaseUntil(0, MAIL_CATCH_UP_BUDGET_MS)).toBe(30 * 60_000);
  });
});
