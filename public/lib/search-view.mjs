import { freshSample, MAX_SAMPLE_AGE_MS } from './listing-state.mjs';

export const HISTORY_MAX_AGE_MS = 60 * 60_000;
const validCount = (sample) => sample?.availabilityStatus === 'known' && Number.isSafeInteger(sample.availableCount) && sample.availableCount >= 0;
const ageOf = (sample, now) => now - Date.parse(sample?.fetchedAt);

// Discovery cards are never evidence of availability. Only an observation for
// the exact selected date/range can supply a confirmed count or exclude a zero.
export function searchView({ stations = [], calendar, interval, date, endDate = null, minCount = 1, now = Date.now() } = {}) {
  const calendarById = new Map((calendar?.stations || []).map((x) => [x.id, x]));
  const exactRange = interval?.meta?.date === date && interval?.meta?.endDate === endDate;
  const observations = new Map((exactRange ? interval.observations || interval.data || [] : []).map((x) => [x.stationId || x.id, x]));
  const items = []; let confirmed = 0, historical = 0, excluded = 0;
  const notOpen = !endDate && calendar?.days?.find((x) => x.date === date)?.availabilityStatus === 'not-open'
    || endDate && exactRange && interval?.meta?.availabilityStatus === 'not-open';
  if (notOpen) return { items, confirmed, historical, pending: 0, excluded, status: 'not-open', total: stations.length };
  for (const station of stations) {
    let sample;
    if (endDate) sample = observations.get(station.id);
    else {
      const row = calendarById.get(station.id);
      const day = row?.availability?.find((x) => x.date === date);
      const old = row?.historicalAvailability?.[date];
      sample = { ...(validCount(day) ? day : old), fetchedAt: row?.fetchedAt };
    }
    const age = ageOf(sample, now);
    const known = validCount(sample);
    if (known && freshSample(sample, now)) {
      if (sample.availableCount < minCount) { excluded++; continue; }
      confirmed++;
      items.push({ ...station, availableCount: sample.availableCount, availabilityStatus: 'known', fetchedAt: sample.fetchedAt, displayState: 'confirmed' });
    } else {
      const history = known && age >= MAX_SAMPLE_AGE_MS && age < HISTORY_MAX_AGE_MS;
      if (history) historical++;
      items.push({ ...station, availableCount: null, availabilityStatus: 'unknown', fetchedAt: null,
        displayState: history ? 'historical' : 'candidate', ...(history ? { historicalCount: sample.availableCount, historicalFetchedAt: sample.fetchedAt } : {}) });
    }
  }
  return { items, confirmed, historical, pending: items.length - confirmed, excluded,
    status: items.length > confirmed ? 'pending' : 'open', total: stations.length };
}

const CATALOG_STORAGE_KEY = 'youth-inn-finder:catalog:v1';
const catalogFields = ['id', 'name', 'district', 'street', 'address'];
export function sanitizeCatalog(payload, now = Date.now()) {
  const age = ageOf(payload?.meta, now);
  if (!Array.isArray(payload?.data) || !Number.isFinite(age) || age < 0 || age >= 24 * 60 * 60_000) return null;
  return { meta: { fetchedAt: payload.meta.fetchedAt, availabilityStatus: 'unconfirmed' }, data: payload.data.slice(0, 200).filter((x) => x && typeof x.id === 'string' && x.id && typeof x.name === 'string').map((x) => {
    const row = Object.fromEntries(catalogFields.map((key) => [key, typeof x[key] === 'string' ? x[key].slice(0, 1000) : '']));
    for (const key of ['latitude', 'longitude']) row[key] = typeof x[key] === 'number' && Number.isFinite(x[key]) ? x[key] : null;
    row.isOnShelf = x.isOnShelf === true ? true : x.isOnShelf === false ? false : null;
    return row;
  }) };
}
export function readCatalogCache(key, storage = globalThis.localStorage, now = Date.now()) {
  try { return sanitizeCatalog(JSON.parse(storage.getItem(CATALOG_STORAGE_KEY) || '{}')[key], now); } catch { return null; }
}
export function writeCatalogCache(key, payload, storage = globalThis.localStorage, now = Date.now()) {
  try {
    const data = sanitizeCatalog(payload, now); if (!data || !['0', '1'].includes(key)) return false;
    const previous = JSON.parse(storage.getItem(CATALOG_STORAGE_KEY) || '{}');
    const records = Object.fromEntries(['0', '1'].filter((k) => sanitizeCatalog(previous[k], now)).map((k) => [k, sanitizeCatalog(previous[k], now)]));
    records[key] = data; storage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(records)); return true;
  } catch { return false; }
}

export function readBootstrapCatalog(document = globalThis.document, now = Date.now()) {
  try {
    const node = document.querySelector('#bootstrap-catalog');
    return sanitizeCatalog(JSON.parse(node?.content?.textContent || node?.textContent || 'null'), now);
  } catch { return null; }
}
