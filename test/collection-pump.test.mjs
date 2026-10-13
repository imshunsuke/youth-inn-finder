import assert from "node:assert/strict";
import test from "node:test";
import { createCollectionPump } from "../public/lib/collection-pump.mjs";
const pending = { pending: true, collection: { advanceUrl: "/api/collection" } };

test("hidden, complete and untrusted collection URLs do not trigger upstream work", async () => {
  const pump = createCollectionPump({ requestImpl: () => { throw new Error("unexpected request"); } });
  for (const [meta, options] of [[pending, { visible: false }], [{ ...pending, pending: false }],
    [{ ...pending, collection: { advanceUrl: "https://other.test/collect" } }], [undefined]]) {
    assert.equal(await pump.advance(meta, options), null);
  }
});
test("overlapping ticks coalesce and failures honor Retry-After before resuming", async () => {
  let at = 0, calls = 0, unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const pump = createCollectionPump({ clock: () => at, requestImpl: async (path, options) => {
    calls++; assert.equal(path, "/api/collection"); assert.equal(options.method, "POST"); assert.equal(options.body, undefined);
    if (calls === 1) { await blocked; return { payload: { status: "collected" }, retryAfter: "10" }; }
    if (calls === 2) throw Object.assign(new Error("rate limited"), { status: 429, retryAfter: "600" });
    return { payload: { status: "idle" }, retryAfter: "10" };
  } });
  const first = pump.advance(pending); at = 10_000;
  assert.equal(pump.advance(pending), first); assert.equal(calls, 1);
  unblock(); await first;
  at = 19_999; assert.equal(await pump.advance(pending), null);
  at = 20_000; await assert.rejects(pump.advance(pending), /rate limited/);
  at = 619_999; assert.equal(await pump.advance(pending), null);
  at = 620_000; assert.equal((await pump.advance(pending)).status, "idle"); assert.equal(calls, 3);
});
