# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
