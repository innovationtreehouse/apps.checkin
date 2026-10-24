/**
 * Test doubles for the Shopify GraphQL surface.
 *
 * `fakeClient` is a `ShopifyClient` whose `request` is driven by a responder you
 * supply, while recording every `{ query, variables }` it was called with so a test
 * can assert the exact filter / cursor / page size that the code under test sent.
 * The real client's retry/throttle loop is exercised separately in
 * client-request.test.ts against a stubbed global `fetch`; here we stub the whole
 * client so orchestration tests stay free of network and timing concerns.
 */
import type { ShopifyClient } from "../../src/shopify/client.js";

export interface RecordedCall {
  query: string;
  variables: Record<string, unknown>;
}

export interface ResponderArgs {
  query: string;
  variables: Record<string, unknown>;
  /** Zero-based index of this call — handy for returning successive pages. */
  index: number;
}

/** A responder returns the data payload for a call, or throws/returns an Error to reject. */
export type Responder = unknown | ((args: ResponderArgs) => unknown);

export interface FakeClient extends ShopifyClient {
  readonly calls: RecordedCall[];
}

export function fakeClient(responder: Responder): FakeClient {
  const calls: RecordedCall[] = [];
  return {
    endpoint: "https://test-shop.myshopify.com/admin/api/2026-04/graphql.json",
    async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      const index = calls.length;
      calls.push({ query, variables });
      const value = typeof responder === "function" ? (responder as (a: ResponderArgs) => unknown)({ query, variables, index }) : responder;
      if (value instanceof Error) throw value;
      return value as T;
    },
    calls,
  };
}

/**
 * Build a responder that returns the supplied values in call order, reusing the last
 * one once exhausted. An Error value is thrown for that call. Keeps multi-page /
 * multi-step scripts terse: `fakeClient(queue(page1, page2))`.
 */
export function queue(...responses: unknown[]): (args: ResponderArgs) => unknown {
  return ({ index }) => responses[Math.min(index, responses.length - 1)];
}
