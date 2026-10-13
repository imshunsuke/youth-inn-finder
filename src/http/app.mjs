import { AppError } from "../domain/errors.mjs";
import { handleQueryRequest } from "./query-routes.mjs";
import { handleReminderRequest } from "./reminder-routes.mjs";
import { validateReminderEnvironment } from "../infrastructure/mail.mjs";
import { invitationRequired } from "../domain/reminders.mjs";
import { collectInteractiveIntervals } from "../application/interactive-collector.mjs";

export const APP_VERSION = "1.0.0";
export function mailConfigured(env) {
  try { validateReminderEnvironment(env); return true; } catch { return false; }
}

export function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

async function hasBodyContent(request) {
  if (!request.body) return false;
  const reader = request.body.getReader(); let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new AppError("补查请求超时", { code: "REQUEST_TIMEOUT", status: 408 })), 2000); });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) return false;
      if (chunk.value?.byteLength) return true;
    }
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
}

function secure(response, requestId) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  headers.set("Content-Security-Policy", [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: https:",
    "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'",
    "form-action 'self'", "frame-ancestors 'none'",
  ].join("; "));
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function admitInterval(request, env, clock, scope = "interval") {
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") {
    throw new AppError("请在本站查询连续入住", { code: "ORIGIN_REJECTED", status: 403 });
  }
  if (typeof env.APP_SECRET !== "string" || new TextEncoder().encode(env.APP_SECRET).length < 32) {
    throw new AppError("连续入住查询正在准备，请稍后重试", { code: "INTERVALS_UNAVAILABLE", status: 503, retryable: true });
  }
  const at = new Date(clock()).getTime();
  const window = Math.floor(at / 600_000);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.APP_SECRET}:${ip}`));
  const fingerprint = Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
  for (const [key, limit] of [[`${scope}:ip:${window}:${fingerprint}`, 300], [`${scope}:global:${window}`, 1800]]) {
    const row = await env.DB.prepare(`INSERT INTO http_rate_limits (bucket_key,count,expires_at) VALUES (?,1,?)
      ON CONFLICT(bucket_key) DO UPDATE SET count=http_rate_limits.count+1 RETURNING count`)
      .bind(key, (window + 1) * 600_000).first();
    if (row.count > limit) throw new AppError("查询较频繁，请稍后再试", { code: "RATE_LIMITED", status: 429 });
  }
}

export function createApp({ env = {}, clock = () => new Date(),
  queryHandler = handleQueryRequest, reminderHandler = handleReminderRequest, assetHandler, onIntervalPending, interactiveCollection = false,
  collectIntervals = collectInteractiveIntervals } = {}) {
  return async function handle(request) {
    const requestId = crypto.randomUUID();
    try {
      const url = new URL(request.url);
      const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      const origin = request.headers.get("Origin");
      if (unsafe && origin && origin !== url.origin) {
        return secure(jsonResponse({ error: "请求来源无效", code: "ORIGIN_REJECTED" }, 403), requestId);
      }
      if (url.pathname === "/api/health") {
        if (!["GET", "HEAD"].includes(request.method)) {
          return secure(jsonResponse({ error: "只支持 GET", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: "GET, HEAD" }), requestId);
        }
        const configured = mailConfigured(env);
        const response = jsonResponse({ ok: true, service: "youth-inn-finder", version: APP_VERSION,
          now: new Date(clock()).toISOString(), mailConfigured: configured,
          monitoringEnabled: configured && env.ENABLE_MONITORING !== "false",
          invitationRequired: invitationRequired(env) });
        return secure(request.method === "HEAD" ? new Response(null, response) : response, requestId);
      }
      if (url.pathname.startsWith("/api/")) {
        if (!env.DB) throw new AppError("服务正在准备，请稍后重试", { code: "STORAGE_UNAVAILABLE", status: 503 });
        if (url.pathname === "/api/collection") {
          if (request.method !== "POST") return secure(jsonResponse({ error: "请使用 POST", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" }), requestId);
          if (url.search || await hasBodyContent(request)) return secure(jsonResponse({ error: "补查无需提供参数", code: "INVALID_INPUT" }, 400), requestId);
          if (!interactiveCollection) return secure(jsonResponse({ error: "按需补查暂不可用", code: "COLLECTION_UNAVAILABLE" }, 503), requestId);
          await admitInterval(request, env, clock, "collection");
          const result = await collectIntervals({ db: env.DB, clock, budget: 6 });
          return secure(jsonResponse(result, 200, { "Retry-After": result.reason === "daily-budget" ? "60" : "10" }), requestId);
        }
        if (url.pathname === "/api/available" && request.method === "GET" && url.searchParams.has("endDate")) {
          await admitInterval(request, env, clock);
        }
        const options = { db: env.DB, env, clock, maxIntervalJobs: 300, intervalQueueTtlMs: 5 * 60_000, onIntervalPending, interactiveCollection };
        const response = await queryHandler(request, options) ?? await reminderHandler(request, options) ??
          jsonResponse({ error: "接口不存在", code: "NOT_FOUND" }, 404);
        return secure(response, requestId);
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        return secure(jsonResponse({ error: "此页面只支持读取", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: "GET, HEAD" }), requestId);
      }
      const assets = assetHandler ?? (env.ASSETS && ((input) => env.ASSETS.fetch(input)));
      const response = assets ? await assets(request) : jsonResponse({ error: "页面不存在", code: "NOT_FOUND" }, 404);
      return secure(response, requestId);
    } catch (error) {
      const known = error instanceof AppError;
      if (!known) console.error(JSON.stringify({ event: "request_failed", requestId, code: "INTERNAL_ERROR" }));
      return secure(jsonResponse({ error: known ? error.message : "服务暂时不可用，请稍后重试",
        code: known ? error.code : "INTERNAL_ERROR" }, known ? error.status : 500,
      error?.status === 429 ? { "Retry-After": "600" } : {}), requestId);
    }
  };
}
