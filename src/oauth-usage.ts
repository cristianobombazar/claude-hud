import * as fs from 'node:fs';
import type { HudConfig } from './config.ts';
import type { ScopedUsageWindow, UsageData } from './types.ts';
import { displayLabel } from './utils/sanitize.ts';

// Per-model weekly usage (e.g. "Current week (Fable)") is not part of the statusline stdin payload.
// Claude Code's /usage screen reads it from the OAuth usage endpoint. collector.mjs holds the token
// and makes that request (the `usage.oauth` probe, cached a minute); this side only parses its answer,
// falling back to the copy Claude Code itself caches in .claude.json.

/** The `usage.oauth` probe's answer: the endpoint's last good payload and when it came, or null. */
export type OAuthUsageAnswer = { fetchedAt: number; payload: unknown } | null | undefined;

// When the endpoint cannot be reached, keep showing the last known windows for this long. Beyond
// that a stale number is worse than no number: weekly usage can move by tens of percent in a few hours.
export const STALE_MAX_MS = 6 * 60 * 60_000;
// The probe refreshes every minute, so an older answer means the endpoint is failing; then
// Claude Code's own copy may be newer.
const FRESH_MS = 2 * 60_000;
const SCOPED_MAX = 8;
const SCOPED_LABEL_MAX_LENGTH = 64;

export interface ScopedUsageSnapshot {
  fetchedAt: number;
  scoped: Array<{ label: string; percent: number; resetsAt: string | null }>;
}

/** The `weekly_scoped` limits in an /api/oauth/usage payload. Untrusted, so bounded and sanitized. */
export function parseScopedLimits(payload: unknown): ScopedUsageSnapshot['scoped'] {
  const limits = (payload as { limits?: unknown } | null)?.limits;
  if (!Array.isArray(limits)) return [];

  const scoped: ScopedUsageSnapshot['scoped'] = [];
  for (const entry of limits) {
    if (scoped.length >= SCOPED_MAX) break;
    if (!entry || typeof entry !== 'object') continue;
    const limit = entry as {
      kind?: unknown;
      percent?: unknown;
      resets_at?: unknown;
      scope?: { model?: { display_name?: unknown } | null } | null;
    };
    if (limit.kind !== 'weekly_scoped') continue;
    const label = displayLabel(limit.scope?.model?.display_name, SCOPED_LABEL_MAX_LENGTH);
    if (!label) continue;
    if (typeof limit.percent !== 'number' || !Number.isFinite(limit.percent)) continue;
    scoped.push({
      label,
      percent: Math.min(100, Math.max(0, Math.round(limit.percent))),
      resetsAt: typeof limit.resets_at === 'string' ? limit.resets_at : null,
    });
  }
  return scoped;
}

/** The probe's answer as a snapshot, or null when it carried nothing usable. */
export function snapshotFromAnswer(answer: OAuthUsageAnswer): ScopedUsageSnapshot | null {
  if (!answer || typeof answer !== 'object' || typeof answer.fetchedAt !== 'number' || !Number.isFinite(answer.fetchedAt)) {
    return null;
  }
  return { fetchedAt: answer.fetchedAt, scoped: parseScopedLimits(answer.payload) };
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

function readClaudeJsonSnapshot(claudeJson: string): ScopedUsageSnapshot | null {
  try {
    return parseClaudeJsonSnapshot(fs.readFileSync(claudeJson, 'utf8'));
  } catch {
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
 * Whether to ask for the `usage.oauth` probe: only for subscriber sessions (usage present) that
 * show model-scoped windows and got none from stdin or the external snapshot.
 */
export function needsOAuthUsage(config: HudConfig, usage: UsageData | null): boolean {
  return !!usage && config.display.showModelScopedUsage && (usage.scopedWindows?.length ?? 0) === 0;
}

/**
 * Fills in usage.scopedWindows from the probe's answer, or from Claude Code's cached /usage answer
 * in .claude.json when that is newer, as long as it is less than STALE_MAX_MS old.
 */
export function withOAuthScopedUsage(
  usage: UsageData | null,
  answer: OAuthUsageAnswer,
  claudeJson: string,
  now: number,
): UsageData | null {
  if (!usage) return usage;
  const fromProbe = snapshotFromAnswer(answer);
  const fresh = fromProbe && now - fromProbe.fetchedAt < FRESH_MS && fromProbe.scoped.length > 0;
  const best = fresh ? fromProbe : pickFreshest([fromProbe, readClaudeJsonSnapshot(claudeJson)], now);
  return best ? { ...usage, scopedWindows: toWindows(best.scoped) } : usage;
}
