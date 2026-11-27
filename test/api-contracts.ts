// Runtime URL parity, plus typecheck regressions for the shared request/response boundary.
import assert from "node:assert/strict";
import { feedQuery, queryUrl } from "../plugin/shared/api.ts";
import type { LiveWatchRequest, SideQ, ThreadQ } from "../plugin/shared/api.ts";

assert.equal(queryUrl("/api/q/side", {}), "/api/q/side");
assert.equal(queryUrl("/api/q/thread/:id", { id: "mac~a/b +?é", n: 100, before: "m&1" }), "/api/q/thread/mac~a%2Fb%20%2B%3F%C3%A9?n=100&before=m%261");
const input = { filter: "all", agent: "a,b", n: 20, after: "a+/=", live: undefined };
const url = new URL(queryUrl("/api/q/feed", input), "http://localhost");
assert.equal(url.searchParams.get("agent"), "a,b");
assert.equal(url.searchParams.get("after"), "a+/=");
assert.equal(url.searchParams.get("n"), "20");
assert.equal(url.searchParams.has("live"), false);
assert.deepEqual(input, { filter: "all", agent: "a,b", n: 20, after: "a+/=", live: undefined });
assert.equal(new URL(queryUrl("/api/q/threads", { ids: "a~1,b~2" }), "http://localhost").searchParams.get("ids"), "a~1,b~2");
const filters = feedQuery(new URLSearchParams("filter=working&agent=a%2Cb&workspace=w&page=p&group=g&feed=1&q=hello+world&n=10&after=c%2B%2F%3D&live=s&ignored=x"));
assert.deepEqual(filters, { filter: "working", agent: "a,b", workspace: "w", page: "p", group: "g", feed: "1", q: "hello world", n: 10, after: "c+/=", live: "s" });
assert.equal(new URL(queryUrl("/api/q/feed", filters), "http://localhost").searchParams.has("ignored"), false);
console.log("PASS shared queries preserve ids, scopes, pagination, and omitted parameters");

// Never run: make typecheck must reject these callers and handlers. Importing the server here would start its store.
function contracts(route: typeof import("../server/core/http.ts").queryRoute) {
  // @ts-expect-error A thread query needs its path parameter.
  queryUrl("/api/q/thread/:id", { n: 10 });
  // @ts-expect-error Query counts are numeric at the caller.
  queryUrl("/api/q/feed", { n: "ten" });
  // @ts-expect-error A sidebar query does not take pagination.
  queryUrl("/api/q/side", { before: "m1" });
  // @ts-expect-error An unregistered query has no contract.
  queryUrl("/api/q/missing", {});
  const side: SideQ = { records: {}, order: {}, data: { ws_running: 2 }, watching: false };
  route("/api/q/side", () => side);
  // @ts-expect-error The sidebar sends a count, not a map of counts.
  route("/api/q/side", () => ({ ...side, data: { ws_running: { app: 2 } } }));
  // @ts-expect-error A thread response must include its records and pagination.
  route("/api/q/thread/:id", () => ({ thread: "thread:a" }));
  route("/api/q/side", (_req, _res, { query }) => {
    // @ts-expect-error The server reads only parameters in this query's contract.
    query.get("before");
    return side;
  });
  // @ts-expect-error The watch name is shared by sender and receiver.
  const watch: LiveWatchRequest = { drop: "sidebar" };
  // @ts-expect-error Thread keys use the same namespace on both sides.
  const thread: ThreadQ["thread"] = "page:a";
}

// Inspect the producer types too: endpoint return annotations must not hide helpers that fell back to any.
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Assert<T extends true> = T;
type Clean<T> = IsAny<T> extends false ? true : false;
type Views = typeof import("../server/api/views.ts");
type Guests = typeof import("../server/api/guests.ts");
type Feed = ReturnType<Views["feedSeen"]>;
type OpenThread = NonNullable<ReturnType<Views["threadSeen"]>>;
type GuestInput = Parameters<Guests["withGuests"]>[2];
type GuestOutput = ReturnType<Guests["withGuests"]>;
type PayloadChecks = [
  Assert<Clean<ReturnType<Views["viewOnce"]>>>,
  Assert<Clean<ReturnType<Feed["record"]>>>,
  Assert<Clean<ReturnType<Feed["live"]>>>,
  Assert<Clean<OpenThread["record"]>>,
  Assert<Clean<OpenThread["messages"]>>,
  Assert<Clean<OpenThread["messages"][number]>>,
  Assert<Clean<OpenThread["runs"]>>,
  Assert<Clean<NonNullable<OpenThread["runs"]>[number]>>,
  Assert<Clean<OpenThread["live"]>>,
  Assert<Clean<GuestInput>>,
  Assert<Clean<GuestOutput>>,
  Assert<Clean<NonNullable<GuestOutput["messages"]>[number]>>,
  Assert<Clean<NonNullable<GuestOutput["runs"]>[number]>>,
  Assert<Clean<GuestOutput["live"]>>,
  Assert<Clean<ReturnType<Guests["guestsCard"]>>>,
  Assert<Clean<ReturnType<Guests["guestSaid"]>[number]>>,
];
