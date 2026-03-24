import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { cacheGet, cacheSet, makeCacheKey } from '../cache.js';
import { toMcpError } from '../errors.js';

// Submitted tx hashes — prevents Claude from broadcasting the same tx twice.
// Cleared on server restart (sufficient for single-session safety).
const submittedTxHashes = new Set<string>();

const BTC_API_URLS = {
  mainnet: 'https://mempool.space/api',
  testnet: 'https://mempool.space/testnet/api',
} as const;

function resolveApiUrl(network: 'mainnet' | 'testnet', override?: string): string {
  return override ?? BTC_API_URLS[network];
}

async function fetchBtcApi<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Bitcoin API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export function registerBitcoinTools(
  server: McpServer,
  opts: { btcApiUrl?: string },
): void {
  // ─── bitcoin_get_balance ──────────────────────────────────────────────────
  server.tool(
    'bitcoin_get_balance',
    'Get the Bitcoin balance for an address (confirmed + unconfirmed)',
    {
      address: z.string().describe('Bitcoin address (P2PKH, P2SH, P2WPKH, P2TR, or P2WSH)'),
      network: z
        .enum(['mainnet', 'testnet'])
        .default('mainnet')
        .describe('Bitcoin network'),
    },
    async ({ address, network }) => {
      const key = makeCacheKey('bitcoin_get_balance', { address, network });
      const cached = cacheGet<string>(key);
      if (cached) return { content: [{ type: 'text', text: cached }] };

      try {
        const apiUrl = resolveApiUrl(network, opts.btcApiUrl);
        const data = await fetchBtcApi<{
          chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
          mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
        }>(`${apiUrl}/address/${address}`);

        const confirmedSat =
          data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
        const unconfirmedSat =
          data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;

        const text = JSON.stringify(
          {
            address,
            network,
            confirmed_satoshis: confirmedSat,
            unconfirmed_satoshis: unconfirmedSat,
            total_satoshis: confirmedSat + unconfirmedSat,
            confirmed_btc: (confirmedSat / 1e8).toFixed(8),
            total_btc: ((confirmedSat + unconfirmedSat) / 1e8).toFixed(8),
          },
          null,
          2,
        );

        cacheSet(key, text);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        throw toMcpError(err, 'bitcoin_get_balance');
      }
    },
  );

  // ─── bitcoin_get_utxos ────────────────────────────────────────────────────
  server.tool(
    'bitcoin_get_utxos',
    'Get unspent transaction outputs (UTXOs) for a Bitcoin address',
    {
      address: z.string().describe('Bitcoin address'),
      network: z.enum(['mainnet', 'testnet']).default('mainnet'),
    },
    async ({ address, network }) => {
      const key = makeCacheKey('bitcoin_get_utxos', { address, network });
      const cached = cacheGet<string>(key);
      if (cached) return { content: [{ type: 'text', text: cached }] };

      try {
        const apiUrl = resolveApiUrl(network, opts.btcApiUrl);
        const utxos = await fetchBtcApi<
          Array<{
            txid: string;
            vout: number;
            status: { confirmed: boolean; block_height?: number };
            value: number;
          }>
        >(`${apiUrl}/address/${address}/utxo`);

        const totalSat = utxos.reduce((sum, u) => sum + u.value, 0);
        const text = JSON.stringify(
          {
            address,
            network,
            utxo_count: utxos.length,
            total_satoshis: totalSat,
            total_btc: (totalSat / 1e8).toFixed(8),
            utxos: utxos.map((u) => ({
              txid: u.txid,
              vout: u.vout,
              value_satoshis: u.value,
              value_btc: (u.value / 1e8).toFixed(8),
              confirmed: u.status.confirmed,
              block_height: u.status.block_height ?? null,
            })),
          },
          null,
          2,
        );

        cacheSet(key, text);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        throw toMcpError(err, 'bitcoin_get_utxos');
      }
    },
  );

  // ─── bitcoin_get_fee_rates ────────────────────────────────────────────────
  server.tool(
    'bitcoin_get_fee_rates',
    'Get current Bitcoin fee rate recommendations in sat/vByte',
    {
      network: z.enum(['mainnet', 'testnet']).default('mainnet'),
    },
    async ({ network }) => {
      const key = makeCacheKey('bitcoin_get_fee_rates', { network });
      const cached = cacheGet<string>(key);
      if (cached) return { content: [{ type: 'text', text: cached }] };

      try {
        const apiUrl = resolveApiUrl(network, opts.btcApiUrl);
        const fees = await fetchBtcApi<{
          fastestFee: number;
          halfHourFee: number;
          hourFee: number;
          economyFee: number;
          minimumFee: number;
        }>(`${apiUrl}/v1/fees/recommended`);

        const text = JSON.stringify(
          {
            network,
            fee_rates_sat_per_vbyte: {
              fastest: fees.fastestFee,
              half_hour: fees.halfHourFee,
              one_hour: fees.hourFee,
              economy: fees.economyFee,
              minimum: fees.minimumFee,
            },
          },
          null,
          2,
        );

        cacheSet(key, text);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        throw toMcpError(err, 'bitcoin_get_fee_rates');
      }
    },
  );

  // ─── bitcoin_broadcast_transaction ───────────────────────────────────────
  server.tool(
    'bitcoin_broadcast_transaction',
    [
      'Broadcast a signed Bitcoin transaction to the network.',
      'IMPORTANT: Call without confirm first to preview. Pass confirm: true to actually broadcast.',
      'The transaction must be fully signed before broadcasting.',
    ].join(' '),
    {
      raw_transaction_hex: z
        .string()
        .describe('Signed transaction in hex format'),
      network: z.enum(['mainnet', 'testnet']).default('mainnet'),
      confirm: z
        .literal(true)
        .optional()
        .describe('Pass true to actually broadcast. Omit to preview only.'),
    },
    async ({ raw_transaction_hex, network, confirm }) => {
      // Confirmation gate — return a preview if confirm is not set
      if (!confirm) {
        const preview = raw_transaction_hex.slice(0, 40);
        return {
          content: [
            {
              type: 'text',
              text: [
                '⚠️  Transaction Broadcast Preview',
                `Network : ${network}`,
                `Raw TX  : ${preview}... (${raw_transaction_hex.length / 2} bytes)`,
                '',
                'To broadcast, call this tool again with confirm: true',
              ].join('\n'),
            },
          ],
        };
      }

      // Idempotency guard — hash the raw tx to detect duplicate submissions
      if (submittedTxHashes.has(raw_transaction_hex)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { warning: 'Transaction already submitted this session', network },
                null,
                2,
              ),
            },
          ],
        };
      }

      try {
        const apiUrl = resolveApiUrl(network, opts.btcApiUrl);
        const res = await fetch(`${apiUrl}/tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: raw_transaction_hex,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Broadcast failed (HTTP ${res.status}): ${body}`);
        }

        const txid = (await res.text()).trim();
        submittedTxHashes.add(raw_transaction_hex);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, txid, network }, null, 2),
            },
          ],
        };
      } catch (err) {
        throw toMcpError(err, 'bitcoin_broadcast_transaction');
      }
    },
  );
}
