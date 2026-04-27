import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  mineChurn,
  getGitHead,
  readFileLoc,
  MAX_FILES_PER_COMMIT,
  LAST_MINED_CHURN_HEAD_KEY,
} from '../src/churn';

let HAS_GIT = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  HAS_GIT = false;
}

let tempDir: string;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: tempDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE,
      GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function commitAt(date: string, paths: string[], content?: string) {
  for (const p of paths) {
    const abs = path.join(tempDir, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content ?? `data for ${p} at ${date}\n`);
  }
  git('add', ...paths);
  // Pin both author and committer dates so timestamps are deterministic.
  process.env.GIT_AUTHOR_DATE = date;
  process.env.GIT_COMMITTER_DATE = date;
  git('commit', '-m', `commit at ${date}`);
  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-churn-'));
  if (HAS_GIT) {
    git('init', '-q', '-b', 'main');
    git('config', 'commit.gpgsign', 'false');
  }
});

afterEach(() => {
  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe.skipIf(!HAS_GIT)('mineChurn', () => {
  it('returns empty + null head when not in a git repo', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nogit-'));
    try {
      const r = mineChurn(nonGit, new Set(['foo.ts']), null);
      expect(r.currentHead).toBeNull();
      expect(r.deltas.size).toBe(0);
      expect(r.needsFullRescan).toBe(false);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('counts commits per indexed file, ignores files not in index', () => {
    commitAt('2025-01-01T00:00:00', ['a.ts', 'b.ts']);
    commitAt('2025-01-02T00:00:00', ['a.ts']);
    commitAt('2025-01-03T00:00:00', ['a.ts', 'b.ts', 'c.ts']);

    const r = mineChurn(tempDir, new Set(['a.ts', 'b.ts']), null);
    expect(r.deltas.get('a.ts')?.commitCountDelta).toBe(3);
    expect(r.deltas.get('b.ts')?.commitCountDelta).toBe(2);
    expect(r.deltas.has('c.ts')).toBe(false);
  });

  it('records first-seen / last-touched as min/max of commit timestamps', () => {
    commitAt('2025-01-01T00:00:00Z', ['a.ts']);
    commitAt('2025-06-01T00:00:00Z', ['a.ts']);
    commitAt('2025-12-01T00:00:00Z', ['a.ts']);

    const r = mineChurn(tempDir, new Set(['a.ts']), null);
    const d = r.deltas.get('a.ts')!;
    // 2025-01-01 UTC = 1735689600
    expect(d.firstSeenTs).toBe(1735689600);
    // 2025-12-01 UTC = 1764547200
    expect(d.lastTouchedTs).toBe(1764547200);
  });

  it('skips commits touching more than MAX_FILES_PER_COMMIT files', () => {
    const bigBatch: string[] = [];
    for (let i = 0; i < MAX_FILES_PER_COMMIT + 1; i++) bigBatch.push(`f${i}.ts`);
    commitAt('2025-01-01T00:00:00Z', bigBatch);
    // Then a normal commit on one of the same files.
    commitAt('2025-02-01T00:00:00Z', ['f0.ts']);

    const r = mineChurn(tempDir, new Set(bigBatch), null);
    // First commit was skipped; only the second one should count.
    expect(r.deltas.get('f0.ts')?.commitCountDelta).toBe(1);
    // Files only seen in the skipped commit produce no delta at all.
    expect(r.deltas.has('f50.ts')).toBe(false);
  });

  it('incremental mining returns only commits since the given sha', () => {
    commitAt('2025-01-01T00:00:00Z', ['a.ts']);
    const sha1 = getGitHead(tempDir)!;
    commitAt('2025-01-02T00:00:00Z', ['a.ts']);
    commitAt('2025-01-03T00:00:00Z', ['a.ts']);

    const incr = mineChurn(tempDir, new Set(['a.ts']), sha1);
    // Only the two commits *after* sha1 should be counted.
    expect(incr.deltas.get('a.ts')?.commitCountDelta).toBe(2);
    expect(incr.needsFullRescan).toBe(false);
  });

  it('returns needsFullRescan=true when sinceSha is unreachable', () => {
    commitAt('2025-01-01T00:00:00Z', ['a.ts']);
    const fakeSha = '0'.repeat(40);
    const r = mineChurn(tempDir, new Set(['a.ts']), fakeSha);
    expect(r.needsFullRescan).toBe(true);
    expect(r.deltas.size).toBe(0);
    expect(r.currentHead).not.toBeNull();
  });

  it('returns empty deltas when sinceSha equals current head (no-op)', () => {
    commitAt('2025-01-01T00:00:00Z', ['a.ts']);
    const head = getGitHead(tempDir)!;
    const r = mineChurn(tempDir, new Set(['a.ts']), head);
    expect(r.currentHead).toBe(head);
    expect(r.deltas.size).toBe(0);
    expect(r.needsFullRescan).toBe(false);
  });

  it('handles paths with spaces and unicode safely (NUL-delimited)', () => {
    commitAt('2025-01-01T00:00:00Z', ['name with space.ts']);
    commitAt('2025-01-02T00:00:00Z', ['ünïcødë.ts']);

    const r = mineChurn(
      tempDir,
      new Set(['name with space.ts', 'ünïcødë.ts']),
      null
    );
    expect(r.deltas.get('name with space.ts')?.commitCountDelta).toBe(1);
    expect(r.deltas.get('ünïcødë.ts')?.commitCountDelta).toBe(1);
  });

  it('LAST_MINED_CHURN_HEAD_KEY is stable (used as project_metadata key)', () => {
    expect(LAST_MINED_CHURN_HEAD_KEY).toBe('last_mined_churn_head');
  });
});

describe('readFileLoc', () => {
  it('returns 0 for an empty file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-loc-'));
    try {
      const f = path.join(dir, 'empty.txt');
      fs.writeFileSync(f, '');
      expect(readFileLoc(dir, 'empty.txt')).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts newline-terminated lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-loc-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.txt'), 'a\nb\nc\n');
      expect(readFileLoc(dir, 'x.txt')).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a final no-newline chunk as one extra line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-loc-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.txt'), 'a\nb\nc');
      expect(readFileLoc(dir, 'x.txt')).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 0 for a missing file (does not throw)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-loc-'));
    try {
      expect(readFileLoc(dir, 'no-such-file.txt')).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
