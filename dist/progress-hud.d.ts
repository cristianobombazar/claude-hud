import type { AgentEntry } from './types.js';
interface SharedUnit {
    id: string;
    kind: string;
    label: string;
    status: string;
    fraction: number | null;
    isEstimate: boolean;
    etaMs: number | null;
    doneN: number;
    n: number;
    step: string;
}
export interface SharedRun {
    at: number;
    agents: SharedUnit[];
}
export declare function progressDir(homeDir: string): string;
/** This session's file, or null when there is none, it is stale, or it is not a shape this version reads. */
export declare function readSharedRun(homeDir: string, sessionId: string | undefined, now: number): SharedRun | null;
/**
 * Sets `progress` on each running agent the file knows: by its agentId, else (a foreground agent
 * before its end, whose id the transcript records only then) by type and description when one agent alone matches.
 */
export declare function attachAgentProgress(agents: AgentEntry[], run: SharedRun | null, now: number): void;
/** Deletes session files untouched for a week, at most once a day (a marker file keeps the time). */
export declare function pruneSharedRuns(homeDir: string, now: number): void;
export {};
//# sourceMappingURL=progress-hud.d.ts.map