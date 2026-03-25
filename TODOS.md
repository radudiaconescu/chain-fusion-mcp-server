# TODOS

## Chain Fusion

**Add ICRC-1 transfer recovery (startup pending log scan)**
- **Priority:** P1
- **What:** On server start, read the ICRC-1 transfer log and query `get_transactions` for any entry with `status: "pending"`. Auto-settle entries that landed; emit a startup warning for entries still pending after a configurable age threshold.
- **Why:** A Claude session that times out mid-transfer leaves a dangling `pending` log entry. Without recovery, the log grows with unresolved entries and users have no visibility into whether the transfer went through.
- **Context:** Store a unique `memo` (u64 timestamp-based) in each transfer call. Use `IcrcLedgerCanister.getTransactions()` filtering by memo to check settlement. ckBTC/ckETH/ckUSDC on mainnet support ICRC-3 transaction queries. Start point: `src/transfer-log.ts` `loadPending()` + `IcrcLedgerCanister.getTransactions()`.
- **Depends on:** cktoken_transfer TODO above

**Add t-ECDSA DurableTransferLog (native Bitcoin/ETH signing)**
- **Priority:** P2
- **What:** A durable request log for ICP threshold-ECDSA signing calls — persists `requestId` to disk BEFORE calling the ICP signing endpoint so recovery is possible after a 30s timeout. Recovery uses `agent.fetchCertifiedResponse(requestId)`.
- **Why:** ICP t-ECDSA signing takes up to 30 seconds. If Claude's MCP session times out mid-call, there's no way to know whether the transaction was submitted. The ICRC-1 transfer log built in v0.2.0 uses a different recovery path (memo-based get_transactions) — t-ECDSA needs its own mechanism.
- **Context:** Different from the ICRC-1 transfer log (which uses memo+get_transactions for recovery). The t-ECDSA log schema: `{requestId: string, method: string, args: object, timestamp: number, status: "pending"|"submitted"|"failed"}`. Extend `src/transfer-log.ts` or create `src/signing-log.ts`. Only relevant once a native ICP signing tool is built (ckbtc_withdraw or icp_sign_transaction).
- **Depends on:** Future PR adding ICP native signing

**Fix 3 critical gaps before enabling writes in production**
- **Priority:** P0
- **What:** (1) ICRC-1 transfer log — persist transfer args to JSONL before ICP call so timeout recovery is possible (see also: ICRC-1 transfer recovery TODO and t-ECDSA log TODO for the full story). (2) EVM error detection — `extractEvmResult()` in `errors.ts` may miss edge cases where ic-evm-rpc embeds errors in non-standard shapes. (3) Cycles budget config — add `CYCLES_BUDGET_E8S` env var to cap per-session ICP spend.
- **Why:** Without (2), EVM errors surface as "unknown error" to Claude. Without (3), a runaway session burns unlimited cycles. Without (1), a 30s ICP update call timeout leaves no recovery path.
- **Context:** (2) fix: extend `isEvmRpcError()` guard in `errors.ts` + add tests for embedded JSON object, plain text, and nested stringified shapes. (3) fix: add `cyclesBudgetE8s: z.coerce.number().optional()` to `config.ts` Zod schema; pass to agent; enforce before each update call. (1) is the ICRC-1 transfer log described in the cktoken_transfer TODO above.
- **Depends on:** Nothing — can be done in parallel
- **Progress:** (1) ✅ v0.2.0 — ICRC-1 transfer log built. (2) ✅ v0.2.0 — EVM error shapes 2+4 fixed. (3) ⚠️ v0.2.0 — config field added, enforcement deferred to next PR.

**Add generic ICP canister tool**
- **Priority:** P2
- **What:** `icp_canister_query(canisterId, method, argsJson)` and `icp_canister_update(...)` using Candid runtime encoding.
- **Why:** Makes the server a universal ICP interface — Claude can interact with any deployed canister, not just hardcoded ones.
- **Context:** Requires Candid runtime arg encoding (didc WASM or `@dfinity/candid` programmatic API). Fetch the canister's .did interface first, then encode args. The main challenge is surfacing encoding errors helpfully to Claude.
- **Depends on:** PR 1 merged

**Add Ed25519 PEM parsing unit tests**
- **Priority:** P2
- **What:** Test `identityFromPem()` with a fixture PEM, invalid PEM, and secp256k1 PEM (should throw with helpful message).
- **Why:** Identity loading is the most critical startup path — a failure here breaks every tool.
- **Depends on:** Nothing

## Completed

**Add cktoken_transfer tool (ICRC-1)**
- **What:** `cktoken_transfer` tool for ckBTC, ckETH, ckUSDC using `@dfinity/ledger-icrc` ICRC-1 `transfer()`. Amount as `z.string()` → `BigInt(amount)`. Confirm guard, in-session idempotency Set, durable JSONL transfer log.
- **Completed:** v0.2.0 (2026-03-25)

**Add unit tests for cktokens.ts**
- **What:** Mock `IcrcLedgerCanister.create()` and test `cktoken_get_balance` + `cktoken_transfer` — balance formatting, ckETH 18-decimal bigint precision, transfer preview/confirm/idempotency/error paths.
- **Completed:** v0.2.0 (2026-03-25)