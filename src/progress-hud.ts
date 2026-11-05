// Each subagent's % and ETA from the progress-hud mod, which writes one small JSON file per session
// to ~/.claude/progress-hud/sessions/<session id>.json while a prompt runs (rewritten each second).
import { readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentEntry, AgentProgress } from './types.js';

const SHARE_VERSION = 1;
/** A file not rewritten for this long is a run that ended or a session that closed. */
const STALE_MS = 2 * 60_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;
const KEEP_MS = 7 * 24 * 60 * 60_000;

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

export function progressDir(homeDir: string): string {
  return path.join(homeDir, '.claude', 'progress-hud', 'sessions');
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function unitOf(raw: unknown): SharedUnit | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  if (!isStr(u.id) || !isStr(u.status)) return null;
  return {
    id: u.id,
    kind: isStr(u.kind) ? u.kind : '',
    label: isStr(u.label) ? u.label : '',
    status: u.status,
    fraction: isNum(u.fraction) ? Math.min(1, Math.max(0, u.fraction)) : null,
    isEstimate: u.isEstimate === true,
    etaMs: isNum(u.etaMs) && u.etaMs >= 0 ? u.etaMs : null,
    doneN: isNum(u.doneN) ? u.doneN : 0,
    n: isNum(u.n) ? u.n : 0,
    step: isStr(u.step) ? u.step : '',
  };
}

/** This session's file, or null when there is none, it is stale, or it is not a shape this version reads. */
export function readSharedRun(homeDir: string, sessionId: string | undefined, now: number): SharedRun | null {
  if (!sessionId || !/^[\w-]{1,128}$/.test(sessionId)) return null;
  try {
    const data = JSON.parse(readFileSync(path.join(progressDir(homeDir), `${sessionId}.json`), 'utf8')) as Record<string, unknown>;
    if (data?.v !== SHARE_VERSION || !isNum(data.at) || now - data.at > STALE_MS || !Array.isArray(data.agents)) return null;
    return { at: data.at, agents: data.agents.map(unitOf).filter((u): u is SharedUnit => u !== null) };
  } catch {
    return null;
  }
}

function progressOf(u: SharedUnit, at: number, now: number): AgentProgress | undefined {
  if (u.status !== 'running' || u.fraction === null) return undefined;
  return {
    fraction: u.fraction,
    isEstimate: u.isEstimate,
    // The ETA was computed at `at`; the time since comes off it.
    etaMs: u.etaMs === null ? null : Math.max(0, u.etaMs - Math.max(0, now - at)),
    doneN: u.doneN,
    n: u.n,
    step: u.step,
  };
}

/**
 * Sets `progress` on each running agent the file knows: by its agentId, else (a foreground agent
 * before its end, whose id the transcript records only then) by type and description when one agent alone matches.
 */
export function attachAgentProgress(agents: AgentEntry[], run: SharedRun | null, now: number): void {
  if (!run) return;
  const byId = new Map(run.agents.map((u) => [u.id, u]));
  const used = new Set<string>();
  const unmatched: AgentEntry[] = [];
  for (const agent of agents) {
    if (agent.status !== 'running') continue;
    const unit = agent.agentId ? byId.get(agent.agentId) : undefined;
    if (unit) {
      used.add(unit.id);
      agent.progress = progressOf(unit, run.at, now);
    } else if (!agent.agentId) {
      unmatched.push(agent);
    }
  }
  const key = (type: string | undefined, label: string | undefined) => `${type ?? ''}\u0000${label ?? ''}`;
  const free = run.agents.filter((u) => u.id !== 'main' && !used.has(u.id));
  const freeCount = new Map<string, number>();
  for (const u of free) freeCount.set(key(u.kind, u.label), (freeCount.get(key(u.kind, u.label)) ?? 0) + 1);
  const agentCount = new Map<string, number>();
  for (const a of unmatched) agentCount.set(key(a.type, a.description), (agentCount.get(key(a.type, a.description)) ?? 0) + 1);
  for (const agent of unmatched) {
    const k = key(agent.type, agent.description);
    if (freeCount.get(k) !== 1 || agentCount.get(k) !== 1) continue;
    const unit = free.find((u) => key(u.kind, u.label) === k);
    if (unit) agent.progress = progressOf(unit, run.at, now);
  }
}

/** Deletes session files untouched for a week, at most once a day (a marker file keeps the time). */
export function pruneSharedRuns(homeDir: string, now: number): void {
  const dir = progressDir(homeDir);
  const marker = path.join(dir, '.pruned');
  try {
    if (now - statSync(marker).mtimeMs < PRUNE_EVERY_MS) return;
  } catch {
    // no marker yet: prune now
  }
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        if (now - statSync(file).mtimeMs > KEEP_MS) unlinkSync(file);
      } catch {
        // gone already, or not ours to remove
      }
    }
    writeFileSync(marker, '');
    utimesSync(marker, now / 1000, now / 1000);
  } catch {
    // no folder: progress-hud has not written anything
  }
}
