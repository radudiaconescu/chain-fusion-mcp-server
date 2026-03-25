# TODOS

## Chain Fusion

**Enforce cycles budget (CYCLES_BUDGET_E8S)**
- **Priority:** P0
- **What:** Wire up the `CYCLES_BUDGET_E8S` config field to actually enforce a per-session spending cap on ICP update calls. Config parsing is in place (v0.2.0); enforcement is not.
- **Why:** A runaway Claude session could burn unlimited cycles. Without a cap, the server is not safe to leave running unattended.
- **Context:** `cyclesBudgetE8s` is parsed in `src/config.ts`. Track cumulative cycles spent in a module-level counter; check before each update call; throw `McpError` with code `INVALID_REQUEST` if over budget. Reset on server restart. The counter should be exposed in a future `chain_fusion_status` tool.
- **Depends on:** Nothing — self-contained

**Add ICRC-1 transfer recovery (startup pending log scan)**
- **Priority:** P1
- **What:** On server start, read the ICRC-1 transfer log and query `get_transactions` for any entry with `status: "pending"`. Auto-settle entries that landed; emit a startup warning for entries still pending after a configurable age threshold.
- **Why:** A Claude session that times out mid-transfer leaves a dangling `pending` log entry. Without recovery, the log grows with unresolved entries and users have no visibility into whether the transfer went through.
- **Context:** Store a unique `memo` (u64 timestamp-based) in each transfer call. Use `IcrcLedgerCanister.getTransactions()` filtering by memo to check settlement. ckBTC/ckETH/ckUSDC on mainnet support ICRC-3 transaction queries. Start point: `src/transfer-log.ts` `loadPending()` + `IcrcLedgerCanister.getTransactions()`.
- **Depends on:** Nothing

**Add ckBTC minter tools (deposit + withdraw flow)**
- **Priority:** P1
- **What:** Three new tools completing the ckBTC round-trip:
  - `ckbtc_get_deposit_address(account_principal)` — query call, returns the BTC deposit address for an ICP principal. Free, ~200ms.
  - `ckbtc_update_balance(account_principal)` — update call (2-5s), triggers ckBTC minting after a BTC deposit is confirmed. Returns new ckSatoshi minted. May return 0 if BTC hasn't confirmed yet — that's not an error, Claude should retry after ~10 minutes.
  - `ckbtc_withdraw(btc_address, amount_satoshi)` — update call, initiates ckBTC → BTC withdrawal. Confirm guard required. Minimum 600 sat (validate client-side before calling minter to avoid Candid errors). Include a durable withdrawal log (similar to `src/transfer-log.ts`) before the ICP call.
- **Why:** The ckBTC minter is already deployed on ICP mainnet and callable from the MCP server. No new infrastructure needed. This is the Chain Fusion killer demo: BTC in, instant ICP transfers, BTC out.
- **Context:** Minter mainnet: `mqygn-kiaaa-aaaar-qaadq-cai`. Minter testnet: `ml52i-qqaaa-aaaar-qaaba-cai`. `CkbtcMinterCanister` bindings exist in `@icp-sdk/canisters/ckbtc` (same module as `BitcoinCanister`). Create `src/tools/ckbtc-minter.ts` (new file). KYT gap: if a UTXO is flagged by ckBTC's Know Your Transaction analysis, `update_balance` silently returns 0. Add a note in the tool description and consider surfacing `get_known_utxos` from the minter to expose KYT status.
- **Depends on:** Nothing

**Add Ed25519/secp256k1 PEM parsing unit tests**
- **Priority:** P1
- **What:** Test `identityFromPem()` with: fixture Ed25519 PEM, fixture secp256k1 PEM, invalid PEM (should throw with helpful message), truncated PEM (should throw).
- **Why:** Identity loading is the most critical startup path — a failure here breaks every tool silently. The dual Ed25519/secp256k1 path added in v0.3.0 has zero unit test coverage.
- **Context:** Add `test/identity.test.ts`. Generate throwaway fixture keys for each type. Mock `@icp-sdk/core/identity` and `@icp-sdk/core/identity/secp256k1` to verify the correct branch is taken per key type.
- **Depends on:** Nothing

**Add chain_fusion_status dashboard tool**
- **Priority:** P2
- **What:** A single `chain_fusion_status` read tool that returns: BTC balance + fee rates, ETH balance, ckBTC/ckETH/ckUSDC balances, pending transfer log count, and cycles budget remaining. Claude's "good morning" overview call.
- **Why:** Claude currently has no way to get a multi-chain snapshot in one call. A portfolio view at the start of a session grounds Claude in its current state before taking any action.
- **Context:** Create `src/tools/status.ts`. Calls `bitcoin_get_balance`, `eth_get_balance`, `cktoken_get_balance` x3, `bitcoin_get_fee_rates` in parallel using `Promise.all`. Reads `~/.chain-fusion/pending.jsonl` entry count. Returns structured JSON. Cache aggregate for 10s. Requires all tools to accept a shared `agent` — check that the status tool can reuse existing tool logic without re-registering.
- **Depends on:** Cycles budget enforcement (to include budget remaining in output)

**Add generic ICP canister tool (with allowlist for update calls)**
- **Priority:** P2
- **What:** `icp_canister_query(canisterId, method, argsJson)` — always allowed. `icp_canister_update(canisterId, method, argsJson)` — only allowed if `canisterId` is in `ICP_CANISTER_UPDATE_ALLOWLIST` env var (space-separated list). Default: empty list (update calls blocked).
- **Why:** Makes the server a universal ICP interface — Claude can interact with any deployed canister, not just hardcoded ones. Allowlist prevents Claude from calling arbitrary canisters on update (irreversible, cycles-consuming, potentially dangerous).
- **Context:** Requires Candid runtime arg encoding (didc WASM or `@dfinity/candid` programmatic API). Fetch the canister's .did interface first, then encode args. Add `ICP_CANISTER_UPDATE_ALLOWLIST` to `config.ts` Zod schema. Clear error when not allowed: "Canister not in allowlist. Add to ICP_CANISTER_UPDATE_ALLOWLIST to enable update calls." The main challenge is surfacing encoding errors helpfully to Claude.
- **Depends on:** Nothing

**Add t-ECDSA DurableTransferLog (native Bitcoin/ETH signing)**
- **Priority:** P2
- **What:** A durable request log for ICP threshold-ECDSA signing calls — persists `requestId` to disk BEFORE calling the ICP signing endpoint so recovery is possible after a 30s timeout. Recovery uses `agent.fetchCertifiedResponse(requestId)`.
- **Why:** ICP t-ECDSA signing takes up to 30 seconds. If Claude's MCP session times out mid-call, there's no way to know whether the transaction was submitted. The ICRC-1 transfer log built in v0.2.0 uses a different recovery path (memo-based get_transactions) — t-ECDSA needs its own mechanism.
- **Context:** The t-ECDSA log schema: `{requestId: string, method: string, args: object, timestamp: number, status: "pending"|"submitted"|"failed"}`. Extend `src/transfer-log.ts` or create `src/signing-log.ts`. Only relevant once a native ICP signing tool is built via the chain-fusion-agent canister.
- **Depends on:** chain-fusion-agent canister (P3)

**Build chain-fusion-agent canister (/canister monorepo)**
- **Priority:** P3
- **What:** A Motoko (or Rust) canister in `/canister` that exposes ICP threshold-ECDSA signing to the MCP server. The canister is the signing engine; the MCP server is the orchestration layer.
  - `sign_bitcoin_tx(tx_hash: Blob)` — calls `sign_with_ecdsa` with the canister's derived key
  - `get_ecdsa_public_key()` — returns the canister's secp256k1 public key (used to derive Bitcoin address)
  - Authorization: only the configured operator principal can call signing methods
- **Why:** A Node.js process cannot call ICP t-ECDSA directly — it must call a canister that then calls the ICP signing system. This canister is the missing piece that enables Claude to autonomously sign Bitcoin and Ethereum transactions without a human key holder.
- **Context:** Start with Motoko (simpler for a first canister). Use the ICP `ckbtc` and `vetkd` skills from https://skills.internetcomputer.org for signing patterns. Key ID: `{ curve: #secp256k1; name = "test_key_1" }` on testnet, `"key_1"` on mainnet. The canister lives in `/canister` alongside `/src` — monorepo approach keeps MCP server and signing backend in sync. Needs dfx.json, Motoko source, and a deploy script. The MCP server calls this canister via `icp_canister_update` (allowlisted).
- **Depends on:** Generic ICP canister tool (P2)

## Completed

**Fix 3 critical production gaps (EVM errors + ICRC-1 transfer log)**
- **What:** (1) ICRC-1 transfer log — persist transfer args to JSONL before ICP call. (2) EVM error detection — handle all 4 ic-evm-rpc error shapes. (3) Cycles budget config field added (enforcement deferred — see P0 above).
- **Completed:** v0.2.0 (2026-03-25) — gaps 1 and 2 resolved; gap 3 config parsing added.

**Add cktoken_transfer tool (ICRC-1)**
- **What:** `cktoken_transfer` tool for ckBTC, ckETH, ckUSDC using ICRC-1 `transfer()`. Amount as `z.string()` → `BigInt(amount)`. Confirm guard, in-session idempotency Set, durable JSONL transfer log.
- **Completed:** v0.2.0 (2026-03-25)

**Add unit tests for cktokens.ts**
- **What:** Mock `IcrcLedgerCanister.create()` and test `cktoken_get_balance` + `cktoken_transfer` — balance formatting, ckETH 18-decimal bigint precision, transfer preview/confirm/idempotency/error paths.
- **Completed:** v0.2.0 (2026-03-25)
