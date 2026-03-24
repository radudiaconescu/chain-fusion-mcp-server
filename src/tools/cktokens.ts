import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpAgent } from '@dfinity/agent';
import { IcrcLedgerCanister } from '@dfinity/ledger-icrc';
import { Principal } from '@dfinity/principal';
import { cacheGet, cacheSet, makeCacheKey } from '../cache.js';
import { toMcpError } from '../errors.js';

/**
 * Chain Fusion token canister IDs on ICP mainnet.
 * These are ICRC-1 ledger canisters — their balance queries are
 * regular query calls and require NO cycles from the caller.
 *
 * ckBTC  : Bitcoin locked in ICP custody, redeemable 1:1
 * ckETH  : Ether locked in ICP custody, redeemable 1:1
 * ckUSDC : USDC locked in ICP custody, redeemable 1:1
 */
const CANISTER_IDS = {
  mainnet: {
    ckbtc: 'mxzaz-hqaaa-aaaar-qaada-cai',
    cketh: 'ss2fx-dyaaa-aaaar-qacoq-cai',
    ckusdc: 'xevnm-gaaaa-aaaar-qafnq-cai',
  },
  testnet: {
    // IC testnet (Fiduciary subnet) — update if using a local dfx replica
    ckbtc: 'mc6ru-gyaaa-aaaar-qaaaq-cai',
    cketh: 'apia6-jaaaa-aaaar-qabma-cai',
    ckusdc: 'yfumr-cyaaa-aaaar-qaela-cai',
  },
} as const;

type TokenSymbol = 'ckBTC' | 'ckETH' | 'ckUSDC';
type Network = 'mainnet' | 'testnet';

const TOKEN_DECIMALS: Record<TokenSymbol, number> = {
  ckBTC: 8,
  ckETH: 18,
  ckUSDC: 6,
};

function getCanisterId(token: TokenSymbol, network: Network): string {
  const key = token.toLowerCase() as 'ckbtc' | 'cketh' | 'ckusdc';
  return CANISTER_IDS[network][key];
}

async function queryIcrcBalance(
  agent: HttpAgent,
  canisterId: string,
  owner: string,
  subaccount?: string,
): Promise<bigint> {
  const ledger = IcrcLedgerCanister.create({
    agent,
    canisterId: Principal.fromText(canisterId),
  });

  const ownerPrincipal = Principal.fromText(owner);
  const subaccountBytes = subaccount
    ? hexToUint8Array(subaccount)
    : undefined;

  return ledger.balance({
    owner: ownerPrincipal,
    subaccount: subaccountBytes,
  });
}

function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length !== 64) {
    throw new Error('Subaccount must be a 32-byte hex string (64 hex chars)');
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}

function formatTokenAmount(raw: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  return `${whole}.${frac.toString().padStart(decimals, '0')}`;
}

export function registerCkTokenTools(server: McpServer, agent: HttpAgent): void {
  // ─── cktoken_get_balance ──────────────────────────────────────────────────
  server.tool(
    'cktoken_get_balance',
    [
      'Get the balance of a Chain Fusion token (ckBTC, ckETH, or ckUSDC) for an ICP principal.',
      'These are ICP-native representations of Bitcoin, Ether, and USDC — redeemable 1:1.',
      'This is a genuine ICP query call going through the Internet Computer.',
    ].join(' '),
    {
      token: z
        .enum(['ckBTC', 'ckETH', 'ckUSDC'])
        .describe('Chain Fusion token to query'),
      principal: z
        .string()
        .describe('ICP principal ID (e.g. aaaaa-aa or the textual form)'),
      subaccount: z
        .string()
        .optional()
        .describe('Optional 32-byte subaccount in hex (64 hex chars)'),
      network: z.enum(['mainnet', 'testnet']).default('mainnet'),
    },
    async ({ token, principal, subaccount, network }) => {
      const key = makeCacheKey('cktoken_get_balance', { token, principal, subaccount, network });
      const cached = cacheGet<string>(key);
      if (cached) return { content: [{ type: 'text', text: cached }] };

      try {
        const canisterId = getCanisterId(token as TokenSymbol, network);
        const rawBalance = await queryIcrcBalance(
          agent,
          canisterId,
          principal,
          subaccount,
        );

        const decimals = TOKEN_DECIMALS[token as TokenSymbol];
        const text = JSON.stringify(
          {
            token,
            principal,
            subaccount: subaccount ?? null,
            network,
            canister_id: canisterId,
            balance_raw: rawBalance.toString(),
            balance_formatted: formatTokenAmount(rawBalance, decimals),
          },
          null,
          2,
        );

        cacheSet(key, text);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        throw toMcpError(err, 'cktoken_get_balance');
      }
    },
  );
}
