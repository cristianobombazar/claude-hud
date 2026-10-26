import type { HudConfig } from './config.js';
import type { ScopedUsageWindow, UsageData } from './types.js';
export declare const STALE_MAX_MS: number;
export interface ScopedUsageSnapshot {
    fetchedAt: number;
    scoped: Array<{
        label: string;
        percent: number;
        resetsAt: string | null;
    }>;
}
/**
 * The macOS keychain item Claude Code stores its login under. Without
 * CLAUDE_CONFIG_DIR it is "Claude Code-credentials"; with one, Claude Code
 * appends the first 8 hex chars of sha256(configDir) so that each config dir
 * (e.g. one per Head Terminal profile) keeps its own login.
 */
export declare function keychainServiceName(configDir?: string): string;
/**
 * The access token in a credentials blob (keychain item or .credentials.json),
 * or null when there is none or it has already expired.
 */
export declare function tokenFromCredentials(raw: string, now?: number): string | null;
export declare function parseScopedLimits(payload: unknown): ScopedUsageSnapshot['scoped'];
/**
 * The last /usage answer Claude Code itself cached in .claude.json
 * (`cachedUsageUtilization`), as a snapshot. Null when absent or malformed.
 */
export declare function parseClaudeJsonSnapshot(raw: string): ScopedUsageSnapshot | null;
/**
 * Picks the freshest of several snapshots, provided it is not older than
 * STALE_MAX_MS. Returns null when nothing recent enough is available.
 */
export declare function pickFreshest(snapshots: Array<ScopedUsageSnapshot | null>, now: number): ScopedUsageSnapshot | null;
/**
 * Returns per-model weekly windows (e.g. Fable) from the OAuth usage endpoint,
 * served from a 60s on-disk cache. When the endpoint cannot be reached, falls
 * back to the freshest of the HUD cache and Claude Code's own cached /usage
 * answer, as long as it is less than STALE_MAX_MS old. Never throws; returns
 * [] when nothing usable is available.
 */
export declare function getScopedUsage(now?: number): Promise<ScopedUsageWindow[]>;
/**
 * Fills in the per-model windows from the OAuth usage endpoint when neither stdin
 * nor the external snapshot carried any. Only for subscriber sessions, i.e. when
 * stdin brought rate limits.
 */
export declare function withOAuthScopedUsage(config: HudConfig, usage: UsageData | null, now?: number): Promise<UsageData | null>;
//# sourceMappingURL=oauth-usage.d.ts.map