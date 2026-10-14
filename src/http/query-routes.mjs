import { AppError, invalidInput } from "../domain/errors.mjs";
import { nowIso, todayInShanghai } from "../domain/dates.mjs";
import { createQueryService } from "../application/query-service.mjs";
import { createSnapshotClient, createSnapshotStore, DEFAULT_SNAPSHOT_FRESHNESS } from "../infrastructure/snapshot-store.mjs";
import { INTERACTIVE_REFRESH_MS } from "../application/interactive-collector.mjs";
import { parseBoolean, parseCommonQuery } from "../domain/query.mjs";

const ROUTES = new Set(["/api/calendar", "/api/available", "/api/nearest", "/api/station"]);
const PARAMETERS = new Set(["startDate", "date", "endDate", "days", "lat", "lon", "houseType", "onlyOnShelf",
  "district", "q", "keyword", "stationId", "houseId", "minCount", "limit", "sort", "includeDayItems", "includeOfficialDetails"]);

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers,
  } });
}

function queryParameters(url) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!PARAMETERS.has(key)) throw invalidInput("包含不支持的查询参数", key);
    if (Object.hasOwn(result, key)) throw invalidInput("同一查询参数不能重复提供", key);
    result[key] = value;
  }
  return result;
}

function addSnapshotMetadata(result, diagnostics) {
  const observations = diagnostics.observations;
  const times = observations.filter((item) => item.status === "fresh" && item.fetchedAt).map((item) => item.fetchedAt).sort();
  const coverage = { totalStations: observations.length, freshStations: 0, missingStations: 0, staleStations: 0,
    invalidStations: 0, lastFailedStations: 0 };
  for (const item of observations) {
    const field = `${item.status}Stations`;
    if (Object.hasOwn(coverage, field)) coverage[field] += 1;
    if (item.lastErrorCode) coverage.lastFailedStations += 1;
  }
  const pending = coverage.missingStations + coverage.staleStations + coverage.invalidStations > 0;
  result.meta = { ...result.meta, source: "persistent-snapshots", pending,
    partial: result.meta.partial || pending,
    availabilityFetchedAt: times[0] ?? null,
    snapshotCoverage: coverage,
    freshness: diagnostics.freshness,
    catalogStatus: diagnostics.catalogs[0]?.status ?? "missing",
    refreshAfterMs: pending ? 60_000 : 15 * 60_000,
  };
  // Retain the last sample time for diagnosis while keeping expired counts unknown.
  if (result.stations) {
    const byId = new Map(observations.map((item) => [item.stationId, item]));
    result.stations = result.stations.map((station) => ({ ...station,
      fetchedAt: station.fetchedAt ?? byId.get(station.id)?.fetchedAt ?? null,
      snapshotStatus: byId.get(station.id)?.status ?? "missing",
    }));
  }
  return result;
}

/** Standalone Web Request/Response handler. Returns null outside query routes.
 * Frontend reads D1 snapshots only: this function never calls official fetch().
 * A missing/stale interval may enqueue bounded durable work and signal a separate
 * small background slice. Never wait for 90 POSTs inside a response.
 * CORS, CSP, auth-independent global rate limits and security headers belong to the
 * root router. Rate-limit interval admission there before enabling public traffic.
 */
export async function handleQueryRequest(request, { db, clock = () => new Date(), minLeadDays = 2,
  freshness = DEFAULT_SNAPSHOT_FRESHNESS, maxIntervalJobs = 2000, intervalQueueTtlMs = 30 * 60_000, onIntervalPending, interactiveCollection = false } = {}) {
  let url;
  try { url = new URL(request.url); } catch { return jsonResponse({ error: "请求地址无效", code: "INVALID_INPUT" }, 400); }
  if (!ROUTES.has(url.pathname)) return null;
  if (request.method !== "GET") return jsonResponse({ error: "只支持 GET", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: "GET" });
  let client;
  try {
    const input = queryParameters(url);
    const store = createSnapshotStore({ db, clock });
    const includeOfficialDetails = parseBoolean(input.includeOfficialDetails, "includeOfficialDetails", true);
    if (url.pathname === "/api/station") {
      const query = parseCommonQuery(input);
      if (!query.stationId) throw invalidInput("请选择一个驿站", "stationId");
      const catalog = await store.readCatalog(query.houseType, { stationId: query.stationId, maxAgeMs: freshness.catalogMaxAgeMs });
      if (catalog.status !== "fresh") return jsonResponse({ error: "驿站详情正在更新，请稍后重试", code: catalog.status === "stale" ? "SNAPSHOT_STALE" : "SNAPSHOT_PENDING" }, 503, { "Retry-After": "60" });
      const station = catalog.payload.items[0];
      return station ? jsonResponse({ data: station, meta: { fetchedAt: catalog.fetchedAt } }) : jsonResponse({ error: "未找到这个驿站", code: "NOT_FOUND" }, 404);
    }
    client = createSnapshotClient({ store, clock, ...freshness, compactCatalog: !includeOfficialDetails });
    const service = createQueryService({ client, clock, minLeadDays });
    const result = url.pathname === "/api/calendar" ? await service.findCalendar(input)
      : url.pathname === "/api/nearest" ? await service.findNearest(input) : await service.findAvailable(input);
    const diagnostics = await client.diagnostics();
    addSnapshotMetadata(result, diagnostics);
    if (url.pathname === "/api/available" && input.endDate && result.meta.pending && result.meta.availabilityStatus !== "not-open") {
      const queued = await store.enqueueIntervalQuery({ ...input, date: input.date ?? todayInShanghai(clock) }, {
        ttlMs: intervalQueueTtlMs, maxJobs: maxIntervalJobs,
        catalogMaxAgeMs: freshness.catalogMaxAgeMs ?? DEFAULT_SNAPSHOT_FRESHNESS.catalogMaxAgeMs,
        intervalMaxAgeMs: freshness.intervalMaxAgeMs ?? DEFAULT_SNAPSHOT_FRESHNESS.intervalMaxAgeMs,
        observations: diagnostics.observations,
      });
      result.meta.collection = { status: queued.capacityLimited ? "capacity-limited" : queued.accepted > 0 ? "queued" : "ready", ...queued };
      if (queued.accepted > 0 && (onIntervalPending || interactiveCollection)) {
        onIntervalPending?.();
        result.meta.refreshAfterMs = INTERACTIVE_REFRESH_MS;
        if (interactiveCollection) result.meta.collection.advanceUrl = "/api/collection";
      }
    }
    // Cache only settled observations. A short response cache must expire no
    // later than either the catalog or the oldest underlying station sample.
    const at = new Date(clock()).getTime();
    const validUntil = Math.min(at + 60_000,
      ...diagnostics.catalogs.map((x) => Date.parse(x.fetchedAt) + diagnostics.freshness.catalogMaxAgeMs),
      ...diagnostics.observations.filter((x) => x.status === "fresh").map((x) => Date.parse(x.fetchedAt) +
        (x.kind === "interval" ? diagnostics.freshness.intervalMaxAgeMs : diagnostics.freshness.calendarMaxAgeMs)));
    return jsonResponse(result, 200, result.meta.pending ? { "Retry-After": String(result.meta.refreshAfterMs / 1000) }
      : Number.isFinite(validUntil) && validUntil > at ? { "X-Snapshot-Valid-Until": String(validUntil) } : {});
  } catch (error) {
    const known = error instanceof AppError;
    const status = known ? error.status : 500;
    const pending = known && ["SNAPSHOT_PENDING", "SNAPSHOT_STALE"].includes(error.code);
    const catalogFetchedAt = pending && client ? (await client.diagnostics()).catalogs[0]?.fetchedAt ?? null : null;
    return jsonResponse({ error: known && status < 500 ? error.message : pending ? error.message : "查询服务暂时不可用，请稍后重试",
      code: known ? error.code : "INTERNAL_ERROR",
      ...(known && error.details?.field ? { details: { field: error.details.field } } : {}),
      ...(pending ? { meta: { pending: true, partial: true, source: "persistent-snapshots", generatedAt: nowIso(clock),
        catalogStatus: error.details?.snapshotStatus ?? "missing", catalogFetchedAt, refreshAfterMs: 60_000 } } : {}),
    }, status, pending ? { "Retry-After": "60" } : {});
  }
}
