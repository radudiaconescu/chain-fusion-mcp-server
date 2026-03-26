# TODOS

## Chain Fusion


**Add ckBTC withdrawal startup recovery (scan withdrawals.jsonl at startup)**
- **Priority:** P1
- **What:** On server start, read `~/.chain-fusion/withdrawals.jsonl` for entries with `status: "pending"`. Query `retrieveBtcStatusV2ByAccount()` for each pending withdrawal and auto-settle entries that have a confirmed status. Emit a startup warning for entries still pending after a configurable age threshold.
- **Why:** A Claude session that times out during `ckbtc_withdraw` leaves a dangling `pending` log entry. Without recovery, users have no visibility into whether the withdrawal initiated. Mirrors the ICRC-1 transfer recovery (below) but uses a different query path (minter status vs ledger transactions).
- **Context:** `withdrawals.jsonl` schema: `{ id, status, btc_address, amount_satoshi, block_index?, timestamp, error? }`. Recovery: `CkBtcMinterCanister.retrieveBtcStatusV2ByAccount({ certified: false })` — if a block_index in the log matches a `Confirmed` entry, mark settled. Start point: `src/withdrawal-log.ts` + server startup in `src/index.ts`.
- **Depends on:** ckBTC minter tools (P1 above)

**Add ICRC-1 transfer recovery (startup pending log scan)**
- **Priority:** P1
- **What:** On server start, read the ICRC-1 transfer log and query `get_transactions` for any entry with `status: "pending"`. Auto-settle entries that landed; emit a startup warning for entries still pending after a configurable age threshold.
- **Why:** A Claude session that times out mid-transfer leaves a dangling `pending` log entry. Without recovery, the log grows with unresolved entries and users have no visibility into whether the transfer went through.
- **Context:** Store a unique `memo` (u64 timestamp-based) in each transfer call. Use `IcrcLedgerCanister.getTransactions()` filtering by memo to check settlement. ckBTC/ckETH/ckUSDC on mainnet support ICRC-3 transaction queries. Start point: `src/transfer-log.ts` `loadPending()` + `IcrcLedgerCanister.getTransactions()`.
- **Depends on:** Nothing



**Add DurableLog<T> generic abstraction**
- **Priority:** P2
- **What:** Extract the common JSONL log pattern from `transfer-log.ts` and `withdrawal-log.ts` into a single generic `DurableLog<T>` class in `src/durable-log.ts`. API: `appendPending(entry: T): Promise<string>`, `markSettled(id, status, extra?): Promise<void>`, `loadPending(): T[]`.
- **Why:** Both `transfer-log.ts` and `withdrawal-log.ts` share the same JSONL append/settle/parse pattern. Two nearly-identical files is a DRY violation. When a 3rd durable log is needed (e.g., t-ECDSA signing log), the pattern should be shared.
- **Context:** After both ckBTC minter tools (P1) and ICRC-1 recovery (P1) are complete, extract the common logic. The generic parameter handles the schema difference between transfer and withdrawal entries. File: `src/durable-log.ts`. Both `transfer-log.ts` and `withdrawal-log.ts` become thin wrappers around `DurableLog<TransferEntry>` and `DurableLog<WithdrawalEntry>`.
- **Depends on:** ckBTC minter tools (P1)

**Add bitcoin_uri field to ckbtc_get_deposit_address**
- **Priority:** P2
- **What:** Include a `bitcoin_uri` field in `ckbtc_get_deposit_address` output: `bitcoin:<address>?label=ckBTC+Deposit` (BIP-21 format). Optional `amount` param if a satoshi amount is passed as input.
- **Why:** Claude can display the URI directly in a link or suggest QR code generation. Makes the deposit flow more copy-paste friendly and enables future QR integrations.
- **Context:** Pure string formatting — no new SDK calls. Add `amount_satoshi?: string` optional input param. Format: `bitcoin:${address}?label=ckBTC+Deposit${amount ? '&amount=' + satsToDecimalBTC(amount) : ''}`. Include in the tool output alongside `address`.
- **Depends on:** ckBTC minter tools (P1)

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

**Add PocketIC integration tests for canister async tools**
- **Priority:** P2
- **What:** Set up `pocket-ic` Rust test harness in `canister/tests/`. Write integration tests for `bitcoin_get_balance` (mock Bitcoin canister reply), `bitcoin_get_fee_rates` (mock HTTPS outcall via pocket-ic), and `cktoken_get_balance` (mock ICRC-1 ledger reply).
- **Why:** The 3 core tool functions currently have zero test coverage. Only 5 synchronous helper tests exist. Without integration tests, Candid type mismatches (like the variant-name bug found in review) can only be caught at runtime on a live IC replica.
- **Context:** `pocket-ic` crate is on crates.io. Add `[dev-dependencies] pocket-ic = "5"` to `canister/Cargo.toml`. Create `canister/tests/integration.rs`. Each test: install canister in pocket-ic instance → install a mock Bitcoin/ICRC-1 canister as counterpart → call `mcp_call_tool` with the tool JSON → assert JSON response structure.
- **Depends on:** Nothing

**Add cycle-cost caching for bitcoin_get_fee_rates**
- **Priority:** P2
- **What:** Add a `thread_local! { static FEE_RATE_CACHE: RefCell<Option<(String, u64)>> }` cache in `canister/src/lib.rs`. Cache the Mempool.space response with the IC time (`ic_cdk::api::time()`) as the timestamp. Return cached value if < 30s old; make the HTTPS outcall only if stale.
- **Why:** HTTPS outcalls cost 2–10M cycles each. Claude calling `bitcoin_get_fee_rates` repeatedly in a session (e.g., comparing fee rates before every action) drains the canister's cycle balance proportionally.
- **Context:** `ic_cdk::api::time()` returns nanoseconds since epoch. 30s = 30_000_000_000 ns. The cache is thread-local so it resets on every replica restart (acceptable — fee rates change slowly). File: `canister/src/lib.rs`.
- **Depends on:** Nothing

**Expand canister with ETH balance + ckBTC deposit address tools**
- **Priority:** P2
- **What:** Add two tools to `canister/src/lib.rs`:
  1. `eth_get_balance` — call the ic-evm-rpc canister (`7hfb6-caaaa-aaaar-qadga-cai`) via inter-canister call to query an Ethereum address balance
  2. `ckbtc_get_deposit_address` — call the ckBTC minter (`mqygn-kiaaa-aaaar-qaadq-cai`) via inter-canister call to get the deposit address for a principal
- **Why:** These are natural read-only extensions to the existing 3 canister tools. Neither requires a private key or signing.
- **Context:** ic-evm-rpc canister Candid: `eth_getBalance(source, json_rpc_config, address, block_number)`. ckBTC minter `getBtcAddress` is an UPDATE call (costs cycles) — cache the result in stable memory. File: `canister/src/lib.rs`.
- **Depends on:** Nothing (canister/src/lib.rs already deployed)

**Add t-ECDSA signing to canister (chain-fusion-agent upgrade)**
- **Priority:** P3
- **What:** Upgrade `canister/src/lib.rs` to add t-ECDSA signing tools:
  - `get_ecdsa_public_key()` — returns the canister's secp256k1 public key
  - `sign_bitcoin_tx(tx_hash: String)` — calls `sign_with_ecdsa` with the canister's derived key
  - Authorization: only the configured operator principal (set at deploy time) can call signing methods
- **Why:** The Node.js process cannot call ICP t-ECDSA directly — it must call a canister. Adding t-ECDSA to the existing canister avoids a separate signing-only canister. Enables Claude to autonomously sign Bitcoin transactions via `icp_canister_update` (allowlisted with `ICP_CANISTER_UPDATE_ALLOWLIST`).
- **Context:** Key ID: `{ curve: Secp256k1; name: "test_key_1" }` on testnet, `"key_1"` on mainnet. Use `ic_cdk::management_canister::ecdsa_public_key()` and `ic_cdk::management_canister::sign_with_ecdsa()`. Store operator principal in stable memory via `ic_stable_structures`. The 30s signing timeout requires the durable signing log (see t-ECDSA DurableTransferLog TODO in Node.js server).
- **Depends on:** Generic ICP canister tool (P2)

## Completed

**Create ICP canister with read-only tools (icarus-cdk)**
- **What:** Rust canister in `/canister` using icarus-cdk. 3 tools: `bitcoin_get_balance` (ICP Bitcoin canister), `bitcoin_get_fee_rates` (Mempool.space HTTPS outcall), `cktoken_get_balance` (ICRC-1 ledger). `dfx.json` at project root. `canister/README.md` with deploy instructions.
- **Completed:** v0.4.1 (2026-03-26)

**Add ckBTC minter tools (deposit + withdraw flow)**
- **What:** 5 tools completing the full BTC ↔ ckBTC round-trip: `ckbtc_get_deposit_address`, `ckbtc_update_balance`, `ckbtc_get_withdrawal_account`, `ckbtc_withdraw`, `ckbtc_withdrawal_status`. Durable withdrawal log at `~/.chain-fusion/withdrawals.jsonl`.
- **Completed:** v0.4.0 (2026-03-26)

**Enforce cycles budget (CYCLES_BUDGET_E8S)**
- **What:** Per-session cycles spending cap on ICP update calls. `CyclesBudget` class with `charge()` / `remaining`. Budget checked before each cktoken_transfer (before log write and ICP call). Throws `McpError` on overage. 7 unit tests.
- **Completed:** v0.3.0 (2026-03-25)

**Add Ed25519/secp256k1 PEM parsing unit tests**
- **What:** `test/identity.test.ts` — 4 tests covering Ed25519 routing, secp256k1 routing, invalid PEM, and unsupported key type (RSA). Uses real fixture keys from Node.js `generateKeyPairSync`. Mocks ICP SDK constructors.
- **Completed:** v0.3.0 (2026-03-25)

**Fix 3 critical production gaps (EVM errors + ICRC-1 transfer log)**
- **What:** (1) ICRC-1 transfer log — persist transfer args to JSONL before ICP call. (2) EVM error detection — handle all 4 ic-evm-rpc error shapes. (3) Cycles budget config field added (enforcement deferred — see P0 above).
- **Completed:** v0.2.0 (2026-03-25) — gaps 1 and 2 resolved; gap 3 config parsing added.

**Add cktoken_transfer tool (ICRC-1)**
- **What:** `cktoken_transfer` tool for ckBTC, ckETH, ckUSDC using ICRC-1 `transfer()`. Amount as `z.string()` → `BigInt(amount)`. Confirm guard, in-session idempotency Set, durable JSONL transfer log.
- **Completed:** v0.2.0 (2026-03-25)

**Add unit tests for cktokens.ts**
- **What:** Mock `IcrcLedgerCanister.create()` and test `cktoken_get_balance` + `cktoken_transfer` — balance formatting, ckETH 18-decimal bigint precision, transfer preview/confirm/idempotency/error paths.
- **Completed:** v0.2.0 (2026-03-25)
