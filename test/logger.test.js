import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalTimestamp } from '../src/logger.js';

test('formatLocalTimestamp includes milliseconds and the local UTC offset', () => {
  const date = new Date(2026, 7, 19, 16, 5, 7, 42);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, '0')}`
    + `:${String(absoluteOffset % 60).padStart(2, '0')}`;
  assert.equal(formatLocalTimestamp(date), `2026-08-19 16:05:07.042 ${offset}`);
});
