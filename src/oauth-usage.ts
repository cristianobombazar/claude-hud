// Per-model weekly usage (e.g. "Current week (Fable)") is not part of the
// statusline stdin payload. Claude Code's /usage screen reads it from the
// OAuth usage endpoint, so we do the same, cached on disk because the
// statusline is invoked every ~300ms.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getClaudeConfigDir, getClaudeConfigJsonPath, getHudPluginDir } from './claude-config-dir.js';
import { createDebug } from './debug.js';
import type { HudConfig } from './config.js';
import type { ScopedUsageWindow, UsageData } from './types.js';

const debug = createDebug('oauth-usage');
const execFileAsync = promisify(execFile);

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_TTL_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 30_000;
const FETCH_TIMEOUT_MS = 3_000;
// When the endpoint cannot be reached, keep showing the last known windows for
// this long. Beyond that a stale number is worse than no number: weekly usage
// can move by tens of percent in a few hours.
export const STALE_MAX_MS = 6 * 60 * 60_000;

export interface ScopedUsageSnapshot {
  fetchedAt: number;
  scoped: Array<{ label: string; percent: number; resetsAt: string | null }>;
}

interface UsageCache extends ScopedUsageSnapshot {
  // Set after a failed fetch: do not hit the endpoint again before this time.
  retryAfter?: number;
}

function getCachePath(): string {
  return path.join(getHudPluginDir(os.homedir()), 'usage-cache.json');
}

async function readCache(cachePath: string): Promise<UsageCache | null> {
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UsageCache>;
    if (typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.scoped)) {
      return null;
    }
    return {
      fetchedAt: parsed.fetchedAt,
      scoped: parsed.scoped,
      ...(typeof parsed.retryAfter === 'number' ? { retryAfter: parsed.retryAfter } : {}),
    };
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, cache: UsageCache): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(cache), 'utf8');
  } catch (error) {
    debug('failed to write cache', error);
  }
}

/**
 * The macOS keychain item Claude Code stores its login under. Without
 * CLAUDE_CONFIG_DIR it is "Claude Code-credentials"; with one, Claude Code
 * appends the first 8 hex chars of sha256(configDir) so that each config dir
 * (e.g. one per Head Terminal profile) keeps its own login.
 */
export function keychainServiceName(configDir?: string): string {
  if (configDir === undefined) {
    return 'Claude Code-credentials';
  }
  const suffix = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}

/**
 * The access token in a credentials blob (keychain item or .credentials.json),
 * or null when there is none or it has already expired.
 */
export function tokenFromCredentials(raw: string, now: number = Date.now()): string | null {
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    const token = oauth?.accessToken;
    if (typeof token !== 'string' || !token) return null;
    const expiresAt = oauth?.expiresAt;
    if (typeof expiresAt === 'number' && expiresAt > 0 && expiresAt <= now) {
      debug('credentials expired at', new Date(expiresAt).toISOString());
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

async function readKeychainItem(service: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: 2_000 },
    );
    return stdout.trim() || null;
  } catch (error) {
    debug('keychain read failed for', service, error);
    return null;
  }
}

async function readOAuthToken(now: number): Promise<string | null> {
  const envConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim();

  // macOS: Claude Code stores credentials in the login keychain, under a name
  // derived from CLAUDE_CONFIG_DIR. Try the matching item first; the unsuffixed
  // one belongs to the default ~/.claude login and is only a fallback.
  if (process.platform === 'darwin') {
    const services = envConfigDir
      ? [keychainServiceName(envConfigDir), keychainServiceName()]
      : [keychainServiceName()];
    for (const service of services) {
      const raw = await readKeychainItem(service);
      const token = raw ? tokenFromCredentials(raw, now) : null;
      if (token) return token;
    }
  }

  // Linux / fallback: plain credentials file in the Claude config dir.
  try {
    const credPath = path.join(getClaudeConfigDir(os.homedir()), '.credentials.json');
    const token = tokenFromCredentials(await fs.readFile(credPath, 'utf8'), now);
    if (token) return token;
  } catch (error) {
    debug('credentials file read failed', error);
  }

  return null;
}

export function parseScopedLimits(payload: unknown): ScopedUsageSnapshot['scoped'] {
  const limits = (payload as { limits?: unknown })?.limits;
  if (!Array.isArray(limits)) return [];

  const scoped: ScopedUsageSnapshot['scoped'] = [];
  for (const entry of limits) {
    if (!entry || typeof entry !== 'object') continue;
    const limit = entry as {
      kind?: unknown;
      percent?: unknown;
      resets_at?: unknown;
      scope?: { model?: { display_name?: unknown } | null } | null;
    };
    if (limit.kind !== 'weekly_scoped') continue;
    const label = limit.scope?.model?.display_name;
    if (typeof label !== 'string' || !label) continue;
    if (typeof limit.percent !== 'number' || !Number.isFinite(limit.percent)) continue;
    scoped.push({
      label,
      percent: Math.min(100, Math.max(0, Math.round(limit.percent))),
      resetsAt: typeof limit.resets_at === 'string' ? limit.resets_at : null,
    });
  }
  return scoped;
}

/**
 * The last /usage answer Claude Code itself cached in .claude.json
 * (`cachedUsageUtilization`), as a snapshot. Null when absent or malformed.
 */
export function parseClaudeJsonSnapshot(raw: string): ScopedUsageSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as {
      cachedUsageUtilization?: { fetchedAtMs?: unknown; utilization?: unknown } | null;
    };
    const snapshot = parsed?.cachedUsageUtilization;
    if (!snapshot || typeof snapshot !== 'object') return null;
    if (typeof snapshot.fetchedAtMs !== 'number' || !Number.isFinite(snapshot.fetchedAtMs)) {
      return null;
    }
    return { fetchedAt: snapshot.fetchedAtMs, scoped: parseScopedLimits(snapshot.utilization) };
  } catch {
    return null;
  }
}

async function readClaudeJsonSnapshot(): Promise<ScopedUsageSnapshot | null> {
  try {
    return parseClaudeJsonSnapshot(await fs.readFile(getClaudeConfigJsonPath(os.homedir()), 'utf8'));
  } catch (error) {
    debug('claude.json snapshot read failed', error);
    return null;
  }
}

/**
 * Picks the freshest of several snapshots, provided it is not older than
 * STALE_MAX_MS. Returns null when nothing recent enough is available.
 */
export function pickFreshest(
  snapshots: Array<ScopedUsageSnapshot | null>,
  now: number,
): ScopedUsageSnapshot | null {
  let best: ScopedUsageSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (!snapshot || snapshot.scoped.length === 0) continue;
    if (now - snapshot.fetchedAt > STALE_MAX_MS) continue;
    if (!best || snapshot.fetchedAt > best.fetchedAt) best = snapshot;
  }
  return best;
}

async function fetchScopedLimits(token: string): Promise<ScopedUsageSnapshot['scoped'] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      debug('usage endpoint returned', response.status);
      return null;
    }
    return parseScopedLimits(await response.json());
  } catch (error) {
    debug('usage fetch failed', error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toWindows(scoped: ScopedUsageSnapshot['scoped']): ScopedUsageWindow[] {
  return scoped.map((entry) => {
    const resetsAt = entry.resetsAt ? new Date(entry.resetsAt) : null;
    return {
      label: entry.label,
      percent: entry.percent,
      resetAt: resetsAt && Number.isFinite(resetsAt.getTime()) ? resetsAt : null,
    };
  });
}

/**
 * Returns per-model weekly windows (e.g. Fable) from the OAuth usage endpoint,
 * served from a 60s on-disk cache. When the endpoint cannot be reached, falls
 * back to the freshest of the HUD cache and Claude Code's own cached /usage
 * answer, as long as it is less than STALE_MAX_MS old. Never throws; returns
 * [] when nothing usable is available.
 */
export async function getScopedUsage(now: number = Date.now()): Promise<ScopedUsageWindow[]> {
  if (process.env.CLAUDE_HUD_DISABLE_OAUTH_USAGE === '1') {
    return [];
  }

  const cachePath = getCachePath();
  const cached = await readCache(cachePath);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return toWindows(cached.scoped);
  }

  const fallback = async (): Promise<ScopedUsageWindow[]> => {
    const best = pickFreshest([cached, await readClaudeJsonSnapshot()], now);
    return best ? toWindows(best.scoped) : [];
  };

  // Backing off after a recent failure: serve what we have, do not retry yet.
  if (cached?.retryAfter !== undefined && now < cached.retryAfter) {
    return fallback();
  }

  const token = await readOAuthToken(now);
  const scoped = token ? await fetchScopedLimits(token) : null;
  if (scoped) {
    await writeCache(cachePath, { fetchedAt: now, scoped });
    return toWindows(scoped);
  }

  // Keep the stale data (and its real fetch time, so staleness stays known),
  // but back off so we don't retry every 300ms.
  await writeCache(cachePath, {
    fetchedAt: cached?.fetchedAt ?? 0,
    scoped: cached?.scoped ?? [],
    retryAfter: now + RETRY_AFTER_FAILURE_MS,
  });
  return fallback();
}

/**
 * Fills in the per-model windows from the OAuth usage endpoint when neither stdin
 * nor the external snapshot carried any. Only for subscriber sessions, i.e. when
 * stdin brought rate limits.
 */
export async function withOAuthScopedUsage(
  config: HudConfig,
  usage: UsageData | null,
  now: number = Date.now(),
): Promise<UsageData | null> {
  if (!usage || !config.display.showModelScopedUsage || (usage.scopedWindows?.length ?? 0) > 0) {
    return usage;
  }
  const scopedWindows = await getScopedUsage(now);
  return scopedWindows.length > 0 ? { ...usage, scopedWindows } : usage;
}
