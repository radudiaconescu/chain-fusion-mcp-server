# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
