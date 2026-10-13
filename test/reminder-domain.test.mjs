import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateObservation, normalizeConditions, normalizeEmail } from '../src/domain/reminders.mjs';
const clock = () => new Date('2026-10-13T04:00:00Z');
const time = clock().toISOString();
const complete = { fetchedAt: time, partial: false, availabilityStatus: 'known',
  coverage: { totalStations: 2, successfulStations: 2, failedStations: 0, unknownStations: 0 } };

test('reminder conditions validate real dates, range, types and strip coordinates', () => {
  assert.equal(normalizeEmail(' USER@Example.test '), 'user@example.test');
  assert.throws(() => normalizeEmail('bad\r\n@example.test'));
  assert.throws(() => normalizeConditions({ date: '2026-02-30' }, { clock }));
  assert.throws(() => normalizeConditions({ date: '2026-10-12' }, { clock }));
  assert.throws(() => normalizeConditions({ date: '2026-10-15', endDate: '2026-10-15' }, { clock }));
  assert.throws(() => normalizeConditions({ date: '2027-12-01' }, { clock }));
  const value = normalizeConditions({ date: '2026-10-15', district: '徐汇区', lat: 10, lon: 20, minCount: 2 }, { clock });
  assert.equal(value.minCount, 2); assert.equal(value.district, '徐汇区'); assert.equal(value.lat, undefined);
});

test('only complete fresh negative observations re-arm; partial positive evidence is useful', () => {
  const evaluate = (result) => evaluateObservation(result, { now: clock().getTime() }).state;
  assert.equal(evaluate({ data: [], meta: complete }), 'empty');
  assert.equal(evaluate({ data: [], meta: { ...complete, partial: true } }), 'unknown');
  assert.equal(evaluate({ data: [], meta: { ...complete, coverage: { ...complete.coverage, unknownStations: 1 } } }), 'unknown');
  assert.equal(evaluate({ data: [], meta: { ...complete, fetchedAt: '2026-10-13T01:00:00Z' } }), 'unknown');
  assert.equal(evaluate({ data: [], meta: { ...complete, availabilityStatus: 'not-open' } }), 'unknown');
  assert.equal(evaluate({ data: [], meta: {} }), 'unknown');
  assert.equal(evaluate(null), 'unknown');
  assert.equal(evaluate({ data: [{ availableCount: 2, availabilityStatus: 'known', fetchedAt: time }], meta: { partial: true } }), 'matched');
  assert.equal(evaluate({ data: [{ availableCount: 2, availabilityStatus: 'known', fetchedAt: '2026-10-13T01:00:00Z' }], meta: complete }), 'unknown');
});

test('continuous-stay reminder input requires a selected station; single-day city monitoring stays valid', () => {
  assert.throws(() => normalizeConditions({ date: '2026-10-15', endDate: '2026-10-17' }, { clock }),
    { code: 'INVALID_INPUT', message: '连续入住提醒请选择一个驿站' });
  assert.throws(() => normalizeConditions({ date: '2026-10-15', endDate: '2026-10-17', stationId: ' ' }, { clock }),
    { code: 'INVALID_INPUT', message: '连续入住提醒请选择一个驿站' });
  const interval = normalizeConditions({ date: '2026-10-15', endDate: '2026-10-17', stationId: '64' }, { clock });
  assert.equal(interval.stationId, '64'); assert.equal(interval.endDate, '2026-10-17');
  assert.equal(normalizeConditions({ date: '2026-10-15' }, { clock }).stationId, '');
});
