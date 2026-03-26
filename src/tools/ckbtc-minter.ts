import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HttpAgent } from '@icp-sdk/core/agent';
import { CkBtcMinterCanister } from '@icp-sdk/canisters/ckbtc';
import { Principal } from '@icp-sdk/core/principal';
import { cacheGet, cacheSet, makeCacheKey } from '../cache.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { toMcpError } from '../errors.js';
import type { CyclesBudget } from '../cycles-budget.js';
import { appendWithdrawalPending, markWithdrawalSettled } from '../withdrawal-log.js';

/**
 * ckBTC minter canister IDs.
 * Mainnet: mqygn-kiaaa-aaaar-qaadq-cai
 * Testnet: ml52i-qqaaa-aaaar-qaaba-cai
 */
const MINTER_IDS = {
  mainnet: 'mqygn-kiaaa-aaaar-qaadq-cai',
  testnet: 'ml52i-qqaaa-aaaar-qaaba-cai',
} as const;

type Network = 'mainnet' | 'testnet';

// ─── Minter error type guards ─────────────────────────────────────────────────
// The @icp-sdk/canisters/ckbtc error classes exist at runtime but their TypeScript
// exports fail to resolve under NodeNext module resolution (no .js counterpart for
// the errors/ sub-directory). We use duck-typing type guards instead.

type MinterNoNewUtxosShape = {
  pendingUtxos: Array<{ confirmations: number; value: bigint; outpoint: { txid: Uint8Array; vout: number } }>;
  requiredConfirmations: number;
};

function isMinterNoNewUtxosError(err: unknown): err is Error & MinterNoNewUtxosShape {
  return (
    err instanceof Error &&
    'pendingUtxos' in err &&
    'requiredConfirmations' in err
  );
}

function isMinterErrorByName(err: unknown, name: string): err is Error {
  return err instanceof Error && err.constructor.name === name;
}

function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length !== 64) {
    throw new Error('Subaccount must be a 32-byte hex string (64 hex chars)');
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Serialize a RetrieveBtcStatusV2 variant to a plain string.
 * The variants from the Candid DID are tagged objects.
 */
function serializeWithdrawalStatus(status: unknown): string {
  if (status === null || status === undefined) return 'Unknown';
  if (typeof status === 'object') {
    const s = status as Record<string, unknown>;
    if ('Pending' in s) return 'Pending';
    if ('Signing' in s) return 'Signing';
    if ('Sending' in s) return `Sending (txid: ${uint8ArrayToHex(s['Sending'] as unknown as Uint8Array)})`;
    if ('Submitted' in s) {
      const sub = s['Submitted'] as { txid: Uint8Array };
      return `Submitted (txid: ${uint8ArrayToHex(sub.txid)})`;
    }
    if ('Confirmed' in s) {
      const conf = s['Confirmed'] as { txid: Uint8Array };
      return `Confirmed (txid: ${uint8ArrayToHex(conf.txid)})`;
    }
    if ('AmountTooLow' in s) return 'AmountTooLow';
    if ('WillReimburse' in s) return 'WillReimburse';
    if ('Reimbursed' in s) return 'Reimbursed';
    if ('Unknown' in s) return 'Unknown';
  }
  return String(status);
}

// In-session fingerprints — prevents Claude from submitting the same withdrawal twice.
const submittedWithdrawalFingerprints = new Set<string>();

export function registerCkBtcMinterTools(
  server: McpServer,
  agent: HttpAgent,
  opts?: { budget?: CyclesBudget },
): void {
  // ─── ckbtc_get_deposit_address ────────────────────────────────────────────
  //
  // Flow:
  //   getBtcAddress (UPDATE call — 2-5s, costs cycles)
  //        │
  //   cache for session (address is deterministic for principal+subaccount+network)
  //        │
  //   return { address, address_is_permanent: true }
  //
  server.tool(
    'ckbtc_get_deposit_address',
    [
      'Get the Bitcoin deposit address for an ICP principal to receive ckBTC.',
      'Send BTC to this address, wait for 6+ confirmations, then call ckbtc_update_balance to mint ckBTC.',
      'The address is unique to your principal and permanent — you can reuse it.',
      'Note: this is an ICP update call (2-5 seconds) and costs a small amount of cycles.',
    ].join(' '),
    {
      principal: z.string().describe('ICP principal ID to get the BTC deposit address for'),
      subaccount: z
        .string()
        .optional()
        .describe('Optional 32-byte subaccount in hex (64 hex chars)'),
      network: z.enum(['mainnet', 'testnet']).default('mainnet'),
    },
    async ({ principal, subaccount, network }) => {
      const key = makeCacheKey('ckbtc_get_deposit_address', { principal, subaccount, network });
      const cached = cacheGet<string>(key);
      if (cached) return { content: [{ type: 'text', text: cached }] };

      try {
        opts?.budget?.charge();

        const minter = CkBtcMinterCanister.create({
          agent,
          canisterId: Principal.fromText(MINTER_IDS[network]),
        });

        const ownerPrincipal = Principal.fromText(principal);
        const subaccountBytes = subaccount ? hexToUint8Array(subaccount) : undefined;

        const address = await minter.getBtcAddress({
          owner: ownerPrincipal,
          subaccount: subaccountBytes,
        });

        const text = JSON.stringify(
          {
            address,
            principal,
            subaccount: subaccount ?? null,
            network,
            address_is_permanent: true,
            note: 'This address is unique to your principal. BTC sent here will mint ckBTC after 6+ confirmations. Call ckbtc_update_balance to trigger minting.',
          },
          null,
          2,
        );

        cacheSet(key, text);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        throw toMcpError(err, 'ckbtc_get_deposit_address');
      }
    },
  );

  // ─── ckbtc_update_balance ─────────────────────────────────────────────────
  //
  // Flow:
  //   updateBalance (UPDATE call — costs cycles)
  //        │
  //   MinterNoNewUtxosError? ──► structured pending response (NOT an error)
  //        │
  //   UtxoStatus[] → classify: Minted | Checked | ValueTooSmall | Tainted
  //        │
  //   return { status, minted_satoshis, tainted_utxos, entries }
  //
  server.tool(
    'ckbtc_update_balance',
    [
      'Trigger ckBTC minting after BTC has been deposited and confirmed on-chain.',
      'Call this after sending BTC to the address from ckbtc_get_deposit_address and waiting for 6+ confirmations.',
      'Returns per-UTXO minting status. If BTC is not yet confirmed, returns a pending response — retry in ~10 minutes.',
    ].join(' '),
    {
      principal: z.string().describe('ICP principal ID that sent the BTC deposit'),
      subaccount: z
        .string()
        .optional()
        .describe('Optional 32-byte subaccount in hex (64 hex chars)'),
      network: z.enum(['mainnet', 'testnet']).default('mainnet'),
    },
    async ({ principal, subaccount, network }) => {
      try {
        opts?.budget?.charge();

        const minter = CkBtcMinterCanister.create({
          agent,
          canisterId: Principal.fromText(MINTER_IDS[network]),
        });

        const ownerPrincipal = Principal.fromText(principal);
        const subaccountBytes = subaccount ? hexToUint8Array(subaccount) : undefined;

        let utxoStatuses: Awaited<ReturnType<typeof minter.updateBalance>>;
        try {
          utxoStatuses = await minter.updateBalance({
            owner: ownerPrincipal,
            subaccount: subaccountBytes,
          });
        } catch (err) {
          // MinterNoNewUtxosError is NOT an error condition — it means BTC not yet confirmed.
          if (isMinterNoNewUtxosError(err)) {
            const text = JSON.stringify(
              {
                status: 'pending_confirmations',
                pending_utxos: err.pendingUtxos.length,
                required_confirmations: err.requiredConfirmations,
                retry_after_seconds: 600,
                note: `BTC detected but not yet confirmed. Needs ${err.requiredConfirmations} confirmations. Retry in ~10 minutes.`,
              },
              null,
              2,
            );
            return { content: [{ type: 'text', text }] };
          }
          throw err;
        }

        // Classify UtxoStatus variants
        let mintedSatoshis = BigInt(0);
        let taintedCount = 0;
        let checkedCount = 0;
        let tooSmallCount = 0;
        const entries: unknown[] = [];

        for (const status of utxoStatuses) {
          if ('Minted' in status) {
            mintedSatoshis += status.Minted.minted_amount;
            entries.push({
              type: 'Minted',
              minted_amount: status.Minted.minted_amount.toString(),
              block_index: status.Minted.block_index.toString(),
              txid: uint8ArrayToHex(status.Minted.utxo.outpoint.txid),
              vout: status.Minted.utxo.outpoint.vout,
            });
          } else if ('Tainted' in status) {
            taintedCount++;
            entries.push({
              type: 'Tainted',
              txid: uint8ArrayToHex(status.Tainted.outpoint.txid),
              vout: status.Tainted.outpoint.vout,
              value: status.Tainted.value.toString(),
            });
          } else if ('Checked' in status) {
            checkedCount++;
            entries.push({
              type: 'Checked',
              txid: uint8ArrayToHex(status.Checked.outpoint.txid),
              vout: status.Checked.outpoint.vout,
            });
          } else if ('ValueTooSmall' in status) {
            tooSmallCount++;
            entries.push({
              type: 'ValueTooSmall',
              txid: uint8ArrayToHex(status.ValueTooSmall.outpoint.txid),
              vout: status.ValueTooSmall.outpoint.vout,
              value: status.ValueTooSmall.value.toString(),
            });
          }
        }

        const overallStatus =
          taintedCount > 0 && mintedSatoshis === BigInt(0)
            ? 'tainted'
            : mintedSatoshis > BigInt(0)
              ? 'minted'
              : 'no_new_utxos';

        const text = JSON.stringify(
          {
            status: overallStatus,
            minted_satoshis: mintedSatoshis.toString(),
            tainted_utxos: taintedCount,
            checked_utxos: checkedCount,
            too_small_utxos: tooSmallCount,
            entries,
            ...(taintedCount > 0
              ? { note: 'Some UTXOs were flagged by KYT analysis and cannot be minted.' }
              : {}),
          },
          null,
          2,
        );

        return { content: [{ type: 'text', text }] };
      } catch (err) {
        if (isMinterErrorByName(err, 'MinterTemporaryUnavailableError')) {
          throw toMcpError(
            new Error('ckBTC minter is temporarily unavailable. Retry in a few minutes.'),
            'ckbtc_update_balance',
          );
        }
        if (isMinterErrorByName(err, 'MinterAlreadyProcessingError')) {
          throw toMcpError(
            new Error(
              'Minter is already processing an update_balance request for this principal. Wait and retry.',
            ),
            'ckbtc_update_balance',
          );
        }
        throw toMcpError(err, 'ckbtc_update_balance');
      }
    },
  );

  // ─── ckbtc_get_withdrawal_account ─────────────────────────────────────────
  //
  // Returns the ICP account that ckBTC must be transferred to BEFORE calling
  // ckbtc_withdraw. The 2-step flow:
  //   1. cktoken_transfer(ckBTC, withdrawal_account, amount)
  //   2. ckbtc_withdraw(btc_address, amount)
  //
  server.tool(
    'ckbtc_get_withdrawal_account',
    [
      'Get the ICP account that ckBTC must be transferred to before withdrawing BTC.',
      'Step 1: Transfer ckBTC to this account using cktoken_transfer.',
      'Step 2: Call ckbtc_withdraw with your BTC destination address.',
    ].join(' '),
    {
      network: z.enum(['mainnet', 'testnet']).default('mainnet'),
    },
    async ({ network }) => {
      const key = makeCacheKey('ckbtc_get_withdrawal_account', { network });
      const cached = cacheGet<string>(key);
      if (cached) return { content: [{ type: 'text', text: cached }] };

      try {
        const minter = CkBtcMinterCanister.create({
          agent,
          canisterId: Principal.fromText(MINTER_IDS[network]),
        });

        const account = await minter.getWithdrawalAccount();

        const subaccount =
          account.subaccount.length > 0 ? uint8ArrayToHex(account.subaccount[0]!) : null;

        const text = JSON.stringify(
          {
            owner: account.owner.toText(),
            subaccount,
            network,
            instructions:
              'Transfer ckBTC to this account using cktoken_transfer (token: "ckBTC", to: owner, subaccount if present), then call ckbtc_withdraw with your BTC destination address and amount.',
          },
          null,
          2,
        );

        cacheSet(key, text);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        throw toMcpError(err, 'ckbtc_get_withdrawal_account');
      }
    },
  );

  // ─── ckbtc_withdraw ───────────────────────────────────────────────────────
  //
  // Flow:
  //   confirm=false ──► preview (fee estimate + minimum check)
  //        │
  //   idempotency check
  //        │
  //   getMinterInfo() → validate amount >= retrieve_btc_min_amount
  //        │
  //   budget.charge()
  //        │
  //   appendWithdrawalPending()  ← BEFORE ICP call
  //        │
  //   retrieveBtc({ address, amount })
  //        │
  //   markWithdrawalSettled("settled", { block_index })
  //        │
  //   return { success, block_index, status: "pending" }
  //
  server.tool(
    'ckbtc_withdraw',
    [
      'Withdraw ckBTC to a Bitcoin address (ckBTC → BTC).',
      'PREREQUISITE: First call ckbtc_get_withdrawal_account, then transfer ckBTC to that account using cktoken_transfer.',
      'Call without confirm first to preview fees. Pass confirm: true to execute.',
      'Amount is in satoshis as a string. Minimum amount is enforced by the minter (typically ~1000 sat).',
      'BTC arrives in 1-24 hours. Use ckbtc_withdrawal_status to track progress.',
    ].join(' '),
    {
      amount_satoshi: z
        .string()
        .describe(
          'Amount in satoshis as a string (e.g. "100000" = 0.001 BTC). String required to avoid precision loss.',
        ),
      btc_address: z.string().describe('Bitcoin destination address (mainnet or testnet)'),
      network: z.enum(['mainnet', 'testnet']).default('mainnet'),
      confirm: z
        .literal(true)
        .optional()
        .describe('Pass true to execute. Omit to preview only.'),
    },
    async ({ amount_satoshi, btc_address, network, confirm }) => {
      // Parse amount as BigInt early — fail fast before any calls
      let amountBigInt: bigint;
      try {
        amountBigInt = BigInt(amount_satoshi);
      } catch {
        throw toMcpError(
          new Error(
            `Invalid amount_satoshi "${amount_satoshi}" — must be a decimal integer string (e.g. "100000")`,
          ),
          'ckbtc_withdraw',
        );
      }

      const minter = CkBtcMinterCanister.create({
        agent,
        canisterId: Principal.fromText(MINTER_IDS[network]),
      });

      // Preview mode — show fee estimate and minimum
      if (!confirm) {
        try {
          const [feeInfo, minterInfo] = await Promise.all([
            minter.estimateWithdrawalFee({ certified: false, amount: amountBigInt }),
            minter.getMinterInfo({ certified: false }),
          ]);

          const totalFee = feeInfo.minter_fee + feeInfo.bitcoin_fee;
          const netAmount = amountBigInt - totalFee;
          const minAmount = minterInfo.retrieve_btc_min_amount;

          const belowMin = amountBigInt < minAmount;

          return {
            content: [
              {
                type: 'text',
                text: [
                  '⚠️  Withdrawal Preview',
                  `Amount:         ${amount_satoshi} sat (${(Number(amountBigInt) / 1e8).toFixed(8)} BTC)`,
                  `Destination:    ${btc_address}`,
                  `Network:        ${network}`,
                  `Minter fee:     ${feeInfo.minter_fee} sat`,
                  `BTC network fee: ${feeInfo.bitcoin_fee} sat`,
                  `Total fees:     ${totalFee} sat`,
                  `Net BTC to receive: ${netAmount > BigInt(0) ? netAmount : '0'} sat`,
                  `Minimum withdrawal: ${minAmount} sat`,
                  belowMin
                    ? `\n❌ Amount is below minimum withdrawal (${minAmount} sat). Increase amount.`
                    : '\nTo execute: call again with confirm: true',
                  '\nNote: Make sure ckBTC is already transferred to the withdrawal account (ckbtc_get_withdrawal_account).',
                ].join('\n'),
              },
            ],
          };
        } catch (err) {
          throw toMcpError(err, 'ckbtc_withdraw');
        }
      }

      // Confirm mode — execute withdrawal
      const fingerprint = JSON.stringify({ amount_satoshi, btc_address, network });
      if (submittedWithdrawalFingerprints.has(fingerprint)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { warning: 'Withdrawal already submitted this session — not resubmitting' },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Validate minimum amount before charging budget
      try {
        const minterInfo = await minter.getMinterInfo({ certified: false });
        const minAmount = minterInfo.retrieve_btc_min_amount;
        if (amountBigInt < minAmount) {
          throw toMcpError(
            new Error(
              `Amount ${amount_satoshi} sat is below minimum withdrawal amount (${minAmount} sat). Increase the amount.`,
            ),
            'ckbtc_withdraw',
          );
        }
      } catch (err) {
        // Re-throw McpError as-is (e.g. budget exceeded, min amount check); wrap others
        if (err instanceof McpError) throw err;
        throw toMcpError(err, 'ckbtc_withdraw');
      }

      opts?.budget?.charge();

      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await appendWithdrawalPending({
        id,
        btc_address,
        amount_satoshi,
        timestamp: Date.now(),
      });

      try {
        const result = await minter.retrieveBtc({
          address: btc_address,
          amount: amountBigInt,
        });

        const blockIndex = result.block_index.toString();
        await markWithdrawalSettled(id, 'settled', { block_index: blockIndex });
        submittedWithdrawalFingerprints.add(fingerprint);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  block_index: blockIndex,
                  amount_satoshi,
                  btc_address,
                  network,
                  status: 'pending',
                  note: 'Withdrawal initiated. Bitcoin will arrive in 1-24 hours. Track progress with ckbtc_withdrawal_status.',
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await markWithdrawalSettled(id, 'error', { error: errMsg });

        if (isMinterErrorByName(err, 'MinterMalformedAddressError')) {
          throw toMcpError(
            new Error(`Invalid BTC address "${btc_address}": ${errMsg}`),
            'ckbtc_withdraw',
          );
        }
        if (isMinterErrorByName(err, 'MinterAmountTooLowError')) {
          throw toMcpError(
            new Error(`Amount ${amount_satoshi} sat is too low for withdrawal: ${errMsg}`),
            'ckbtc_withdraw',
          );
        }
        if (isMinterErrorByName(err, 'MinterInsufficientFundsError')) {
          throw toMcpError(
            new Error(
              `Insufficient ckBTC in withdrawal account. Transfer ckBTC to the withdrawal account first (ckbtc_get_withdrawal_account → cktoken_transfer).`,
            ),
            'ckbtc_withdraw',
          );
        }
        if (isMinterErrorByName(err, 'MinterTemporaryUnavailableError')) {
          throw toMcpError(
            new Error('ckBTC minter temporarily unavailable. Retry in a few minutes.'),
            'ckbtc_withdraw',
          );
        }
        if (isMinterErrorByName(err, 'MinterAlreadyProcessingError')) {
          throw toMcpError(
            new Error('Minter is already processing a withdrawal for this principal. Wait and retry.'),
            'ckbtc_withdraw',
          );
        }
        throw toMcpError(err, 'ckbtc_withdraw');
      }
    },
  );

  // ─── ckbtc_withdrawal_status ──────────────────────────────────────────────
  //
  // Query — no cycles, returns status of all pending withdrawals for caller.
  //
  server.tool(
    'ckbtc_withdrawal_status',
    [
      'Get the status of all pending ckBTC → BTC withdrawal requests for the current identity.',
      'Status values: Pending, Signing, Sending, Submitted, Confirmed, AmountTooLow, Reimbursed.',
      '"Confirmed" means BTC has been sent on-chain.',
    ].join(' '),
    {
      network: z.enum(['mainnet', 'testnet']).default('mainnet'),
    },
    async ({ network }) => {
      try {
        const minter = CkBtcMinterCanister.create({
          agent,
          canisterId: Principal.fromText(MINTER_IDS[network]),
        });

        const statuses = await minter.retrieveBtcStatusV2ByAccount({ certified: false });

        const withdrawals = statuses.map((entry: { id: bigint; status: unknown }) => ({
          block_index: entry.id.toString(),
          status: entry.status ? serializeWithdrawalStatus(entry.status) : 'Unknown',
        }));

        const text = JSON.stringify(
          {
            network,
            withdrawal_count: withdrawals.length,
            withdrawals,
          },
          null,
          2,
        );

        return { content: [{ type: 'text', text }] };
      } catch (err) {
        throw toMcpError(err, 'ckbtc_withdrawal_status');
      }
    },
  );
}
