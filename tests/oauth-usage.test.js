import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG } from '../src/config.ts';
import * as logic from '../src/oauth-usage.ts';
import { keychainServiceName, oauthUsage, tokenFromCredentials } from '../collector.mjs';

// Both halves: collector.mjs holds the token, calls the endpoint and caches its answer; logic parses it.

const PAYLOAD = {
  limits: [
    { kind: 'weekly', percent: 40 },
    { kind: 'weekly_scoped', percent: 12.6, resets_at: '2026-11-20T00:00:00Z', scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly_scoped', percent: 'x', scope: { model: { display_name: 'Bad' } } },
  ],
};
const USAGE = { fiveHour: 10, sevenDay: 20, fiveHourResetAt: null, sevenDayResetAt: null };

async function withHudDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'claude-hud-oauth-'));
  try {
    return await fn({ hudDir: dir, configDir: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { ok: next.ok ?? true, text: async () => JSON.stringify(next.body) };
  };
  return { fetchImpl, calls };
}

test('parseScopedLimits keeps weekly_scoped entries with a label and a numeric percent', () => {
  assert.deepEqual(logic.parseScopedLimits(PAYLOAD), [{ label: 'Fable', percent: 13, resetsAt: '2026-11-20T00:00:00Z' }]);
  assert.deepEqual(logic.parseScopedLimits(null), []);
  assert.deepEqual(logic.parseScopedLimits({ limits: 'nope' }), []);
});

test('parseScopedLimits strips control characters from labels', () => {
  const scoped = logic.parseScopedLimits({ limits: [{ kind: 'weekly_scoped', percent: 1, scope: { model: { display_name: 'Fa\u001b[31mble' } } }] });
  assert.equal(scoped.length, 1);
  assert.ok(!scoped[0].label.includes('\u001b'));
});

test('needsOAuthUsage only for subscriber usage without scoped windows', () => {
  assert.equal(logic.needsOAuthUsage(DEFAULT_CONFIG, null), false);
  assert.equal(logic.needsOAuthUsage(DEFAULT_CONFIG, USAGE), true);
  assert.equal(logic.needsOAuthUsage(DEFAULT_CONFIG, { ...USAGE, scopedWindows: [{ label: 'X', percent: 1, resetAt: null }] }), false);
  const off = { ...DEFAULT_CONFIG, display: { ...DEFAULT_CONFIG.display, showModelScopedUsage: false } };
  assert.equal(logic.needsOAuthUsage(off, USAGE), false);
});

test('withOAuthScopedUsage fills scopedWindows from a fresh answer', () => {
  const now = Date.parse('2026-11-16T00:00:00Z');
  const usage = logic.withOAuthScopedUsage(USAGE, { fetchedAt: now - 1000, payload: PAYLOAD }, '/nonexistent/.claude.json', now);
  assert.deepEqual(usage.scopedWindows, [{ label: 'Fable', percent: 13, resetAt: new Date('2026-11-20T00:00:00Z') }]);
});

test('withOAuthScopedUsage prefers a newer .claude.json copy over a stale answer, and drops anything too old', async () => {
  await withHudDir(async ({ hudDir }) => {
    const now = Date.parse('2026-11-16T00:00:00Z');
    const claudeJson = path.join(hudDir, '.claude.json');
    const utilization = { limits: [{ kind: 'weekly_scoped', percent: 55, scope: { model: { display_name: 'Fable' } } }] };
    await writeFile(claudeJson, JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: now - 10 * 60_000, utilization } }));
    const stale = { fetchedAt: now - 60 * 60_000, payload: PAYLOAD };
    assert.equal(logic.withOAuthScopedUsage(USAGE, stale, claudeJson, now).scopedWindows[0].percent, 55);

    const ancient = { fetchedAt: now - logic.STALE_MAX_MS - 1, payload: PAYLOAD };
    assert.equal(logic.withOAuthScopedUsage(USAGE, ancient, '/nonexistent/.claude.json', now).scopedWindows, undefined);
  });
});

test('keychainServiceName and tokenFromCredentials', () => {
  assert.equal(keychainServiceName(), 'Claude Code-credentials');
  assert.match(keychainServiceName('/Users/me/.claude-work'), /^Claude Code-credentials-[0-9a-f]{8}$/);
  const now = 1_000_000;
  assert.equal(tokenFromCredentials(JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: now + 1 } }), now), 'tok');
  assert.equal(tokenFromCredentials(JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: now } }), now), null);
  assert.equal(tokenFromCredentials('not json', now), null);
});

test('oauthUsage fetches once, serves the cache for a minute, then refetches', async () => {
  await withHudDir(async (paths) => {
    const { fetchImpl, calls } = fakeFetch([{ body: PAYLOAD }, { body: { limits: [] } }]);
    const readToken = async () => 'tok';
    const env = {};
    const first = await oauthUsage({ env, paths, now: 1_000_000, fetchImpl, readToken });
    assert.deepEqual(first, { fetchedAt: 1_000_000, payload: PAYLOAD });
    assert.deepEqual(calls, [{ url: 'https://api.anthropic.com/api/oauth/usage', auth: 'Bearer tok' }]);

    assert.deepEqual(await oauthUsage({ env, paths, now: 1_030_000, fetchImpl, readToken }), first);
    assert.equal(calls.length, 1);

    assert.deepEqual(await oauthUsage({ env, paths, now: 1_070_000, fetchImpl, readToken }), { fetchedAt: 1_070_000, payload: { limits: [] } });
    assert.equal(calls.length, 2);
  });
});

test('oauthUsage keeps the last answer after a failure and backs off before retrying', async () => {
  await withHudDir(async (paths) => {
    const { fetchImpl, calls } = fakeFetch([{ body: PAYLOAD }, new Error('offline'), { body: PAYLOAD }]);
    const readToken = async () => 'tok';
    await oauthUsage({ env: {}, paths, now: 0, fetchImpl, readToken });
    assert.deepEqual(await oauthUsage({ env: {}, paths, now: 120_000, fetchImpl, readToken }), { fetchedAt: 0, payload: PAYLOAD });
    assert.deepEqual(await oauthUsage({ env: {}, paths, now: 130_000, fetchImpl, readToken }), { fetchedAt: 0, payload: PAYLOAD });
    assert.equal(calls.length, 2);
    assert.deepEqual(await oauthUsage({ env: {}, paths, now: 151_000, fetchImpl, readToken }), { fetchedAt: 151_000, payload: PAYLOAD });
    assert.equal(calls.length, 3);
  });
});

test('oauthUsage without a token or when disabled asks nothing', async () => {
  await withHudDir(async (paths) => {
    const { fetchImpl, calls } = fakeFetch([]);
    assert.equal(await oauthUsage({ env: {}, paths, now: 0, fetchImpl, readToken: async () => null }), null);
    assert.equal(await oauthUsage({ env: { CLAUDE_HUD_DISABLE_OAUTH_USAGE: '1' }, paths, now: 0, fetchImpl, readToken: async () => 'tok' }), null);
    assert.equal(calls.length, 0);
  });
});
