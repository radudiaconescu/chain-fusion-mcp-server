# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.4.0] - 2026-03-26

### Added
- **ckBTC minter tools** (`src/tools/ckbtc-minter.ts`): 5 new tools completing the full BTC ↔ ckBTC round-trip — `ckbtc_get_deposit_address`, `ckbtc_update_balance`, `ckbtc_get_withdrawal_account`, `ckbtc_withdraw`, `ckbtc_withdrawal_status`. Withdrawal preview (fee estimate + minimum check from `getMinterInfo`) and confirm guard. Duck-typed minter error guards for `MinterNoNewUtxosError`, `MinterMalformedAddressError`, `MinterAmountTooLowError`, and others.
- **Durable withdrawal log** (`src/withdrawal-log.ts`): Persists withdrawal intents to `~/.chain-fusion/withdrawals.jsonl` before each ICP update call. JSONL append-only format with corrupt-line-safe parsing, matching the existing transfer log design.
- **ICP canister** (`canister/src/lib.rs`, `canister/Cargo.toml`, `dfx.json`): Rust canister implementing 3 read-only MCP tools (`bitcoin_get_balance`, `bitcoin_get_fee_rates`, `cktoken_get_balance`) via `ic-cdk 0.18` directly (icarus-cdk omitted — its `linkme::distributed_slice` is incompatible with `wasm32-unknown-unknown`). Candid variant rename fix for `BitcoinNetwork`. 6 unit tests. Builds clean to 850K wasm.
- **Test suite**: Expanded from 78 to 100 tests. 22 new tests covering all ckBTC minter tool paths.

### Changed
- **`src/server.ts`**: `registerCkBtcMinterTools` wired into `createServer`.
- **CLAUDE.md**: Canister architecture section added (icarus-cdk incompatibility, ic-cdk 0.18 API, Candid variant encoding). File structure and roadmap updated.
- **TODOS.md**: ckBTC minter tools and ICP canister marked completed. PocketIC integration tests (P2) and cycle-cost caching (P2) added as deferred items.

## [0.3.1] - 2026-03-26

### Added
- **Cycles budget enforcement** (`src/cycles-budget.ts`): `CYCLES_BUDGET_E8S` now enforces a per-session spending cap on ICP update calls. Each `cktoken_transfer` call deducts `BASE_CYCLES_PER_UPDATE` (590,000 cycles) from the budget before writing to the transfer log or making the ICP call — keeping the log clean if the budget is exceeded. Configure with `CYCLES_BUDGET_E8S=<N>` in your environment; omit or set to 0 for no limit.
- **Ed25519 and secp256k1 PEM unit tests** (`test/identity.test.ts`): 4 tests covering both key types, invalid PEM, and unsupported key types (RSA). Identity loading is the critical startup path — now covered.

### Fixed
- **VERSION file** was stale at `0.2.0` (package.json and CHANGELOG both at `0.3.0`). Synced.

### Changed
- **CLAUDE.md** (new file): Project context for AI coding sessions — architecture decisions, key patterns, roadmap, and known gaps.
- **TODOS.md**: P0 (cycles budget) and P1 PEM tests moved to Completed. New P1 items: ckBTC minter tools. New P2 item: `chain_fusion_status` dashboard. New P3: chain-fusion-agent canister.
- **Test suite**: Expanded from 64 to 78 tests (8 files).

## [0.3.0] - 2026-03-25

### Changed
- **SDK migration**: Replaced `@dfinity/agent`, `@dfinity/candid`, `@dfinity/identity`, `@dfinity/ledger-icrc`, `@dfinity/principal` with `@icp-sdk/core@^5.2.0` and `@icp-sdk/canisters@^3.5.2`. `@dfinity/utils@^4.1.0` retained as required peer dep.
- **Bitcoin balance/UTXO reads**: Switched from Mempool.space to the dedicated ICP Bitcoin canister (`ghsi2-tqaaa-aaaan-aaaca-cai` mainnet, `g4xu7-jiaaa-aaaan-aaaaq-cai` testnet) via `BitcoinCanister.getBalanceQuery()` / `getUtxosQuery()`. Genuine ICP query calls — no cycles, ~200ms. Fee rates and broadcast remain on Mempool.space.
- **ICP identity**: Added secp256k1 key support. `Secp256k1KeyIdentity.fromPem()` from `@icp-sdk/core/identity/secp256k1` handles icp-cli and older dfx keys. Key type auto-detected at startup (kty=OKP/Ed25519 vs kty=EC/secp256k1). Both dfx and icp-cli PEMs now work without modification.
- **ARCHITECTURE.md**: Sections 2, 3, 5, 7, and 17 updated for new SDK, Bitcoin canister architecture, and secp256k1 support.
- **README.md**: Bitcoin tools table, engineering tradeoffs, identity section, prerequisites, and test count updated.
- **Test suite**: Expanded from 59 to 64 tests. Bitcoin test suite rewritten for Bitcoin canister mocks (`BitcoinCanister.create`, `getBalanceQuery`, `getUtxosQuery`).

### Breaking Changes
- `bitcoin_get_balance` no longer returns `unconfirmed_satoshis`. Only `confirmed_satoshis` is returned (default: 6+ confirmations, configurable 0–6 via `min_confirmations`). The Bitcoin canister query path does not expose mempool/unconfirmed data.

## [0.2.0] - 2026-03-25

### Added
- **`cktoken_transfer` tool**: Transfer ckBTC, ckETH, or ckUSDC to any ICP principal via ICRC-1 `transfer()`. Amount accepted as a string to preserve full bigint precision — ckETH at 18 decimals exceeds JavaScript's safe integer range. Includes confirm guard (preview without `confirm: true`), in-session idempotency fingerprinting, and durable transfer log.
- **Durable ICRC-1 transfer log** (`src/transfer-log.ts`): Persists transfer intent to `~/.chain-fusion/pending.jsonl` *before* the ICP update call so a session timeout leaves a recoverable record. JSONL format with line-by-line corrupt-safe parsing. Disk write failures warn to stderr and do not abort the transfer.
- **`CYCLES_BUDGET_E8S` config field**: Parses a cycles spending cap from the environment. Enforcement not yet wired up — parsing is in place for the upcoming enforcement PR (see TODOS.md).

### Fixed
- **EVM error detection** in `extractEvmResult()`: Now handles all four ic-evm-rpc error shapes — standard `{error:{...}}` wrapper (Shape 1), Candid-wrapped double-encoded JSON string (Shape 2), plain text (Shape 3), and bare `{code, message}` object without wrapper (Shape 4). Previously only Shapes 1 and 3 were handled; Shapes 2 and 4 surfaced as "unknown error".

### Changed
- **TODOS.md**: Updated P0 gap item to reflect that the ICRC-1 transfer log addresses gap (1). Added two new tracked items: ICRC-1 transfer recovery (startup pending log scan, P1) and t-ECDSA DurableTransferLog for future native signing (P2).
- **Test suite**: Expanded from 35 to 59 tests (+7 transfer-log, +11 cktoken tools, +3 EVM error shapes, +3 config cycles budget).

## [0.1.0] - 2026-03-24

### Added
- **Bitcoin tools** via Mempool.space API: `bitcoin_get_balance`, `bitcoin_get_utxos`, `bitcoin_get_fee_rates`, `bitcoin_broadcast_transaction`
- **Ethereum tools** via configurable JSON-RPC endpoint: `eth_get_balance`, `eth_call`, `eth_get_transaction`, `eth_send_raw_transaction`
- **Chain Fusion ckToken tool** via ICP ICRC-1 query: `cktoken_get_balance` for ckBTC, ckETH, and ckUSDC — genuine on-chain ICP query, no cycles required
- **ICP identity support**: PKCS8 Ed25519 PEM (dfx default) parsed via Node.js crypto, with clear error for legacy secp256k1 keys
- **Dual transport**: stdio (Claude Desktop / claude CLI) and SSE (Express, for remote clients)
- **Confirmation guard** on all write tools (`confirm: true` required) with preview mode when omitted
- **Idempotency layer**: in-session duplicate submission protection for `bitcoin_broadcast_transaction` and `eth_send_raw_transaction`
- **LRU read cache** with 10s TTL for all read-only tools (500-entry cap)
- **Centralized error normalization** (`errors.ts`): ICP `ReplicaRejectError` codes 3/4/5, EVM JSON-RPC errors, and network errors all map to structured `McpError`
- **Zod config validation** with fail-fast startup and descriptive messages for missing/invalid env vars
- **Vitest test suite**: 35 tests covering config, error normalization, Bitcoin tools, and Ethereum tools
