import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpAgent } from '@icp-sdk/core/agent';
import { IcrcLedgerCanister } from '@icp-sdk/canisters/ledger/icrc';
import { Principal } from '@icp-sdk/core/principal';
import { cacheGet, cacheSet, makeCacheKey } from '../cache.js';
import { toMcpError } from '../errors.js';
import { appendPending, markSettled } from '../transfer-log.js';
import type { CyclesBudget } from '../cycles-budget.js';

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

// In-session fingerprints — prevents Claude from submitting the same transfer twice.
// Cleared on server restart (sufficient for single-session safety).
// For cross-session durability see transfer-log.ts.
const submittedTransferFingerprints = new Set<string>();

export function registerCkTokenTools(
  server: McpServer,
  agent: HttpAgent,
  opts?: { budget?: CyclesBudget },
): void {
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

  // ─── cktoken_transfer ─────────────────────────────────────────────────────
  //
  // Transfer flow:
  //
  //   cktoken_transfer(token, to, amount, confirm)
  //           │
  //           ├─ confirm=false ──► preview (no log write, no ICP call)
  //           │
  //           ├─ in-session duplicate? ──► idempotency warning
  //           │
  //           ├─ validate: BigInt(amount) parseable?
  //           │       └─ invalid ──► Zod validation error before ICP call
  //           │
  //           ├─ transfer-log.appendPending(...)    ← BEFORE ICP call
  //           │       └─ ENOSPC? ──► warn stderr, continue
  //           │
  //           ├─ IcrcLedgerCanister.transfer({ to, amount: BigInt(amount), memo })
  //           │       ├─ success ──► markSettled(id, "settled")
  //           │       │               └─ return { success, blockIndex }
  //           │       └─ throws  ──► markSettled(id, "error", msg)
  //           │                       └─ toMcpError(err, 'cktoken_transfer')
  //           │
  //           └─ submittedTransferFingerprints.add(fingerprint)
  //
  // IMPORTANT: `amount` is z.string() — NOT z.number().
  // ckETH has 18 decimals. 10 ETH = 10_000_000_000_000_000_000n which is far
  // beyond Number.MAX_SAFE_INTEGER (2^53 - 1 ≈ 9e15). Using z.number() would
  // silently corrupt any ckETH amount above ~0.009 ETH via IEEE 754 precision loss.
  server.tool(
    'cktoken_transfer',
    [
      'Transfer Chain Fusion tokens (ckBTC, ckETH, or ckUSDC) to an ICP principal via ICRC-1.',
      'Call without confirm first to preview. Pass confirm: true to execute.',
      'Amount must be provided as a string in the token\'s smallest unit (e8s for ckBTC, wei for ckETH, 6-decimal units for ckUSDC).',
    ].join(' '),
    {
      token: z.enum(['ckBTC', 'ckETH', 'ckUSDC']).describe('Chain Fusion token to transfer'),
      to: z.string().describe('Destination ICP principal ID'),
      amount: z
        .string()
        .describe(
          'Amount in smallest unit as a string (e.g. "100000000" = 1 ckBTC, "1000000000000000000" = 1 ckETH). String is required to preserve precision — ckETH exceeds JavaScript safe integer range.',
        ),
      subaccount: z
        .string()
        .optional()
        .describe('Optional destination subaccount (32-byte hex, 64 chars)'),
      network: z.enum(['mainnet', 'testnet']).default('mainnet'),
      confirm: z
        .literal(true)
        .optional()
        .describe('Pass true to execute. Omit to preview only.'),
    },
    async ({ token, to, amount, subaccount, network, confirm }) => {
      // Preview mode — no side effects
      if (!confirm) {
        const decimals = TOKEN_DECIMALS[token as TokenSymbol];
        const amountBigInt = BigInt(amount);
        return {
          content: [
            {
              type: 'text',
              text: [
                '⚠️  Transfer Preview',
                `Token:  ${token}`,
                `To:     ${to}`,
                `Amount: ${amount} (${formatTokenAmount(amountBigInt, decimals)} ${token})`,
                `Network: ${network}`,
                '',
                'To execute, call this tool again with confirm: true',
              ].join('\n'),
            },
          ],
        };
      }

      // In-session idempotency check
      const fingerprint = JSON.stringify({ token, to, amount, subaccount, network });
      if (submittedTransferFingerprints.has(fingerprint)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { warning: 'Transfer already submitted this session — not resubmitting' },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Parse amount as BigInt (Zod schema guarantees it's a string)
      let amountBigInt: bigint;
      try {
        amountBigInt = BigInt(amount);
      } catch {
        throw toMcpError(
          new Error(`Invalid amount "${amount}" — must be a decimal integer string (e.g. "100000000")`),
          'cktoken_transfer',
        );
      }

      const canisterId = getCanisterId(token as TokenSymbol, network);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // Check cycles budget BEFORE writing to log and making the ICP call.
      // Throws McpError if the session has exceeded its configured cycle cap,
      // keeping the transfer log clean (no dangling pending entries).
      opts?.budget?.charge();

      // Persist intent BEFORE the ICP call (non-fatal if log write fails).
      // The log id is used for settlement tracking; memo is omitted from the
      // ICP transfer call because the SDK memo type varies by canister version.
      await appendPending({ id, token, to, amount, memo: id, timestamp: Date.now() });

      try {
        const ledger = IcrcLedgerCanister.create({
          agent,
          canisterId: Principal.fromText(canisterId),
        });

        const toPrincipal = Principal.fromText(to);
        const toSubaccountBytes = subaccount ? hexToUint8Array(subaccount) : undefined;

        const blockIndex = await ledger.transfer({
          to: { owner: toPrincipal, subaccount: toSubaccountBytes ? [toSubaccountBytes] : [] },
          amount: amountBigInt,
        });

        await markSettled(id, 'settled');
        submittedTransferFingerprints.add(fingerprint);

        const decimals = TOKEN_DECIMALS[token as TokenSymbol];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  token,
                  to,
                  amount_raw: amount,
                  amount_formatted: `${formatTokenAmount(amountBigInt, decimals)} ${token}`,
                  block_index: blockIndex.toString(),
                  network,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        await markSettled(id, 'error', err instanceof Error ? err.message : String(err));
        throw toMcpError(err, 'cktoken_transfer');
      }
    },
  );
}
