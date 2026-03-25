import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Durable ICRC-1 transfer log.
 *
 * Persists transfer intents to JSONL before each ICP update call so a
 * session timeout does not leave Claude with no record of what was attempted.
 *
 * Entry lifecycle:
 * ─────────────────────────────────────────────────────────────────
 *  appendPending()  →  { status: "pending", id, args, timestamp }
 *                              │
 *               ┌─────────────┴──────────────────┐
 *               │                                 │
 *   markSettled("ok")                  markSettled("error", msg)
 *   { status: "settled" }             { status: "error", error }
 *               │                                 │
 *         (archived)                        (archived)
 *
 * If the process is killed during the ICP call, the entry stays
 * "pending" until a future startup recovery scan resolves it (see
 * TODOS.md: "Add ICRC-1 transfer recovery").
 *
 * Format: newline-delimited JSON (JSONL), one entry per line.
 * Corrupt lines are skipped individually — a single bad write
 * does not lose the rest of the log.
 */

export interface TransferEntry {
  id: string;
  status: 'pending' | 'settled' | 'error';
  token: string;
  to: string;
  amount: string;
  memo: bigint | string;
  timestamp: number;
  error?: string;
}

const LOG_DIR = join(homedir(), '.chain-fusion');
const LOG_FILE = join(LOG_DIR, 'pending.jsonl');

/**
 * Append a pending transfer entry to the log BEFORE the ICP call.
 * Non-fatal: if the write fails (ENOSPC, permissions), logs a warning
 * to stderr but does NOT throw — the transfer proceeds.
 */
export async function appendPending(entry: Omit<TransferEntry, 'status'>): Promise<void> {
  const record: TransferEntry = { ...entry, status: 'pending', memo: entry.memo.toString() };
  const line = JSON.stringify(record) + '\n';
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendLine(LOG_FILE, line);
  } catch (err) {
    // Non-fatal: warn but let the transfer proceed
    process.stderr.write(
      `[chain-fusion] WARNING: Could not write to transfer log (${LOG_FILE}): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Mark an existing pending entry as settled or errored.
 * Appends a settlement record — does not rewrite existing lines.
 * Non-fatal: write failures are warned, not thrown.
 */
export async function markSettled(
  id: string,
  status: 'settled' | 'error',
  error?: string,
): Promise<void> {
  const record = { id, status, timestamp: Date.now(), ...(error ? { error } : {}) };
  const line = JSON.stringify(record) + '\n';
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendLine(LOG_FILE, line);
  } catch (err) {
    process.stderr.write(
      `[chain-fusion] WARNING: Could not update transfer log: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Load all entries that are still pending (no matching settlement record).
 * Parses line-by-line: a corrupt line is skipped without losing the rest.
 */
export async function loadPending(): Promise<TransferEntry[]> {
  let content: string;
  try {
    content = await readFile(LOG_FILE, 'utf-8');
  } catch {
    return []; // File doesn't exist yet — no pending entries
  }

  const entries = new Map<string, TransferEntry>();
  const settled = new Set<string>();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof record.id !== 'string') continue;

      if (record.status === 'pending') {
        entries.set(record.id, record as unknown as TransferEntry);
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
  // Read-then-write is simpler than O_APPEND flag juggling across platforms.
  // For a low-volume audit log this is fine.
  let existing = '';
  try {
    existing = await readFile(filePath, 'utf-8');
  } catch {
    // File doesn't exist yet
  }
  await writeFile(filePath, existing + line, 'utf-8');
}
