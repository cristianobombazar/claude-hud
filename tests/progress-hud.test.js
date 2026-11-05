import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { attachAgentProgress, progressDir, pruneSharedRuns, readSharedRun } from '../dist/progress-hud.js';

const NOW = new Date(2026, 10, 5, 12, 0).getTime();
const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const homes = [];

afterEach(() => {
  while (homes.length) rmSync(homes.pop(), { recursive: true, force: true });
});

function home() {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-hud-progress-'));
  homes.push(dir);
  mkdirSync(progressDir(dir), { recursive: true });
  return dir;
}

const unit = (fields) => ({
  id: 'a1', kind: 'Explore', label: 'map API', status: 'running', startedAt: NOW - 20 * SECOND,
  fraction: 0.5, isEstimate: false, etaMs: 40 * SECOND, doneN: 1, n: 2, step: 'sum up', ...fields,
});
const shared = (agents, fields = {}) => ({
  v: 1, at: NOW - 5 * SECOND, startedAt: NOW - 30 * SECOND, endedAt: 0, main: unit({ id: 'main', kind: 'main', label: '' }), agents, ...fields,
});
const write = (dir, id, data) => writeFileSync(path.join(progressDir(dir), `${id}.json`), JSON.stringify(data));
const agent = (fields) => ({ id: `tool-${fields.agentId ?? fields.description}`, type: 'Explore', description: 'map API', status: 'running', startTime: new Date(NOW - 20 * SECOND), ...fields });

test('reads this session’s file; takes the time since it was written off the ETA', () => {
  const dir = home();
  write(dir, 'sess-1', shared([unit()]));
  const run = readSharedRun(dir, 'sess-1', NOW);
  const agents = [agent({ agentId: 'a1' })];
  attachAgentProgress(agents, run, NOW);
  assert.deepEqual(agents[0].progress, { fraction: 0.5, isEstimate: false, etaMs: 35 * SECOND, doneN: 1, n: 2, step: 'sum up' });
});

test('no file, a stale one, another version, a broken one or an id that is a path: nothing', () => {
  const dir = home();
  assert.equal(readSharedRun(dir, 'none', NOW), null);
  write(dir, 'stale', shared([unit()], { at: NOW - 3 * 60 * SECOND }));
  assert.equal(readSharedRun(dir, 'stale', NOW), null);
  write(dir, 'v2', shared([unit()], { v: 2 }));
  assert.equal(readSharedRun(dir, 'v2', NOW), null);
  writeFileSync(path.join(progressDir(dir), 'broken.json'), '{nope');
  assert.equal(readSharedRun(dir, 'broken', NOW), null);
  assert.equal(readSharedRun(dir, '../sessions/x', NOW), null);
  assert.equal(readSharedRun(dir, undefined, NOW), null);
});

test('an agent without its id yet matches by type and description, only when one alone matches', () => {
  const dir = home();
  write(dir, 's', shared([unit(), unit({ id: 'a2', label: 'twin', fraction: 0.1 }), unit({ id: 'a3', label: 'twin', fraction: 0.9 })]));
  const run = readSharedRun(dir, 's', NOW);
  const agents = [agent({}), agent({ description: 'twin' }), agent({ description: 'twin', id: 'tool-twin-2' })];
  attachAgentProgress(agents, run, NOW);
  assert.equal(agents[0].progress?.fraction, 0.5);
  assert.equal(agents[1].progress, undefined, 'two agents share the description: no guess');
  assert.equal(agents[2].progress, undefined);
});

test('a finished unit, one with no % yet, and a finished agent get no progress', () => {
  const dir = home();
  write(dir, 's', shared([unit({ status: 'done' }), unit({ id: 'a2', fraction: null })]));
  const run = readSharedRun(dir, 's', NOW);
  const agents = [agent({ agentId: 'a1' }), agent({ agentId: 'a2' }), agent({ agentId: 'a1', status: 'completed' })];
  attachAgentProgress(agents, run, NOW);
  assert.deepEqual(agents.map((a) => a.progress), [undefined, undefined, undefined]);
});

test('files untouched for a week are deleted, at most once a day', () => {
  const dir = home();
  write(dir, 'old', shared([]));
  write(dir, 'new', shared([]));
  const old = path.join(progressDir(dir), 'old.json');
  utimesSync(old, (NOW - 8 * DAY) / 1000, (NOW - 8 * DAY) / 1000);
  pruneSharedRuns(dir, NOW);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(path.join(progressDir(dir), 'new.json')), true);
  write(dir, 'old', shared([]));
  utimesSync(old, (NOW - 8 * DAY) / 1000, (NOW - 8 * DAY) / 1000);
  pruneSharedRuns(dir, NOW + 60 * SECOND);
  assert.equal(existsSync(old), true, 'pruned less than a day ago');
  pruneSharedRuns(path.join(dir, 'missing-home'), NOW); // no folder: no throw
});
