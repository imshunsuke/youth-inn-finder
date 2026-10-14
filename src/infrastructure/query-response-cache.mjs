// A bounded, disposable isolate cache. D1 remains authoritative; an eviction or
// cold isolate only costs a read. Never extend the oldest underlying sample TTL.
export function createQueryResponseCache({ clock = () => Date.now(), maxEntries = 32, maxBytes = 2_000_000 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError("Invalid response cache bounds");
  const entries = new Map(); let bytes = 0;
  const key = (request) => {
    if (request.method !== "GET" || request.headers.has("Authorization") || request.headers.has("Cookie")) return null;
    const url = new URL(request.url);
    if (!["/api/catalog", "/api/calendar", "/api/available", "/api/nearest", "/api/station"].includes(url.pathname)) return null;
    if (url.searchParams.has("warm") && !["false", "0", "off", "no", "n", ""].includes(url.searchParams.get("warm").toLowerCase())) return null;
    url.searchParams.sort(); return url.href;
  };
  const remove = (k) => { const old = entries.get(k); if (old) bytes -= old.size; entries.delete(k); };
  return {
    get(request) {
      const k = key(request), entry = entries.get(k);
      if (!entry) return null;
      if (clock() >= entry.until) { remove(k); return null; }
      entries.delete(k); entries.set(k, entry);
      const headers = new Headers(entry.headers); headers.set("X-Query-Cache", "HIT");
      return new Response(entry.body, { status: 200, headers });
    },
    async put(request, response) {
      const k = key(request), until = Math.min(Number(response.headers.get("X-Snapshot-Valid-Until")), clock() + 60_000);
      if (!k || response.status !== 200 || !Number.isFinite(until) || until <= clock()) return;
      const body = await response.clone().text(), size = new TextEncoder().encode(body).length;
      if (size > maxBytes || until <= clock()) return;
      remove(k);
      while (entries.size >= maxEntries || bytes + size > maxBytes) remove(entries.keys().next().value);
      entries.set(k, { body, headers: [...response.headers], until, size }); bytes += size;
    },
  };
}
