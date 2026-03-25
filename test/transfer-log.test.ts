import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';

// Patch homedir() so transfer-log.ts writes to a temp dir during tests.
// importOriginal keeps all other node:os exports (tmpdir, etc.) intact.
const TEMP_HOME = join(tmpdir(), `chain-fusion-test-${process.pid}`);

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEMP_HOME };
});

// Import after mock is set up
const { appendPending, markSettled, loadPending } = await import('../src/transfer-log.js');

describe('transfer-log', () => {
  beforeEach(async () => {
    await mkdir(join(TEMP_HOME, '.chain-fusion'), { recursive: true });
  });

  afterEach(async () => {
    await rm(TEMP_HOME, { recursive: true, force: true });
  });

  it('loadPending returns empty array when log does not exist', async () => {
    const result = await loadPending();
    expect(result).toEqual([]);
  });

  it('appendPending writes a pending entry', async () => {
    await appendPending({
      id: 'abc123',
      token: 'ckBTC',
      to: 'aaaaa-aa',
      amount: '100000000',
      memo: 1234567890n,
      timestamp: 1000,
    });

    const pending = await loadPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: 'abc123',
      status: 'pending',
      token: 'ckBTC',
      to: 'aaaaa-aa',
      amount: '100000000',
    });
  });

  it('markSettled removes entry from loadPending results', async () => {
    await appendPending({
      id: 'settle-me',
      token: 'ckETH',
      to: 'aaaaa-aa',
      amount: '1000000000000000000',
      memo: 999n,
      timestamp: 1000,
    });

    await markSettled('settle-me', 'settled');

    const pending = await loadPending();
    expect(pending).toHaveLength(0);
  });

  it('markSettled with error status removes entry from pending', async () => {
    await appendPending({
      id: 'fail-me',
      token: 'ckUSDC',
      to: 'aaaaa-aa',
      amount: '1000000',
      memo: 111n,
      timestamp: 1000,
    });

    await markSettled('fail-me', 'error', 'ICP timeout');

    const pending = await loadPending();
    expect(pending).toHaveLength(0);
  });

  it('loadPending returns multiple unsettled entries', async () => {
    await appendPending({ id: 'p1', token: 'ckBTC', to: 'aaaaa-aa', amount: '1', memo: 1n, timestamp: 1000 });
    await appendPending({ id: 'p2', token: 'ckETH', to: 'aaaaa-aa', amount: '2', memo: 2n, timestamp: 2000 });
    await appendPending({ id: 'p3', token: 'ckUSDC', to: 'aaaaa-aa', amount: '3', memo: 3n, timestamp: 3000 });
    await markSettled('p2', 'settled');

    const pending = await loadPending();
    const ids = pending.map((e) => e.id).sort();
    expect(ids).toEqual(['p1', 'p3']);
  });

  it('loadPending survives a corrupt JSONL line without losing other entries', async () => {
    const logPath = join(TEMP_HOME, '.chain-fusion', 'pending.jsonl');
    // Write one valid entry, one corrupt line, one more valid entry
    const valid1 = JSON.stringify({ id: 'good1', status: 'pending', token: 'ckBTC', to: 'aaaaa-aa', amount: '1', memo: '1', timestamp: 1000 });
    const corrupt = '{this is not valid json';
    const valid2 = JSON.stringify({ id: 'good2', status: 'pending', token: 'ckETH', to: 'aaaaa-aa', amount: '2', memo: '2', timestamp: 2000 });
    await writeFile(logPath, [valid1, corrupt, valid2].join('\n') + '\n', 'utf-8');

    const pending = await loadPending();
    const ids = pending.map((e) => e.id).sort();
    expect(ids).toEqual(['good1', 'good2']);
  });

  it('appendPending does not throw on ENOSPC (simulated by making dir a file)', async () => {
    // Make .chain-fusion a file instead of a directory — mkdir will fail
    await rm(join(TEMP_HOME, '.chain-fusion'), { recursive: true, force: true });
    await writeFile(join(TEMP_HOME, '.chain-fusion'), 'not-a-dir', 'utf-8');

    // Should warn to stderr but NOT throw
    await expect(
      appendPending({ id: 'x', token: 'ckBTC', to: 'aaaaa-aa', amount: '1', memo: 1n, timestamp: 1000 }),
    ).resolves.toBeUndefined();
  });
});
