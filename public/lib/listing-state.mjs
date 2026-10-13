export const MAX_SAMPLE_AGE_MS = 20 * 60_000;

export function freshSample(row, now = Date.now()) {
  const age = now - Date.parse(row?.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < MAX_SAMPLE_AGE_MS;
}

// Favorites remember a place, never availability from another date or an old
// response. Only a fresh observation for the currently selected query supplies it.
export function favoriteForQuery(saved, current, confirmed, now = Date.now()) {
  const station = { ...saved, ...current, availableCount: null, availabilityStatus: "unknown", fetchedAt: null };
  return confirmed && freshSample(confirmed, now) ? { ...station, ...confirmed } : station;
}

export function freshIntervalView(payload, now = Date.now()) {
  const items = (Array.isArray(payload?.data) ? payload.data : []).filter((row) => freshSample(row, now));
  const oldest = payload?.meta?.availabilityFetchedAt ?? payload?.meta?.fetchedAt;
  const stale = Boolean(payload && oldest && !freshSample({ fetchedAt: oldest }, now));
  return { items, stale };
}
