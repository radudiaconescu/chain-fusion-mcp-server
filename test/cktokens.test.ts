import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { HttpAgent } from '@icp-sdk/core/agent';
import { initCache } from '../src/cache.js';

// vi.mock is hoisted — define shared mock fns with vi.hoisted() so they're
// available both in the factory and in test assertions.
const { mockBalance, mockTransfer, mockAppendPending, mockMarkSettled } = vi.hoisted(() => ({
  mockBalance: vi.fn(),
  mockTransfer: vi.fn(),
  mockAppendPending: vi.fn().mockResolvedValue(undefined),
  mockMarkSettled: vi.fn().mockResolvedValue(undefined),
}));

// ─── Mock @icp-sdk/canisters/ledger/icrc ─────────────────────────────────────
vi.mock('@icp-sdk/canisters/ledger/icrc', () => ({
  IcrcLedgerCanister: {
    create: vi.fn(() => ({
      balance: mockBalance,
      transfer: mockTransfer,
    })),
  },
}));

// ─── Mock @icp-sdk/core/principal ────────────────────────────────────────────
vi.mock('@icp-sdk/core/principal', () => ({
  Principal: {
    fromText: vi.fn((text: string) => {
      if (text === 'invalid-principal') {
        throw new Error('Principal format error');
      }
      return { toString: () => text };
    }),
  },
}));

// ─── Mock transfer-log so we don't hit the filesystem ────────────────────────
vi.mock('../src/transfer-log.js', () => ({
  appendPending: mockAppendPending,
  markSettled: mockMarkSettled,
  loadPending: vi.fn().mockResolvedValue([]),
}));

import { registerCkTokenTools } from '../src/tools/cktokens.js';
import { CyclesBudget } from '../src/cycles-budget.js';

const mockAgent = {} as HttpAgent;

function makeServer(opts?: { budget?: CyclesBudget }) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerCkTokenTools(server, mockAgent, opts);
  return server;
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const registry = (server as unknown as {
    _registeredTools: Record<string, { handler: (args: unknown, extra: object) => Promise<{ content: Array<{ type: string; text: string }> }> }>;
  })._registeredTools;

  const tool = registry[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);

  const result = await tool.handler(args, {});
  return result.content[0].text;
}

// ─── cktoken_get_balance ───────────────────────────────────────────────────────

describe('cktoken_get_balance', () => {
  beforeEach(() => {
    initCache(60_000);
    mockBalance.mockReset();
    mockTransfer.mockReset();
    mockAppendPending.mockReset().mockResolvedValue(undefined);
    mockMarkSettled.mockReset().mockResolvedValue(undefined);
  });

  it('returns formatted balance for ckBTC (8 decimals)', async () => {
    mockBalance.mockResolvedValueOnce(150_000_000n); // 1.5 ckBTC

    const result = await callTool(makeServer(), 'cktoken_get_balance', {
      token: 'ckBTC',
      principal: 'aaaaa-aa',
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.balance_raw).toBe('150000000');
    expect(data.balance_formatted).toBe('1.50000000');
    expect(data.token).toBe('ckBTC');
  });

  it('returns formatted balance for ckETH (18 decimals)', async () => {
    mockBalance.mockResolvedValueOnce(10_000_000_000_000_000_000n); // 10 ckETH

    const result = await callTool(makeServer(), 'cktoken_get_balance', {
      token: 'ckETH',
      principal: 'aaaaa-aa',
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.balance_raw).toBe('10000000000000000000');
    expect(data.balance_formatted).toBe('10.000000000000000000');
  });

  it('returns formatted balance for ckUSDC (6 decimals)', async () => {
    mockBalance.mockResolvedValueOnce(5_000_000n); // 5 ckUSDC

    const result = await callTool(makeServer(), 'cktoken_get_balance', {
      token: 'ckUSDC',
      principal: 'aaaaa-aa',
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.balance_raw).toBe('5000000');
    expect(data.balance_formatted).toBe('5.000000');
  });

  it('throws McpError on invalid principal', async () => {
    mockBalance.mockRejectedValueOnce(new Error('Principal format error'));

    await expect(
      callTool(makeServer(), 'cktoken_get_balance', {
        token: 'ckBTC',
        principal: 'invalid-principal',
        network: 'mainnet',
      }),
    ).rejects.toBeInstanceOf(McpError);
  });

  it('validates subaccount hex length (must be 64 chars)', async () => {
    await expect(
      callTool(makeServer(), 'cktoken_get_balance', {
        token: 'ckBTC',
        principal: 'aaaaa-aa',
        subaccount: 'tooshort',
        network: 'mainnet',
      }),
    ).rejects.toBeInstanceOf(McpError);
  });
});

// ─── cktoken_transfer ─────────────────────────────────────────────────────────

describe('cktoken_transfer', () => {
  beforeEach(() => {
    initCache(60_000);
    mockBalance.mockReset();
    mockTransfer.mockReset();
    mockAppendPending.mockReset().mockResolvedValue(undefined);
    mockMarkSettled.mockReset().mockResolvedValue(undefined);
  });

  it('returns preview when confirm is not passed', async () => {
    const result = await callTool(makeServer(), 'cktoken_transfer', {
      token: 'ckBTC',
      to: 'aaaaa-aa',
      amount: '100000000',
      network: 'mainnet',
    });

    expect(result).toContain('Transfer Preview');
    expect(result).toContain('100000000');
    expect(result).toContain('ckBTC');
    // Must NOT have called ICP or written to log
    expect(mockAppendPending).not.toHaveBeenCalled();
    expect(mockTransfer).not.toHaveBeenCalled();
  });

  it('executes transfer and returns block index on confirm: true', async () => {
    mockTransfer.mockResolvedValueOnce(42n); // block index

    const result = await callTool(makeServer(), 'cktoken_transfer', {
      token: 'ckBTC',
      to: 'aaaaa-aa',
      amount: '100000000',
      network: 'mainnet',
      confirm: true,
    });

    const data = JSON.parse(result);
    expect(data.success).toBe(true);
    expect(data.block_index).toBe('42');
    expect(data.amount_raw).toBe('100000000');
    expect(data.amount_formatted).toBe('1.00000000 ckBTC');

    // Must have logged before calling ICP, then settled
    expect(mockAppendPending).toHaveBeenCalledOnce();
    expect(mockMarkSettled).toHaveBeenCalledWith(expect.any(String), 'settled');
  });

  it('handles ckETH 18-decimal amount without precision loss', async () => {
    mockTransfer.mockResolvedValueOnce(99n);

    const result = await callTool(makeServer(), 'cktoken_transfer', {
      token: 'ckETH',
      to: 'aaaaa-aa',
      amount: '10000000000000000000', // 10 ckETH — exceeds Number.MAX_SAFE_INTEGER
      network: 'mainnet',
      confirm: true,
    });

    const data = JSON.parse(result);
    expect(data.success).toBe(true);
    expect(data.amount_raw).toBe('10000000000000000000');
    expect(data.amount_formatted).toBe('10.000000000000000000 ckETH');

    // Verify BigInt was passed to ICP (not a rounded number)
    const transferCall = mockTransfer.mock.calls[0][0];
    expect(transferCall.amount).toBe(10_000_000_000_000_000_000n);
  });

  it('returns idempotency warning if same transfer is submitted twice', async () => {
    mockTransfer.mockResolvedValue(1n);

    const server = makeServer(); // same server = same in-session set
    await callTool(server, 'cktoken_transfer', {
      token: 'ckBTC',
      to: 'aaaaa-aa',
      amount: '50000000',
      network: 'mainnet',
      confirm: true,
    });

    const result2 = await callTool(server, 'cktoken_transfer', {
      token: 'ckBTC',
      to: 'aaaaa-aa',
      amount: '50000000',
      network: 'mainnet',
      confirm: true,
    });

    const data2 = JSON.parse(result2);
    expect(data2.warning).toContain('already submitted');
    // ICP should only have been called once
    expect(mockTransfer).toHaveBeenCalledOnce();
  });

  it('logs pending BEFORE ICP call, then marks error if ICP throws', async () => {
    mockTransfer.mockRejectedValueOnce({ reject_code: 3, reject_message: 'insufficient funds' });

    await expect(
      callTool(makeServer(), 'cktoken_transfer', {
        token: 'ckBTC',
        to: 'aaaaa-aa',
        amount: '999999999999',
        network: 'mainnet',
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(McpError);

    expect(mockAppendPending).toHaveBeenCalledOnce();
    expect(mockMarkSettled).toHaveBeenCalledWith(expect.any(String), 'error', expect.any(String));
  });

  it('rejects non-numeric amount string before ICP call', async () => {
    await expect(
      callTool(makeServer(), 'cktoken_transfer', {
        token: 'ckBTC',
        to: 'aaaaa-aa',
        amount: 'not-a-number',
        network: 'mainnet',
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(McpError);

    // Amount is validated before log write — invalid amount should not reach ICP or log
    expect(mockTransfer).not.toHaveBeenCalled();
    expect(mockAppendPending).not.toHaveBeenCalled();
  });

  it('throws McpError when cycles budget is exceeded, before log write and ICP call', async () => {
    // Budget of 0 — any update call immediately exceeds it.
    // Use a unique amount to avoid triggering the idempotency guard from earlier tests.
    const exhaustedBudget = new CyclesBudget(0);

    await expect(
      callTool(makeServer({ budget: exhaustedBudget }), 'cktoken_transfer', {
        token: 'ckBTC',
        to: 'aaaaa-aa',
        amount: '777000001', // unique amount — no fingerprint collision with earlier tests
        network: 'mainnet',
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(McpError);

    // Budget exceeded BEFORE appendPending and ledger.transfer — log stays clean
    expect(mockAppendPending).not.toHaveBeenCalled();
    expect(mockTransfer).not.toHaveBeenCalled();
  });

  it('does not charge cycles budget in preview mode', async () => {
    const budget = new CyclesBudget(0); // zero budget — would throw if charged
    const chargeSpy = vi.spyOn(budget, 'charge');

    const result = await callTool(makeServer({ budget }), 'cktoken_transfer', {
      token: 'ckBTC',
      to: 'aaaaa-aa',
      amount: '777000002', // unique amount
      network: 'mainnet',
      // no confirm — preview mode only
    });

    expect(result).toContain('Transfer Preview');
    expect(chargeSpy).not.toHaveBeenCalled();
  });

  it('proceeds normally when no budget is configured', async () => {
    mockTransfer.mockResolvedValueOnce(10n);

    const result = await callTool(makeServer(), 'cktoken_transfer', {
      token: 'ckBTC',
      to: 'aaaaa-aa',
      amount: '777000003', // unique amount
      network: 'mainnet',
      confirm: true,
    });

    const data = JSON.parse(result);
    expect(data.success).toBe(true);
  });
});
