export class ApiError extends Error {
  constructor(message, { status = 0, code = "", retryAfter = null } = {}) { super(message); this.name = "ApiError"; this.status = status; this.code = code; this.retryAfter = retryAfter; }
}
export async function request(path, { method = "GET", body, token, signal, timeoutMs = 35_000 } = {}) {
  if (!path.startsWith("/api/")) throw new Error("只允许同源 API 请求");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { method, credentials: "same-origin", headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, cache: "no-store" });
    if (response.status === 204) return { payload: {}, status: response.status, retryAfter: null };
    let payload;
    try { payload = await response.json(); } catch { throw new ApiError("服务暂时未返回有效数据，请稍后重试", { status: response.status }); }
    if (!response.ok) {
      const message = typeof payload?.error === "string" ? payload.error : payload?.error?.message || payload?.message;
      throw new ApiError(typeof message === "string" ? message : "查询暂时失败，请稍后重试", { status: response.status, code: payload?.error?.code || payload?.code || "", retryAfter: response.headers.get("Retry-After") });
    }
    return { payload, status: response.status, retryAfter: response.headers.get("Retry-After") };
  } catch (error) {
    if (signal?.aborted) throw new DOMException("查询已取消", "AbortError");
    if (error instanceof ApiError) throw error;
    throw new ApiError(controller.signal.aborted ? "查询超时，请稍后重试" : "暂时无法连接服务，请检查网络后重试");
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
export function apiPath(path, params) { const query = new URLSearchParams(); for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") query.set(key, String(value)); return `${path}?${query}`; }
export function isPending(result) { const p = result?.payload; return result?.status === 202 || p?.pending === true || p?.meta?.pending === true || p?.meta?.availabilityStatus === "pending" || p?.meta?.status === "pending"; }
