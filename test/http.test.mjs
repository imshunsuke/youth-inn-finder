import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/http/app.mjs";
import { createTestDb, applyMigrations } from "./helpers/d1.mjs";
import { validateDeploymentEnvironment } from "../scripts/deploy.mjs";

const clock = () => new Date("2026-10-13T04:00:00Z");
const request = (path, options) => new Request(`https://example.test${path}`, options);

test("health distinguishes configuration from delivery, applies security headers and exposes no secrets", async () => {
  const app = createApp({ clock });
  const response = await app(request("/api/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "youth-inn-finder", version: "1.0.0",
    now: clock().toISOString(), mailConfigured: false, monitoringEnabled: false, invitationRequired: false });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.equal((await app(request("/api/health", { method: "HEAD" }))).body, null);
  const invitationHealth = await createApp({ clock, env: { INVITATION_REQUIRED: "true" } })(request("/api/health"));
  assert.equal((await invitationHealth.json()).invitationRequired, true);
});

test("cross-origin writes are rejected before routing while public reads remain available", async () => {
  let called = 0;
  const app = createApp({ env: { DB: {} }, clock,
    queryHandler: async () => { called++; return new Response("ok"); } });
  const blocked = await app(request("/api/reminders", { method: "POST", headers: { Origin: "https://evil.test" }, body: "{}" }));
  assert.equal(blocked.status, 403); assert.equal(called, 0);
  assert.equal((await app(request("/api/calendar", { headers: { Origin: "https://another.test" } }))).status, 200);
});

test("unconfigured storage, unknown routes and unsupported methods have stable distinct errors", async () => {
  assert.equal((await createApp({ clock })(request("/api/calendar"))).status, 503);
  const app = createApp({ env: { DB: {} }, clock, queryHandler: async () => null, reminderHandler: async () => null });
  assert.equal((await app(request("/api/no-such-route"))).status, 404);
  assert.equal((await app(request("/", { method: "POST" }))).status, 405);
  assert.equal((await app(request("/api/health", { method: "POST" }))).status, 405);
});

test("unexpected handler errors never expose upstream, user or credential text", async () => {
  const app = createApp({ env: { DB: {} }, clock, queryHandler: async () => { throw new Error("token=private-test-credential"); } });
  const response = await app(request("/api/calendar"));
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private-test-credential/);
});

test("real query routes reject duplicate and invalid parameters before snapshot lookup", async (context) => {
  const db = await applyMigrations(createTestDb()); context.after(() => db.close());
  const app = createApp({ env: { DB: db }, clock });
  assert.equal((await app(request("/api/calendar?days=1.5"))).status, 400);
  assert.equal((await app(request("/api/calendar?days=21&days=7"))).status, 400);
  const cold = await app(request("/api/calendar"));
  assert.equal(cold.status, 503);
  assert.equal((await cold.json()).meta.pending, true);
});

test("public interval admission is persisted, bounded and does not store raw IP addresses", async (context) => {
  const db = await applyMigrations(createTestDb()); context.after(() => db.close());
  const app = createApp({ env: { DB: db, APP_SECRET: "unit-test-secret-with-at-least-32-bytes" }, clock,
    queryHandler: async () => new Response("ok") });
  const path = "/api/available?date=2026-10-15&endDate=2026-10-17";
  const headers = { "CF-Connecting-IP": "192.0.2.7" };
  for (let count = 0; count < 300; count++) assert.equal((await app(request(path, { headers }))).status, 200);
  const limited = await app(request(path, { headers }));
  assert.equal(limited.status, 429); assert.equal(limited.headers.get("Retry-After"), "600");
  const rows = await db.prepare("SELECT bucket_key FROM http_rate_limits").all();
  assert.doesNotMatch(JSON.stringify(rows), /192\.0\.2\.7/);
  assert.equal((await app(request(path, { headers: { "Sec-Fetch-Site": "cross-site" } }))).status, 403);
});

test("missing or short interval secret returns stable 503 without storing limits or enqueuing queries", async (context) => {
  const db = await applyMigrations(createTestDb()); context.after(() => db.close());
  let calls = 0;
  for (const secret of [undefined, "", "too-short"]) {
    const app = createApp({ env: { DB: db, ...(secret === undefined ? {} : { APP_SECRET: secret }) }, clock,
      queryHandler: async () => { calls += 1; return new Response("ok"); } });
    const response = await app(request("/api/available?date=2026-10-15&endDate=2026-10-17", {
      headers: { "CF-Connecting-IP": "192.0.2.7" },
    }));
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.code, "INTERVALS_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(payload), /192\.0\.2\.7|too-short/);
    assert.equal((await app(request("/api/calendar"))).status, 200, "public calendar still works without mail configuration");
  }
  assert.equal(calls, 3, "only the unrelated public calendar queries reach the handler");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM http_rate_limits").first()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM interval_query_jobs").first()).n, 0);
});

test("deployment preflight checks supplied secrets and sender before any CLI work", () => {
  for (const APP_SECRET of ["", "short", "a".repeat(31)]) {
    assert.throws(() => validateDeploymentEnvironment({ APP_SECRET }), /至少需要 32 字节/);
  }
  assert.doesNotThrow(() => validateDeploymentEnvironment({ APP_SECRET: "钥".repeat(11) }));
  assert.doesNotThrow(() => validateDeploymentEnvironment({})); // First deployment can generate its own key.
  for (const env of [{}, { BREVO_API_KEY: " ", MAIL_FROM: "sender@example.test" },
    { BREVO_API_KEY: "fake-test-key", MAIL_FROM: "invalid" },
    { BREVO_API_KEY: "fake-test-key", MAIL_FROM: "sender@example.test\n" }]) {
    assert.throws(() => validateDeploymentEnvironment(env, { withMail: true }), /邮件配置无效/);
  }
  assert.doesNotThrow(() => validateDeploymentEnvironment({ BREVO_API_KEY: "fake-test-key", MAIL_FROM: "sender@example.test" }, { withMail: true }));
  assert.doesNotThrow(() => validateDeploymentEnvironment({ APP_SECRET: "bad", BREVO_API_KEY: "", MAIL_FROM: "invalid" }, { dryRun: true, withMail: true }));
});

test("static responses retain content and MIME while inheriting the same security policy", async () => {
  const app = createApp({ clock, assetHandler: async () => new Response("<h1>青年驿站</h1>", { headers: { "Content-Type": "text/html" } }) });
  const response = await app(request("/"));
  assert.match(await response.text(), /青年驿站/);
  assert.equal(response.headers.get("content-type"), "text/html");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});
