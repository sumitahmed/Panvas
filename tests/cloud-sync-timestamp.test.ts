import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLastSynced } from '../src/components/library/cloudSyncTimestamp.ts';

const now = new Date(2026, 9, 1, 18, 0).getTime();
const exact = (timestamp: number) => new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(timestamp);

test('null and invalid sync timestamps safely display Never', () => {
  for (const timestamp of [null, NaN, Infinity, -Infinity, 8.64e15 + 1]) {
    assert.equal(formatLastSynced(timestamp, now), 'Never');
  }
});

for (const [name, timestamp] of [
  ['today', new Date(2026, 9, 1, 15, 42).getTime()],
  ['previous day', new Date(2026, 8, 30, 15, 42).getTime()],
  ['previous month', new Date(2026, 7, 31, 15, 42).getTime()],
  ['previous year', new Date(2025, 11, 31, 15, 42).getTime()],
  ['epoch', 0],
  ['future timestamp', now + 60_000],
] as const) {
  test(`${name} displays the full date and local time`, () => {
    assert.equal(formatLastSynced(timestamp, now), exact(timestamp));
  });
}

test('recent relative descriptions retain the exact date and time', () => {
  for (const [age, relative] of [[0, 'Just now'], [29_000, 'Just now'], [30_000, '30 seconds ago'],
    [59_000, '59 seconds ago'], [60_000, '1 minute ago'], [120_000, '2 minutes ago'], [3_599_000, '59 minutes ago']] as const) {
    const timestamp = now - age;
    assert.equal(formatLastSynced(timestamp, now), `${relative} · ${exact(timestamp)}`);
  }
  assert.equal(formatLastSynced(now - 3_600_000, now), exact(now - 3_600_000));
});

test('formatting delegates to the runtime locale and default time zone', () => {
  const original = Date.prototype.toLocaleString;
  let call: { locales?: Intl.LocalesArgument; options?: Intl.DateTimeFormatOptions } | undefined;
  Date.prototype.toLocaleString = function (locales, options) {
    call = { locales, options };
    return 'localized date and time';
  };
  try {
    assert.equal(formatLastSynced(now - 3_600_000, now), 'localized date and time');
    assert.equal(call?.locales, undefined);
    assert.equal(call?.options?.timeZone, undefined);
    for (const part of ['year', 'month', 'day', 'hour', 'minute'] as const) assert.ok(call?.options?.[part]);
  } finally { Date.prototype.toLocaleString = original; }
});
