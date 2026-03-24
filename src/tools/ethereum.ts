import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { cacheGet, cacheSet, makeCacheKey } from '../cache.js';
import { toMcpError, extractEvmResult } from '../errors.js';

// In-session nonce tracking for duplicate send protection
const submittedRawTxHashes = new Set<string>();

/**
 * Sends an Ethereum JSON-RPC request to the configured endpoint.
 *
 * Request flow:
 *   caller → fetch(rpcUrl, POST) → JSON-RPC node
 *       │                               │
 *       │     { jsonrpc, id, method }   │
 *       │ ─────────────────────────────►│
 *       │                               │
 *       │     { result } or { error }   │
 *       │ ◄─────────────────────────────│
 *       │
 *       └─ extractEvmResult() detects embedded EVM error objects
 *          and throws them so toMcpError() can normalize them
 */
async function ethRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!res.ok) {
    throw new Error(`ETH RPC HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const json = (await res.json()) as {
    result?: unknown;
    error?: { code: number; message: string };
  };

  if (json.error) {
    throw json.error; // isEvmRpcError() in errors.ts handles this shape
  }

  // Guard against embedded error strings (ic-evm-rpc canister pattern)
  if (typeof json.result === 'string') {
    return extractEvmResult<T>(json.result);
  }

  return json.result as T;
}

function requireRpcUrl(ethRpcUrl: string | undefined, tool: string): string {
  if (!ethRpcUrl) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `${tool} requires ETH_RPC_URL to be configured. Set it in your environment.`,
    );
  }
  return ethRpcUrl;
}

export function registerEthereumTools(
  server: McpServer,
  opts: { ethRpcUrl?: string },
): void {
  // ─── eth_get_balance ──────────────────────────────────────────────────────
  server.tool(
    'eth_get_balance',
    'Get the ETH balance of an Ethereum address',
    {
      address: z.string().describe('Ethereum address (0x...)'),
      block: z
        .string()
        .default('latest')
        .describe('Block tag: latest, earliest, pending, or hex block number'),
    },
    async ({ address, block }) => {
      const rpcUrl = requireRpcUrl(opts.ethRpcUrl, 'eth_get_balance');
      const key = makeCacheKey('eth_get_balance', { address, block });
      const cached = cacheGet<string>(key);
      if (cached) return { content: [{ type: 'text', text: cached }] };

      try {
        const balanceHex = await ethRpc<string>(rpcUrl, 'eth_getBalance', [address, block]);
        const balanceWei = BigInt(balanceHex);
        const balanceEth = Number(balanceWei) / 1e18;

        const text = JSON.stringify(
          {
            address,
            block,
            balance_wei: balanceWei.toString(),
            balance_eth: balanceEth.toFixed(18),
          },
          null,
          2,
        );

        cacheSet(key, text);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        throw toMcpError(err, 'eth_get_balance');
      }
    },
  );

  // ─── eth_call ─────────────────────────────────────────────────────────────
  server.tool(
    'eth_call',
    'Execute a read-only call to an Ethereum smart contract (does not submit a transaction)',
    {
      to: z.string().describe('Contract address (0x...)'),
      data: z.string().describe('ABI-encoded call data (0x...)'),
      from: z.string().optional().describe('Caller address (0x...), optional'),
      block: z
        .string()
        .default('latest')
        .describe('Block tag or hex block number'),
    },
    async ({ to, data, from, block }) => {
      const rpcUrl = requireRpcUrl(opts.ethRpcUrl, 'eth_call');
      const key = makeCacheKey('eth_call', { to, data, from, block });
      const cached = cacheGet<string>(key);
      if (cached) return { content: [{ type: 'text', text: cached }] };

      try {
        const callObj: Record<string, string> = { to, data };
        if (from) callObj.from = from;

        const result = await ethRpc<string>(rpcUrl, 'eth_call', [callObj, block]);

        const text = JSON.stringify({ to, data, from, block, result }, null, 2);
        cacheSet(key, text);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        throw toMcpError(err, 'eth_call');
      }
    },
  );

  // ─── eth_get_transaction ──────────────────────────────────────────────────
  server.tool(
    'eth_get_transaction',
    'Get details of an Ethereum transaction by hash',
    {
      tx_hash: z.string().describe('Transaction hash (0x...)'),
    },
    async ({ tx_hash }) => {
      const rpcUrl = requireRpcUrl(opts.ethRpcUrl, 'eth_get_transaction');
      const key = makeCacheKey('eth_get_transaction', { tx_hash });
      const cached = cacheGet<string>(key);
      if (cached) return { content: [{ type: 'text', text: cached }] };

      try {
        const tx = await ethRpc<Record<string, unknown> | null>(
          rpcUrl,
          'eth_getTransactionByHash',
          [tx_hash],
        );

        if (!tx) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ tx_hash, found: false }, null, 2),
              },
            ],
          };
        }

        const receipt = await ethRpc<Record<string, unknown> | null>(
          rpcUrl,
          'eth_getTransactionReceipt',
          [tx_hash],
        );

        const text = JSON.stringify({ tx, receipt }, null, 2);
        cacheSet(key, text);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        throw toMcpError(err, 'eth_get_transaction');
      }
    },
  );

  // ─── eth_send_raw_transaction ─────────────────────────────────────────────
  server.tool(
    'eth_send_raw_transaction',
    [
      'Broadcast a signed Ethereum transaction.',
      'Call without confirm first to preview. Pass confirm: true to actually broadcast.',
    ].join(' '),
    {
      signed_tx_hex: z.string().describe('Signed transaction in hex (0x...)'),
      confirm: z
        .literal(true)
        .optional()
        .describe('Pass true to broadcast. Omit to preview only.'),
    },
    async ({ signed_tx_hex, confirm }) => {
      if (!confirm) {
        return {
          content: [
            {
              type: 'text',
              text: [
                '⚠️  Transaction Broadcast Preview',
                `Signed TX: ${signed_tx_hex.slice(0, 42)}... (${(signed_tx_hex.length - 2) / 2} bytes)`,
                '',
                'To broadcast, call this tool again with confirm: true',
              ].join('\n'),
            },
          ],
        };
      }

      if (submittedRawTxHashes.has(signed_tx_hex)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { warning: 'Transaction already submitted this session' },
                null,
                2,
              ),
            },
          ],
        };
      }

      const rpcUrl = requireRpcUrl(opts.ethRpcUrl, 'eth_send_raw_transaction');

      try {
        const txHash = await ethRpc<string>(rpcUrl, 'eth_sendRawTransaction', [
          signed_tx_hex,
        ]);
        submittedRawTxHashes.add(signed_tx_hex);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, tx_hash: txHash }, null, 2),
            },
          ],
        };
      } catch (err) {
        throw toMcpError(err, 'eth_send_raw_transaction');
      }
    },
  );
}
