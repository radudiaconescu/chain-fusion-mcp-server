import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpAgent } from '@icp-sdk/core/agent';
import { BitcoinCanister } from '@icp-sdk/canisters/ckbtc';
import { Principal } from '@icp-sdk/core/principal';
import { cacheGet, cacheSet, makeCacheKey } from '../cache.js';
import { toMcpError } from '../errors.js';

/**
 * Bitcoin canister IDs on ICP.
 *
 * The dedicated Bitcoin canister replaced the management canister's bitcoin_*
 * methods. Query variants (getBalanceQuery, getUtxosQuery) are callable from
 * external JS clients with no cycles cost. Update variants require cycles and
 * are canister-to-canister only.
 *
 * Mainnet: ghsi2-tqaaa-aaaan-aaaca-cai
 * Testnet: g4xu7-jiaaa-aaaan-aaaaq-cai
 */
const BITCOIN_CANISTER_IDS = {
  mainnet: 'ghsi2-tqaaa-aaaan-aaaca-cai',
  testnet: 'g4xu7-jiaaa-aaaan-aaaaq-cai',
} as const;

// Fee rates and broadcast still use Mempool.space:
//   - Bitcoin canister fee percentiles are update calls (canister-only)
//   - Bitcoin canister send_transaction is also an update call (canister-only)
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

// Submitted tx hashes — prevents Claude from broadcasting the same tx twice.
// Cleared on server restart (sufficient for single-session safety).
const submittedTxHashes = new Set<string>();

export function registerBitcoinTools(
  server: McpServer,
  opts: { agent: HttpAgent; btcApiUrl?: string },
): void {
  // ─── bitcoin_get_balance ──────────────────────────────────────────────────
  //
  // Uses the ICP Bitcoin canister query call (getBalanceQuery).
  // Returns confirmed balance only (default: 6+ confirmations).
  // Not threshold-certified, but sourced directly from ICP's Bitcoin integration
  // rather than a third-party API.
  server.tool(
    'bitcoin_get_balance',
    'Get the confirmed Bitcoin balance for an address via ICP Bitcoin canister (P2PKH, P2SH, P2WPKH, P2TR, P2WSH)',
    {
      address: z.string().describe('Bitcoin address'),
      network: z
        .enum(['mainnet', 'testnet'])
        .default('mainnet')
        .describe('Bitcoin network'),
      min_confirmations: z
        .number()
        .int()
        .min(0)
        .max(6)
        .default(6)
        .describe('Minimum confirmations (0–6, default 6)'),
    },
    async ({ address, network, min_confirmations }) => {
      const key = makeCacheKey('bitcoin_get_balance', { address, network, min_confirmations });
      const cached = cacheGet<string>(key);
      if (cached) return { content: [{ type: 'text', text: cached }] };

      try {
        const btcCanister = BitcoinCanister.create({
          agent: opts.agent,
          canisterId: Principal.fromText(BITCOIN_CANISTER_IDS[network]),
        });

        const satoshi = await btcCanister.getBalanceQuery({
          address,
          network,
          minConfirmations: min_confirmations,
        });

        const text = JSON.stringify(
          {
            address,
            network,
            min_confirmations,
            confirmed_satoshis: satoshi.toString(),
            confirmed_btc: (Number(satoshi) / 1e8).toFixed(8),
            source: 'icp-bitcoin-canister',
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
  //
  // Uses the ICP Bitcoin canister getUtxosQuery.
  // Returns confirmed UTXOs only. txid is returned as hex string.
  server.tool(
    'bitcoin_get_utxos',
    'Get confirmed unspent transaction outputs (UTXOs) for a Bitcoin address via ICP Bitcoin canister',
    {
      address: z.string().describe('Bitcoin address'),
      network: z.enum(['mainnet', 'testnet']).default('mainnet'),
    },
    async ({ address, network }) => {
      const key = makeCacheKey('bitcoin_get_utxos', { address, network });
      const cached = cacheGet<string>(key);
      if (cached) return { content: [{ type: 'text', text: cached }] };

      try {
        const btcCanister = BitcoinCanister.create({
          agent: opts.agent,
          canisterId: Principal.fromText(BITCOIN_CANISTER_IDS[network]),
        });

        const result = await btcCanister.getUtxosQuery({ address, network });

        type Utxo = { height: number; value: bigint; outpoint: { txid: Uint8Array; vout: number } };
        const utxos = result.utxos.map((u: Utxo) => ({
          txid: Buffer.from(u.outpoint.txid).toString('hex'),
          vout: u.outpoint.vout,
          value_satoshis: u.value.toString(),
          value_btc: (Number(u.value) / 1e8).toFixed(8),
          block_height: u.height,
          confirmed: u.height > 0,
        }));

        const totalSatoshi = result.utxos.reduce((sum: bigint, u: Utxo) => sum + u.value, 0n);

        const text = JSON.stringify(
          {
            address,
            network,
            utxo_count: utxos.length,
            total_satoshis: totalSatoshi.toString(),
            total_btc: (Number(totalSatoshi) / 1e8).toFixed(8),
            tip_height: result.tip_height,
            source: 'icp-bitcoin-canister',
            utxos,
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
  //
  // Uses Mempool.space — the Bitcoin canister's fee percentile method is an
  // update call (canister-only, requires cycles). Mempool.space is the
  // pragmatic choice for external fee rate reads.
  server.tool(
    'bitcoin_get_fee_rates',
    'Get current Bitcoin fee rate recommendations in sat/vByte (via Mempool.space)',
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
  //
  // Uses Mempool.space — the Bitcoin canister's send_transaction is an update
  // call (canister-to-canister only, requires cycles). External JS clients
  // must use a traditional broadcast API.
  server.tool(
    'bitcoin_broadcast_transaction',
    [
      'Broadcast a signed Bitcoin transaction to the network via Mempool.space.',
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

      // Idempotency guard — detect duplicate submissions within the session
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
