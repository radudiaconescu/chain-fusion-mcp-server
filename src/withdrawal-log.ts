import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Durable ckBTC withdrawal log.
 *
 * Persists withdrawal intents to JSONL before each ICP update call so a
 * session timeout does not leave Claude with no record of what was attempted.
 *
 * Entry lifecycle:
 * ─────────────────────────────────────────────────────────────────
 *  appendPending()  →  { status: "pending", id, btc_address, amount_satoshi, timestamp }
 *                              │
 *               ┌─────────────┴──────────────────┐
 *               │                                 │
 *   markSettled("settled", block_index)  markSettled("error", msg)
 *   { status: "settled", block_index }  { status: "error", error }
 *               │                                 │
 *         (archived)                        (archived)
 *
 * If the process is killed during the ICP call, the entry stays
 * "pending" until a future startup recovery scan resolves it (see
 * TODOS.md: "Add ckBTC withdrawal startup recovery").
 *
 * Format: newline-delimited JSON (JSONL), one entry per line.
 * Corrupt lines are skipped individually — a single bad write
 * does not lose the rest of the log.
 */

export interface WithdrawalEntry {
  id: string;
  status: 'pending' | 'settled' | 'error';
  btc_address: string;
  amount_satoshi: string;
  block_index?: string;
  timestamp: number;
  error?: string;
}

const LOG_DIR = join(homedir(), '.chain-fusion');
const LOG_FILE = join(LOG_DIR, 'withdrawals.jsonl');

/**
 * Append a pending withdrawal entry to the log BEFORE the ICP call.
 * Non-fatal: if the write fails (ENOSPC, permissions), logs a warning
 * to stderr but does NOT throw — the withdrawal proceeds.
 */
export async function appendWithdrawalPending(
  entry: Omit<WithdrawalEntry, 'status'>,
): Promise<void> {
  const record: WithdrawalEntry = { ...entry, status: 'pending' };
  const line = JSON.stringify(record) + '\n';
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendLine(LOG_FILE, line);
  } catch (err) {
    process.stderr.write(
      `[chain-fusion] WARNING: Could not write to withdrawal log (${LOG_FILE}): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Mark an existing pending withdrawal as settled or errored.
 * Appends a settlement record — does not rewrite existing lines.
 * Non-fatal: write failures are warned, not thrown.
 */
export async function markWithdrawalSettled(
  id: string,
  status: 'settled' | 'error',
  extra?: { block_index?: string; error?: string },
): Promise<void> {
  const record = { id, status, timestamp: Date.now(), ...extra };
  const line = JSON.stringify(record) + '\n';
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendLine(LOG_FILE, line);
  } catch (err) {
    process.stderr.write(
      `[chain-fusion] WARNING: Could not update withdrawal log: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Load all entries that are still pending (no matching settlement record).
 * Parses line-by-line: a corrupt line is skipped without losing the rest.
 */
export async function loadPendingWithdrawals(): Promise<WithdrawalEntry[]> {
  let content: string;
  try {
    content = await readFile(LOG_FILE, 'utf-8');
  } catch {
    return []; // File doesn't exist yet — no pending entries
  }

  const entries = new Map<string, WithdrawalEntry>();
  const settled = new Set<string>();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof record.id !== 'string') continue;

      if (record.status === 'pending') {
        entries.set(record.id, record as unknown as WithdrawalEntry);
      } else if (record.status === 'settled' || record.status === 'error') {
        settled.add(record.id);
      }
    } catch {
      // Corrupt line — skip silently (partial write during crash)
    }
  }

  return Array.from(entries.values()).filter((e) => !settled.has(e.id));
}

async function appendLine(filePath: string, line: string): Promise<void> {
  let existing = '';
  try {
    existing = await readFile(filePath, 'utf-8');
  } catch {
    // File doesn't exist yet
  }
  await writeFile(filePath, existing + line, 'utf-8');
}
