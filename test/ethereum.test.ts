import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { registerEthereumTools } from '../src/tools/ethereum.js';
import { initCache } from '../src/cache.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const TEST_RPC = 'https://eth.example.com';

function makeServer(ethRpcUrl = TEST_RPC) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerEthereumTools(server, { ethRpcUrl });
  return server;
}

function rpcResponse(result: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }),
  });
}

function rpcErrorResponse(code: number, message: string) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, error: { code, message } }),
  });
}

describe('eth_get_balance', () => {
  beforeEach(() => {
    initCache(60_000);
    mockFetch.mockReset();
  });

  it('converts hex wei to ETH', async () => {
    // 1 ETH = 1e18 wei = 0xDE0B6B3A7640000
    mockFetch.mockReturnValueOnce(rpcResponse('0xDE0B6B3A7640000'));

    const result = await callTool(makeServer(), 'eth_get_balance', {
      address: '0xabc',
      block: 'latest',
    });

    const data = JSON.parse(result);
    expect(data.balance_wei).toBe('1000000000000000000');
    expect(data.balance_eth).toMatch(/^1\.0/);
  });

  it('throws McpError when ETH_RPC_URL is not configured', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    registerEthereumTools(server, { ethRpcUrl: undefined });

    await expect(
      callTool(server, 'eth_get_balance', { address: '0xabc', block: 'latest' }),
    ).rejects.toThrow(McpError);
  });

  it('throws McpError on EVM JSON-RPC error', async () => {
    mockFetch.mockReturnValueOnce(
      rpcErrorResponse(-32602, 'invalid argument'),
    );

    await expect(
      callTool(makeServer(), 'eth_get_balance', { address: '0xbad', block: 'latest' }),
    ).rejects.toThrow(McpError);
  });

  it('caches identical requests', async () => {
    mockFetch.mockReturnValue(rpcResponse('0x0'));

    const server = makeServer();
    await callTool(server, 'eth_get_balance', { address: '0xcached', block: 'latest' });
    await callTool(server, 'eth_get_balance', { address: '0xcached', block: 'latest' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('calls eth_getBalance with correct params', async () => {
    mockFetch.mockReturnValueOnce(rpcResponse('0x0'));

    await callTool(makeServer(), 'eth_get_balance', {
      address: '0xdeadbeef',
      block: 'finalized',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.method).toBe('eth_getBalance');
    expect(body.params).toEqual(['0xdeadbeef', 'finalized']);
  });
});

describe('eth_call', () => {
  beforeEach(() => {
    initCache(60_000);
    mockFetch.mockReset();
  });

  it('returns ABI-encoded result', async () => {
    const encoded = '0x0000000000000000000000000000000000000000000000000000000000000001';
    mockFetch.mockReturnValueOnce(rpcResponse(encoded));

    const result = await callTool(makeServer(), 'eth_call', {
      to: '0xcontract',
      data: '0xabcdef',
      block: 'latest',
    });

    const data = JSON.parse(result);
    expect(data.result).toBe(encoded);
  });

  it('throws on EVM revert', async () => {
    mockFetch.mockReturnValueOnce(
      rpcErrorResponse(3, 'execution reverted: insufficient balance'),
    );

    await expect(
      callTool(makeServer(), 'eth_call', { to: '0x1', data: '0x2', block: 'latest' }),
    ).rejects.toThrow(McpError);
  });
});

describe('eth_send_raw_transaction', () => {
  beforeEach(() => {
    initCache(60_000);
    mockFetch.mockReset();
  });

  it('returns preview when confirm is not set', async () => {
    const result = await callTool(makeServer(), 'eth_send_raw_transaction', {
      signed_tx_hex: '0xf86c0985...',
    });

    expect(result).toContain('Preview');
    expect(result).toContain('confirm: true');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('broadcasts when confirm: true', async () => {
    mockFetch.mockReturnValueOnce(
      rpcResponse('0xtxhash123'),
    );

    const result = await callTool(makeServer(), 'eth_send_raw_transaction', {
      signed_tx_hex: '0xsignedtx999',
      confirm: true,
    });

    const data = JSON.parse(result);
    expect(data.success).toBe(true);
    expect(data.tx_hash).toBe('0xtxhash123');
  });

  it('prevents duplicate broadcast of same signed tx', async () => {
    mockFetch.mockReturnValue(rpcResponse('0xtxhash'));

    const server = makeServer();
    const signedTx = '0xduplicatetx555';

    await callTool(server, 'eth_send_raw_transaction', {
      signed_tx_hex: signedTx,
      confirm: true,
    });

    const result2 = await callTool(server, 'eth_send_raw_transaction', {
      signed_tx_hex: signedTx,
      confirm: true,
    });

    expect(result2).toContain('already submitted');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── Test helper ─────────────────────────────────────────────────────────────

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
