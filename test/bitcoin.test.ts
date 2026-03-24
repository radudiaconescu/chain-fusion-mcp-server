import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { registerBitcoinTools } from '../src/tools/bitcoin.js';
import { initCache } from '../src/cache.js';

// Typed reference to global fetch mock
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeServer() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerBitcoinTools(server, {});
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
    mockFetch.mockReset();
  });

  it('returns confirmed and unconfirmed balance', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        chain_stats: { funded_txo_sum: 1_000_000, spent_txo_sum: 100_000 },
        mempool_stats: { funded_txo_sum: 50_000, spent_txo_sum: 0 },
      }),
    );

    // Call the tool directly via the server's internal handler
    const result = await callTool(makeServer(), 'bitcoin_get_balance', {
      address: 'bc1qtest',
      network: 'mainnet',
    });

    const data = JSON.parse(result);
    expect(data.confirmed_satoshis).toBe(900_000);
    expect(data.unconfirmed_satoshis).toBe(50_000);
    expect(data.total_satoshis).toBe(950_000);
    expect(data.confirmed_btc).toBe('0.00900000');
  });

  it('uses testnet API URL when network=testnet', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({
        chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
      }),
    );

    await callTool(makeServer(), 'bitcoin_get_balance', {
      address: 'tb1qtest',
      network: 'testnet',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('testnet'),
    );
  });

  it('throws McpError when API returns non-ok status', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad Request'),
      }),
    );

    await expect(
      callTool(makeServer(), 'bitcoin_get_balance', {
        address: 'invalid',
        network: 'mainnet',
      }),
    ).rejects.toThrow(McpError);
  });

  it('returns cached result on second call', async () => {
    mockFetch.mockReturnValue(
      jsonResponse({
        chain_stats: { funded_txo_sum: 500_000, spent_txo_sum: 0 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
      }),
    );

    const server = makeServer();
    await callTool(server, 'bitcoin_get_balance', { address: 'bc1qcache', network: 'mainnet' });
    await callTool(server, 'bitcoin_get_balance', { address: 'bc1qcache', network: 'mainnet' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
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

    // Note: submittedTxHashes is module-level — reset by creating new module instance
    // This test is limited by module singleton behavior; integration test handles full reset
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

    // Second call should warn about duplicate, not call fetch again
    expect(result2).toContain('already submitted');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('bitcoin_get_fee_rates', () => {
  beforeEach(() => {
    initCache(60_000);
    mockFetch.mockReset();
  });

  it('returns fee rate tiers', async () => {
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
