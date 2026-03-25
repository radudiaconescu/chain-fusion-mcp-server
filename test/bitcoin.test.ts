import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { registerBitcoinTools } from '../src/tools/bitcoin.js';
import { initCache } from '../src/cache.js';
import type { HttpAgent } from '@icp-sdk/core/agent';

// vi.mock is hoisted — define shared mock fns with vi.hoisted()
const { mockGetBalanceQuery, mockGetUtxosQuery } = vi.hoisted(() => ({
  mockGetBalanceQuery: vi.fn(),
  mockGetUtxosQuery: vi.fn(),
}));

// ─── Mock @icp-sdk/canisters/ckbtc ───────────────────────────────────────────
vi.mock('@icp-sdk/canisters/ckbtc', () => ({
  BitcoinCanister: {
    create: vi.fn(() => ({
      getBalanceQuery: mockGetBalanceQuery,
      getUtxosQuery: mockGetUtxosQuery,
    })),
  },
}));

// ─── Mock @icp-sdk/core/principal ────────────────────────────────────────────
vi.mock('@icp-sdk/core/principal', () => ({
  Principal: {
    fromText: vi.fn((text: string) => ({ toString: () => text })),
  },
}));

// Typed reference to global fetch mock (used by fee_rates and broadcast only)
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockAgent = {} as HttpAgent;

function makeServer() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerBitcoinTools(server, { agent: mockAgent });
  return server;
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('bitcoin_get_balance', () => {
  beforeEach(() => {
    initCache(60_000);
    mockGetBalanceQuery.mockReset();
  });

  it('returns confirmed balance from Bitcoin canister', async () => {
    mockGetBalanceQuery.mockResolvedValueOnce(900_000n);

    const result = await callTool(makeServer(), 'bitcoin_get_balance', {
      address: 'bc1qtest',
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.confirmed_satoshis).toBe('900000');
    expect(data.confirmed_btc).toBe('0.00900000');
    expect(data.source).toBe('icp-bitcoin-canister');
  });

  it('passes minConfirmations to canister query', async () => {
    mockGetBalanceQuery.mockResolvedValueOnce(500_000n);

    await callTool(makeServer(), 'bitcoin_get_balance', {
      address: 'bc1qtest',
      network: 'mainnet',
      min_confirmations: 0,
    });

    expect(mockGetBalanceQuery).toHaveBeenCalledWith(
      expect.objectContaining({ minConfirmations: 0 }),
    );
  });

  it('uses testnet canister ID when network=testnet', async () => {
    mockGetBalanceQuery.mockResolvedValueOnce(0n);
    const { BitcoinCanister } = await import('@icp-sdk/canisters/ckbtc');

    await callTool(makeServer(), 'bitcoin_get_balance', {
      address: 'tb1qtest',
      network: 'testnet',
    });

    expect(BitcoinCanister.create).toHaveBeenCalledWith(
      expect.objectContaining({
        canisterId: expect.objectContaining({ toString: expect.any(Function) }),
      }),
    );
  });

  it('throws McpError when canister call fails', async () => {
    mockGetBalanceQuery.mockRejectedValueOnce(new Error('canister unreachable'));

    await expect(
      callTool(makeServer(), 'bitcoin_get_balance', {
        address: 'bc1qtest',
        network: 'mainnet',
      }),
    ).rejects.toThrow(McpError);
  });

  it('returns cached result on second call', async () => {
    mockGetBalanceQuery.mockResolvedValue(500_000n);

    const server = makeServer();
    await callTool(server, 'bitcoin_get_balance', { address: 'bc1qcache', network: 'mainnet' });
    await callTool(server, 'bitcoin_get_balance', { address: 'bc1qcache', network: 'mainnet' });

    expect(mockGetBalanceQuery).toHaveBeenCalledTimes(1);
  });
});

describe('bitcoin_get_utxos', () => {
  beforeEach(() => {
    initCache(60_000);
    mockGetUtxosQuery.mockReset();
  });

  it('returns UTXOs with hex txid and string satoshi values', async () => {
    const txidBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    mockGetUtxosQuery.mockResolvedValueOnce({
      utxos: [
        {
          outpoint: { txid: txidBytes, vout: 0 },
          value: 100_000n,
          height: 800_000,
        },
      ],
      tip_height: 800_001,
      tip_block_hash: new Uint8Array(32),
    });

    const result = await callTool(makeServer(), 'bitcoin_get_utxos', {
      address: 'bc1qtest',
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.utxo_count).toBe(1);
    expect(data.utxos[0].txid).toBe('deadbeef');
    expect(data.utxos[0].value_satoshis).toBe('100000');
    expect(data.utxos[0].block_height).toBe(800_000);
    expect(data.utxos[0].confirmed).toBe(true);
    expect(data.tip_height).toBe(800_001);
    expect(data.source).toBe('icp-bitcoin-canister');
  });

  it('marks height=0 UTXOs as unconfirmed', async () => {
    mockGetUtxosQuery.mockResolvedValueOnce({
      utxos: [
        {
          outpoint: { txid: new Uint8Array(4), vout: 1 },
          value: 50_000n,
          height: 0,
        },
      ],
      tip_height: 800_001,
      tip_block_hash: new Uint8Array(32),
    });

    const result = await callTool(makeServer(), 'bitcoin_get_utxos', {
      address: 'bc1qtest',
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.utxos[0].confirmed).toBe(false);
  });

  it('returns empty UTXOs for address with no history', async () => {
    mockGetUtxosQuery.mockResolvedValueOnce({
      utxos: [],
      tip_height: 800_000,
      tip_block_hash: new Uint8Array(32),
    });

    const result = await callTool(makeServer(), 'bitcoin_get_utxos', {
      address: 'bc1qempty',
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.utxo_count).toBe(0);
    expect(data.total_satoshis).toBe('0');
  });

  it('throws McpError when canister call fails', async () => {
    mockGetUtxosQuery.mockRejectedValueOnce(new Error('timeout'));

    await expect(
      callTool(makeServer(), 'bitcoin_get_utxos', {
        address: 'bc1qtest',
        network: 'mainnet',
      }),
    ).rejects.toThrow(McpError);
  });
});

describe('bitcoin_broadcast_transaction', () => {
  beforeEach(() => {
    initCache(60_000);
    mockFetch.mockReset();
  });

  it('returns preview when confirm is not set', async () => {
    const result = await callTool(makeServer(), 'bitcoin_broadcast_transaction', {
      raw_transaction_hex: 'deadbeef01234567',
      network: 'mainnet',
    });

    expect(result).toContain('Preview');
    expect(result).toContain('confirm: true');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('broadcasts when confirm: true', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('abc123txid'),
      }),
    );

    const result = await callTool(makeServer(), 'bitcoin_broadcast_transaction', {
      raw_transaction_hex: 'deadbeef',
      network: 'mainnet',
      confirm: true,
    });

    const data = JSON.parse(result);
    expect(data.success).toBe(true);
    expect(data.txid).toBe('abc123txid');
  });

  it('prevents duplicate broadcast of same raw tx', async () => {
    mockFetch.mockReturnValue(
      Promise.resolve({ ok: true, text: () => Promise.resolve('txid1') }),
    );

    const server = makeServer();
    const rawTx = 'uniquerawtx123';

    await callTool(server, 'bitcoin_broadcast_transaction', {
      raw_transaction_hex: rawTx,
      network: 'testnet',
      confirm: true,
    });

    const result2 = await callTool(server, 'bitcoin_broadcast_transaction', {
      raw_transaction_hex: rawTx,
      network: 'testnet',
      confirm: true,
    });

    expect(result2).toContain('already submitted');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('bitcoin_get_fee_rates', () => {
  beforeEach(() => {
    initCache(60_000);
    mockFetch.mockReset();
  });

  it('returns fee rate tiers from Mempool.space', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        fastestFee: 50,
        halfHourFee: 30,
        hourFee: 20,
        economyFee: 10,
        minimumFee: 1,
      }),
    );

    const result = await callTool(makeServer(), 'bitcoin_get_fee_rates', {
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.fee_rates_sat_per_vbyte.fastest).toBe(50);
    expect(data.fee_rates_sat_per_vbyte.minimum).toBe(1);
  });
});

// ── Test helper ─────────────────────────────────────────────────────────────

/**
 * Calls a named tool on the given McpServer and returns the text content.
 * Uses McpServer's internal _registeredTools registry (SDK 1.x).
 */
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
