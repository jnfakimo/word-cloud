import assert from 'node:assert/strict';
import test from 'node:test';
import { createWeatherReader } from './weather-api.ts';

const primary = { url: 'https://inspection.test/functions/v1/cwa-weather', anonKey: 'local-public-key' };
const fallback = { url: 'https://weather.test/functions/v1/cwa-weather', anonKey: 'cloud-public-key' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('healthy local weather stays on the configured service', async () => {
  const calls: string[] = [];
  const read = createWeatherReader(primary, fallback, async input => {
    calls.push(String(input)); return reply({ ok: true, counties: [{ county: '臺北市', temperature: 28 }] });
  });
  const result = await read<{ counties: unknown[] }>('summary');
  assert.equal(result.usingFallback, false);
  assert.equal(result.counties.length, 1);
  assert.deepEqual(calls, [`${primary.url}?view=summary`]);
});

test('missing configuration uses public weather credentials and keeps the requested county', async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const read = createWeatherReader(primary, fallback, async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return calls.length === 1 ? reply({ ok: false, configured: false }, 503) : reply({ ok: true, towns: [{ town: '萬華區' }] });
  });
  const result = await read<{ towns: unknown[] }>('town', '臺北市');
  assert.equal(result.usingFallback, true);
  assert.equal(result.towns.length, 1);
  assert.equal(calls[1].url.origin, 'https://weather.test');
  assert.equal(calls[1].url.searchParams.get('county'), '臺北市');
  assert.equal(calls[1].url.searchParams.get('view'), 'town');
  for (const [index, call] of calls.entries()) {
    assert.equal(call.init?.credentials, 'omit');
    assert.equal(call.init?.cache, 'no-store');
    assert.deepEqual(call.init?.headers, { apikey: index ? fallback.anonKey : primary.anonKey, Authorization: `Bearer ${index ? fallback.anonKey : primary.anonKey}` });
    assert.ok(call.init?.signal instanceof AbortSignal);
  }
});

test('authorization failures and ordinary outages do not switch services', async () => {
  for (const status of [401, 403, 500, 503]) {
    let calls = 0;
    const read = createWeatherReader(primary, fallback, async () => { calls++; return reply({ ok: false }, status); });
    await assert.rejects(read('summary'), new RegExp(String(status)));
    assert.equal(calls, 1);
  }
});

test('a missing key on the same service does not loop or expose configuration names', async () => {
  let calls = 0;
  const read = createWeatherReader(primary, primary, async () => {
    calls++; return reply({ ok: false, configured: false, message: 'CWA_API_KEY' }, 503);
  });
  await assert.rejects(read('summary'), error => error instanceof Error && !error.message.includes('CWA_API_KEY') && error.message.includes('尚未完成設定'));
  assert.equal(calls, 1);
});

test('fallback non-JSON failures and network timeouts are actionable', async () => {
  let calls = 0;
  const read = createWeatherReader(primary, fallback, async () => {
    calls++; return calls === 1 ? reply({ ok: false, configured: false }, 503) : new Response('<html>Gateway failure</html>', { status: 502 });
  });
  await assert.rejects(read('summary'), /502/);
  assert.equal(calls, 2);
  const disconnected = createWeatherReader(primary, fallback, async () => { throw new DOMException('Aborted', 'AbortError'); });
  await assert.rejects(disconnected('summary'), /連線失敗或逾時/);
});

test('fallback retains stale-cache and partial-source warnings', async () => {
  let calls = 0;
  const read = createWeatherReader(primary, fallback, async () => ++calls === 1
    ? reply({ ok: false, configured: false }, 503)
    : reply({ ok: true, stale: true, updatedAt: '2026-09-06T10:00:00Z', sourceWarnings: ['observation unavailable'] }));
  const result = await read<{ stale: boolean; sourceWarnings: string[] }>('summary');
  assert.equal(result.stale, true);
  assert.deepEqual(result.sourceWarnings, ['observation unavailable']);
});
