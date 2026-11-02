import { act, waitFor } from "@testing-library/react";

/** Waits for a request to `urlPart` and for the page to render its answer, so an absence check runs after that load. */
export async function settleAfter(urlPart: string) {
  await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.some(([url]) => String(url).includes(urlPart))).toBe(true));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
