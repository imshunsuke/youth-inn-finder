import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/http/app.mjs";
import { createTestDb, applyMigrations } from "./helpers/d1.mjs";

test("collection accepts no caller-selected work, rejects foreign origins and enforces one small server budget", async (t) => {
  const db = await applyMigrations(createTestDb()); t.after(() => db.close()); let calls = 0;
  const app = createApp({ env: { DB: db, APP_SECRET: "unit-test-secret-with-at-least-32-bytes" }, interactiveCollection: true,
    collectIntervals: async (options) => { calls++; assert.equal(options.budget, 6); return { status: "collected", attempted: 6, succeeded: 6 }; } });
  const req = (options = {}, query = "") => new Request("https://finder.example.test/api/collection" + query, options);
  assert.equal((await app(req())).status, 405);
  assert.equal((await app(req({ method: "POST", body: '{}' }))).status, 400);
  assert.equal((await app(req({ method: "POST" }, "?budget=900"))).status, 400);
  assert.equal((await app(req({ method: "POST", headers: { Origin: "https://other.test" } }))).status, 403);
  assert.equal((await app(req({ method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } }))).status, 403);
  assert.equal(calls, 0);
  const response = await app(req({ method: "POST" }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("Retry-After"), "10"); assert.equal(calls, 1);
  assert.equal((await app(req({ method: "POST", body: new Uint8Array(0) }))).status, 200);
  assert.equal(calls, 2, "an empty stream in a Web runtime is also a bodyless request");
});

test("quota exhaustion keeps its distinct reason and returns a slower retry", async (t) => {
  const db = await applyMigrations(createTestDb()); t.after(() => db.close());
  const app = createApp({ env: { DB: db, APP_SECRET: "unit-test-secret-with-at-least-32-bytes" }, interactiveCollection: true,
    collectIntervals: async () => ({ status: "throttled", reason: "daily-budget", attempted: 0, succeeded: 0 }) });
  const response = await app(new Request("https://finder.example.test/api/collection", { method: "POST" }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("Retry-After"), "60"); assert.equal((await response.json()).reason, "daily-budget");
});
