import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { HttpAgent } from '@icp-sdk/core/agent';
import { initCache } from '../src/cache.js';

// ─── Mock error classes (named so constructor.name matches) ──────────────────
// Production code uses isMinterErrorByName(err, 'MinterXxxError') which checks
// err.constructor.name — so we need real named classes, not Object.assign tricks.
class MinterTemporaryUnavailableError extends Error {}
class MinterAlreadyProcessingError extends Error {}
class MinterMalformedAddressError extends Error {}
class MinterAmountTooLowError extends Error {}
class MinterInsufficientFundsError extends Error {}

// isMinterNoNewUtxosError checks for .pendingUtxos + .requiredConfirmations properties
function makeMinterNoNewUtxosError(pendingCount = 1, requiredConfirmations = 6): Error {
  return Object.assign(new Error('NoNewUtxos'), {
    pendingUtxos: Array.from({ length: pendingCount }, () => ({
      confirmations: 3,
      value: 50_000n,
      outpoint: { txid: new Uint8Array(32), vout: 0 },
    })),
    requiredConfirmations,
  });
}

// vi.mock is hoisted — define shared mock fns with vi.hoisted()
const {
  mockGetBtcAddress,
  mockUpdateBalance,
  mockGetWithdrawalAccount,
  mockRetrieveBtc,
  mockRetrieveBtcStatusV2ByAccount,
  mockEstimateWithdrawalFee,
  mockGetMinterInfo,
  mockAppendWithdrawalPending,
  mockMarkWithdrawalSettled,
} = vi.hoisted(() => ({
  mockGetBtcAddress: vi.fn(),
  mockUpdateBalance: vi.fn(),
  mockGetWithdrawalAccount: vi.fn(),
  mockRetrieveBtc: vi.fn(),
  mockRetrieveBtcStatusV2ByAccount: vi.fn(),
  mockEstimateWithdrawalFee: vi.fn(),
  mockGetMinterInfo: vi.fn(),
  mockAppendWithdrawalPending: vi.fn().mockResolvedValue(undefined),
  mockMarkWithdrawalSettled: vi.fn().mockResolvedValue(undefined),
}));

// ─── Mock @icp-sdk/canisters/ckbtc ───────────────────────────────────────────
vi.mock('@icp-sdk/canisters/ckbtc', () => ({
  CkBtcMinterCanister: {
    create: vi.fn(() => ({
      getBtcAddress: mockGetBtcAddress,
      updateBalance: mockUpdateBalance,
      getWithdrawalAccount: mockGetWithdrawalAccount,
      retrieveBtc: mockRetrieveBtc,
      retrieveBtcStatusV2ByAccount: mockRetrieveBtcStatusV2ByAccount,
      estimateWithdrawalFee: mockEstimateWithdrawalFee,
      getMinterInfo: mockGetMinterInfo,
    })),
  },
}));

// ─── Mock @icp-sdk/core/principal ────────────────────────────────────────────
vi.mock('@icp-sdk/core/principal', () => ({
  Principal: {
    fromText: vi.fn((text: string) => ({ toText: () => text, toString: () => text })),
  },
}));

// ─── Mock withdrawal-log so we don't hit the filesystem ──────────────────────
vi.mock('../src/withdrawal-log.js', () => ({
  appendWithdrawalPending: mockAppendWithdrawalPending,
  markWithdrawalSettled: mockMarkWithdrawalSettled,
  loadPendingWithdrawals: vi.fn().mockResolvedValue([]),
}));

import { registerCkBtcMinterTools } from '../src/tools/ckbtc-minter.js';
import { CyclesBudget } from '../src/cycles-budget.js';

const mockAgent = {} as HttpAgent;

function makeServer(opts?: { budget?: CyclesBudget }) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerCkBtcMinterTools(server, mockAgent, opts);
  return server;
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const registry = (server as unknown as {
    _registeredTools: Record<
      string,
      {
        handler: (
          args: unknown,
          extra: object,
        ) => Promise<{ content: Array<{ type: string; text: string }> }>;
      }
    >;
  })._registeredTools;

  const tool = registry[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);

  const result = await tool.handler(args, {});
  return result.content[0].text;
}

// ─── ckbtc_get_deposit_address ────────────────────────────────────────────────

describe('ckbtc_get_deposit_address', () => {
  beforeEach(() => {
    initCache(60_000);
    mockGetBtcAddress.mockReset();
  });

  it('returns BTC deposit address with permanent flag', async () => {
    mockGetBtcAddress.mockResolvedValueOnce('bc1qtest123');

    const result = await callTool(makeServer(), 'ckbtc_get_deposit_address', {
      principal: 'aaaaa-aa',
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.address).toBe('bc1qtest123');
    expect(data.address_is_permanent).toBe(true);
    expect(data.principal).toBe('aaaaa-aa');
    expect(data.network).toBe('mainnet');
    expect(data.note).toContain('6+ confirmations');
  });

  it('returns cached result on second call (no re-call to minter)', async () => {
    mockGetBtcAddress.mockResolvedValueOnce('bc1qtest123');

    const server = makeServer();
    await callTool(server, 'ckbtc_get_deposit_address', {
      principal: 'aaaaa-aa',
      network: 'mainnet',
    });
    await callTool(server, 'ckbtc_get_deposit_address', {
      principal: 'aaaaa-aa',
      network: 'mainnet',
    });

    expect(mockGetBtcAddress).toHaveBeenCalledTimes(1);
  });

  it('charges cycles budget', async () => {
    mockGetBtcAddress.mockResolvedValueOnce('bc1qtest');
    const budget = new CyclesBudget(100); // tiny budget
    budget.charge(99); // exhaust it

    const server = makeServer({ budget });
    await expect(
      callTool(server, 'ckbtc_get_deposit_address', {
        principal: 'aaaaa-aa',
        network: 'mainnet',
      }),
    ).rejects.toBeInstanceOf(McpError);
  });
});

// ─── ckbtc_update_balance ─────────────────────────────────────────────────────

describe('ckbtc_update_balance', () => {
  beforeEach(() => {
    mockUpdateBalance.mockReset();
    mockAppendWithdrawalPending.mockReset().mockResolvedValue(undefined);
    mockMarkWithdrawalSettled.mockReset().mockResolvedValue(undefined);
  });

  it('returns minted status when UTXOs are minted', async () => {
    mockUpdateBalance.mockResolvedValueOnce([
      {
        Minted: {
          minted_amount: 100_000n,
          block_index: 42n,
          utxo: { outpoint: { txid: new Uint8Array(32), vout: 0 }, value: 100_000n, height: 800_000 },
        },
      },
    ]);

    const result = await callTool(makeServer(), 'ckbtc_update_balance', {
      principal: 'aaaaa-aa',
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.status).toBe('minted');
    expect(data.minted_satoshis).toBe('100000');
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].type).toBe('Minted');
    expect(data.entries[0].block_index).toBe('42');
  });

  it('returns pending_confirmations when no new UTXOs (not yet confirmed)', async () => {
    mockUpdateBalance.mockRejectedValueOnce(makeMinterNoNewUtxosError(2, 6));

    const result = await callTool(makeServer(), 'ckbtc_update_balance', {
      principal: 'aaaaa-aa',
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.status).toBe('pending_confirmations');
    expect(data.pending_utxos).toBe(2);
    expect(data.required_confirmations).toBe(6);
    expect(data.retry_after_seconds).toBe(600);
  });

  it('returns tainted status for tainted UTXOs', async () => {
    mockUpdateBalance.mockResolvedValueOnce([
      {
        Tainted: {
          outpoint: { txid: new Uint8Array(32), vout: 0 },
          value: 50_000n,
          height: 800_000,
        },
      },
    ]);

    const result = await callTool(makeServer(), 'ckbtc_update_balance', {
      principal: 'aaaaa-aa',
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.status).toBe('tainted');
    expect(data.tainted_utxos).toBe(1);
    expect(data.note).toContain('KYT');
  });

  it('handles mix: minted + tainted', async () => {
    mockUpdateBalance.mockResolvedValueOnce([
      {
        Minted: {
          minted_amount: 80_000n,
          block_index: 10n,
          utxo: { outpoint: { txid: new Uint8Array(32), vout: 0 }, value: 80_000n, height: 800_000 },
        },
      },
      {
        Tainted: {
          outpoint: { txid: new Uint8Array(32), vout: 1 },
          value: 20_000n,
          height: 800_000,
        },
      },
    ]);

    const result = await callTool(makeServer(), 'ckbtc_update_balance', {
      principal: 'aaaaa-aa',
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    // Minted takes precedence since minted_satoshis > 0
    expect(data.status).toBe('minted');
    expect(data.minted_satoshis).toBe('80000');
    expect(data.tainted_utxos).toBe(1);
  });
});

// ─── ckbtc_get_withdrawal_account ────────────────────────────────────────────

describe('ckbtc_get_withdrawal_account', () => {
  beforeEach(() => {
    initCache(60_000);
    mockGetWithdrawalAccount.mockReset();
  });

  it('returns withdrawal account with instructions', async () => {
    mockGetWithdrawalAccount.mockResolvedValueOnce({
      owner: { toText: () => 'minter-principal-id', toString: () => 'minter-principal-id' },
      subaccount: [],
    });

    const result = await callTool(makeServer(), 'ckbtc_get_withdrawal_account', {
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.owner).toBe('minter-principal-id');
    expect(data.subaccount).toBeNull();
    expect(data.instructions).toContain('cktoken_transfer');
    expect(data.instructions).toContain('ckbtc_withdraw');
  });

  it('returns cached result on second call', async () => {
    mockGetWithdrawalAccount.mockResolvedValueOnce({
      owner: { toText: () => 'withdrawal-owner', toString: () => 'withdrawal-owner' },
      subaccount: [],
    });

    const server = makeServer();
    await callTool(server, 'ckbtc_get_withdrawal_account', { network: 'mainnet' });
    await callTool(server, 'ckbtc_get_withdrawal_account', { network: 'mainnet' });

    expect(mockGetWithdrawalAccount).toHaveBeenCalledTimes(1);
  });
});

// ─── ckbtc_withdraw ────────────────────────────────────────────────────────────

describe('ckbtc_withdraw', () => {
  beforeEach(() => {
    mockRetrieveBtc.mockReset();
    mockEstimateWithdrawalFee.mockReset();
    mockGetMinterInfo.mockReset();
    mockAppendWithdrawalPending.mockReset().mockResolvedValue(undefined);
    mockMarkWithdrawalSettled.mockReset().mockResolvedValue(undefined);
  });

  it('preview mode returns fee estimate and minimum amount', async () => {
    mockEstimateWithdrawalFee.mockResolvedValueOnce({ minter_fee: 300n, bitcoin_fee: 200n });
    mockGetMinterInfo.mockResolvedValueOnce({ retrieve_btc_min_amount: 1_000n });

    const result = await callTool(makeServer(), 'ckbtc_withdraw', {
      amount_satoshi: '100000',
      btc_address: 'bc1qdest',
      network: 'mainnet',
      // no confirm
    });

    expect(result).toContain('Withdrawal Preview');
    expect(result).toContain('100000 sat');
    expect(result).toContain('bc1qdest');
    expect(result).toContain('300 sat'); // minter fee
    expect(result).toContain('200 sat'); // BTC fee
    expect(result).toContain('confirm: true');
    expect(mockRetrieveBtc).not.toHaveBeenCalled();
  });

  it('preview mode shows error when below minimum', async () => {
    mockEstimateWithdrawalFee.mockResolvedValueOnce({ minter_fee: 300n, bitcoin_fee: 200n });
    mockGetMinterInfo.mockResolvedValueOnce({ retrieve_btc_min_amount: 5_000n });

    const result = await callTool(makeServer(), 'ckbtc_withdraw', {
      amount_satoshi: '100',
      btc_address: 'bc1qdest',
      network: 'mainnet',
    });

    expect(result).toContain('below minimum');
  });

  it('confirm mode returns block_index on success', async () => {
    mockGetMinterInfo.mockResolvedValueOnce({ retrieve_btc_min_amount: 1_000n });
    mockRetrieveBtc.mockResolvedValueOnce({ block_index: 99n });

    const result = await callTool(makeServer(), 'ckbtc_withdraw', {
      amount_satoshi: '50000',
      btc_address: 'bc1qtest-success',
      network: 'mainnet',
      confirm: true,
    });

    const data = JSON.parse(result);
    expect(data.success).toBe(true);
    expect(data.block_index).toBe('99');
    expect(data.status).toBe('pending');
    expect(data.note).toContain('1-24 hours');
  });

  it('confirm mode: appends to log BEFORE calling retrieveBtc', async () => {
    const callOrder: string[] = [];
    mockGetMinterInfo.mockResolvedValueOnce({ retrieve_btc_min_amount: 1_000n });
    mockAppendWithdrawalPending.mockImplementationOnce(async () => {
      callOrder.push('appendPending');
    });
    mockRetrieveBtc.mockImplementationOnce(async () => {
      callOrder.push('retrieveBtc');
      return { block_index: 1n };
    });

    await callTool(makeServer(), 'ckbtc_withdraw', {
      amount_satoshi: '50000',
      btc_address: 'bc1qtest-order',
      network: 'mainnet',
      confirm: true,
    });

    expect(callOrder).toEqual(['appendPending', 'retrieveBtc']);
  });

  it('confirm mode: budget exceeded throws McpError', async () => {
    mockGetMinterInfo.mockResolvedValueOnce({ retrieve_btc_min_amount: 1_000n });
    const budget = new CyclesBudget(100);
    budget.charge(100); // exhaust it

    const server = makeServer({ budget });
    await expect(
      callTool(server, 'ckbtc_withdraw', {
        amount_satoshi: '50000',
        btc_address: 'bc1qtest-budget',
        network: 'mainnet',
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(McpError);
  });

  it('confirm mode: amount below minimum throws McpError', async () => {
    mockGetMinterInfo.mockResolvedValueOnce({ retrieve_btc_min_amount: 50_000n });

    const server = makeServer();
    await expect(
      callTool(server, 'ckbtc_withdraw', {
        amount_satoshi: '100',
        btc_address: 'bc1qtest-minamt',
        network: 'mainnet',
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(McpError);
  });

  it('confirm mode: MinterInsufficientFundsError gives helpful message', async () => {
    mockGetMinterInfo.mockResolvedValueOnce({ retrieve_btc_min_amount: 1_000n });
    mockRetrieveBtc.mockRejectedValueOnce(new MinterInsufficientFundsError('balance: 0'));

    const server = makeServer();
    await expect(
      callTool(server, 'ckbtc_withdraw', {
        amount_satoshi: '50000',
        btc_address: 'bc1qtest-insufffunds',
        network: 'mainnet',
        confirm: true,
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('withdrawal account') });
  });

  it('confirm mode: MinterMalformedAddressError gives helpful message', async () => {
    mockGetMinterInfo.mockResolvedValueOnce({ retrieve_btc_min_amount: 1_000n });
    mockRetrieveBtc.mockRejectedValueOnce(new MinterMalformedAddressError('bad address'));

    const server = makeServer();
    await expect(
      callTool(server, 'ckbtc_withdraw', {
        amount_satoshi: '50000',
        btc_address: 'invalid-btc-addr',
        network: 'mainnet',
        confirm: true,
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Invalid BTC address') });
  });

  it('confirm mode: idempotency guard prevents duplicate submissions', async () => {
    mockGetMinterInfo.mockResolvedValue({ retrieve_btc_min_amount: 1_000n });
    mockRetrieveBtc.mockResolvedValue({ block_index: 1n });

    const server = makeServer();
    await callTool(server, 'ckbtc_withdraw', {
      amount_satoshi: '50000',
      btc_address: 'bc1qtest-idem',
      network: 'mainnet',
      confirm: true,
    });

    const result = await callTool(server, 'ckbtc_withdraw', {
      amount_satoshi: '50000',
      btc_address: 'bc1qtest-idem',
      network: 'mainnet',
      confirm: true,
    });

    const data = JSON.parse(result);
    expect(data.warning).toContain('already submitted');
    expect(mockRetrieveBtc).toHaveBeenCalledTimes(1);
  });

  it('marks withdrawal as error in log when retrieveBtc fails', async () => {
    mockGetMinterInfo.mockResolvedValueOnce({ retrieve_btc_min_amount: 1_000n });
    mockRetrieveBtc.mockRejectedValueOnce(new Error('network failure'));

    const server = makeServer();
    await expect(
      callTool(server, 'ckbtc_withdraw', {
        amount_satoshi: '50000',
        btc_address: 'bc1qtest-netfail',
        network: 'mainnet',
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(McpError);

    expect(mockMarkWithdrawalSettled).toHaveBeenCalledWith(
      expect.any(String),
      'error',
      expect.objectContaining({ error: 'network failure' }),
    );
  });
});

// ─── ckbtc_withdrawal_status ──────────────────────────────────────────────────

describe('ckbtc_withdrawal_status', () => {
  beforeEach(() => {
    mockRetrieveBtcStatusV2ByAccount.mockReset();
  });

  it('returns all withdrawal statuses', async () => {
    mockRetrieveBtcStatusV2ByAccount.mockResolvedValueOnce([
      { id: 42n, status: { Submitted: { txid: new Uint8Array(32).fill(1) } } },
      { id: 43n, status: { Pending: null } },
      { id: 44n, status: { Confirmed: { txid: new Uint8Array(32).fill(2) } } },
    ]);

    const result = await callTool(makeServer(), 'ckbtc_withdrawal_status', {
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.withdrawal_count).toBe(3);
    expect(data.withdrawals[0].block_index).toBe('42');
    expect(data.withdrawals[0].status).toContain('Submitted');
    expect(data.withdrawals[1].status).toBe('Pending');
    expect(data.withdrawals[2].status).toContain('Confirmed');
  });

  it('returns empty array when no withdrawals', async () => {
    mockRetrieveBtcStatusV2ByAccount.mockResolvedValueOnce([]);

    const result = await callTool(makeServer(), 'ckbtc_withdrawal_status', {
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.withdrawal_count).toBe(0);
    expect(data.withdrawals).toHaveLength(0);
  });

  it('handles undefined status gracefully', async () => {
    mockRetrieveBtcStatusV2ByAccount.mockResolvedValueOnce([
      { id: 99n, status: undefined },
    ]);

    const result = await callTool(makeServer(), 'ckbtc_withdrawal_status', {
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.withdrawals[0].status).toBe('Unknown');
  });
});
