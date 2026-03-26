# Chain Fusion MCP Server — Claude Instructions

## What this project is

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes
ICP [Chain Fusion](https://internetcomputer.org/chainfusion) capabilities as tools for
Claude. Claude can read balances and UTXOs across Bitcoin, Ethereum, and ICP's ckToken
layer (ckBTC, ckETH, ckUSDC), and broadcast pre-signed transactions — without a custodian.

**Status:** Experimental. Not for production use. See TODOS.md for known gaps.

---

## Current state

**Version:** 0.4.0
**Test suite:** 100 tests, 9 files, all passing
**Open PRs:** Check GitHub — typically one feature branch ahead of `main`

---

## Build and test

```bash
npm install          # install deps
npm run build        # tsc — must be clean before committing
npm test             # vitest run — 100 tests
```

The server has no runtime URL to test against. QA = build + tests + smoke test.

---

## Key architectural decisions

### SDK
- Uses `@icp-sdk/core@^5.2.0` and `@icp-sdk/canisters@^3.5.2` (NOT `@dfinity/*`)
- `@dfinity/*` packages are deprecated — do not add them back
- `@dfinity/utils@^4.1.0` is kept as a required peer dep of `@icp-sdk/canisters`
- **`@icp-sdk/auth` is browser-only (Internet Identity web flows) — do NOT add it**
  This server is a headless Node.js process; AuthClient requires a browser window

### ICP identity (`src/identity.ts`)
- Supports **both** Ed25519 (dfx v0.14+) and secp256k1 (icp-cli / older dfx)
- Key type auto-detected via `crypto.createPrivateKey(pem) → JWK → kty/crv`
- Ed25519: `Ed25519KeyIdentity.fromSecretKey(Uint8Array)` from `@icp-sdk/core/identity`
- secp256k1: `Secp256k1KeyIdentity.fromPem(pem)` from `@icp-sdk/core/identity/secp256k1`
- One `HttpAgent` created at startup, shared for all tool calls

### Bitcoin tools (`src/tools/bitcoin.ts`)
- `bitcoin_get_balance` and `bitcoin_get_utxos` use the **ICP Bitcoin canister**
  - Mainnet: `ghsi2-tqaaa-aaaan-aaaca-cai`
  - Testnet: `g4xu7-jiaaa-aaaan-aaaaq-cai`
  - Uses `BitcoinCanister.getBalanceQuery()` / `getUtxosQuery()` (query calls, no cycles)
  - Returns **confirmed balance only** — no `unconfirmed_satoshis` field
- `bitcoin_get_fee_rates` and `bitcoin_broadcast_transaction` use **Mempool.space**
  - Bitcoin canister fee/broadcast methods are update-only (canister-to-canister)
- The old management canister Bitcoin API is **deprecated and removed** — don't use it

### ckBTC minter tools (`src/tools/ckbtc-minter.ts`)
- Uses `CkBtcMinterCanister` from `@icp-sdk/canisters/ckbtc`
- **Minter IDs:** Mainnet `mqygn-kiaaa-aaaar-qaadq-cai`, Testnet `ml52i-qqaaa-aaaar-qaaba-cai`
- `getBtcAddress()` is an **UPDATE call** (2-5s, costs cycles) — NOT a query. Cache result for session.
- `updateBalance()` → `UtxoStatus[]` (Minted/Checked/ValueTooSmall/Tainted variants)
- `MinterNoNewUtxosError` is NOT an error — BTC not yet confirmed. Return structured pending JSON.
- **Minter error classes** are NOT importable under NodeNext resolution (no .js counterpart for `errors/` dir).
  Use duck-typing guards: `isMinterNoNewUtxosError(err)` checks `.pendingUtxos`+`.requiredConfirmations`;
  `isMinterErrorByName(err, 'MinterXxxError')` checks `err.constructor.name`.
- `ckbtc_withdraw` is a 2-step flow: first call `ckbtc_get_withdrawal_account`, transfer ckBTC there, then call `ckbtc_withdraw`
- Durable withdrawal log: `~/.chain-fusion/withdrawals.jsonl` via `src/withdrawal-log.ts`
- All 3 UPDATE calls (`getBtcAddress`, `updateBalance`, `retrieveBtc`) must call `budget.charge()`

### ICP canister (`canister/src/lib.rs`)
- Built with **icarus-cdk** (`icarus = "1.0.0"`) — generates `mcp_list_tools`, `mcp_call_tool`, `mcp_server_info` Candid endpoints
- **`#[tool("description")]`** macro on each async fn registers it; `icarus_macros::mcp! {}` generates the ICP query/update endpoints
- **Inter-canister calls**: `ic_cdk::call(principal, method, (args,))` for ICP Bitcoin canister + ICRC-1 ledger (deprecated in 0.18 but functional; `#[allow(deprecated)]` per-site suppresses the warning)
- **HTTPS outcalls**: `ic_cdk::management_canister::http_request(&args)` — auto-attaches cycles, returns `CallResult<HttpRequestResult>`. Error type is `ic_cdk::call::Error` (not a tuple). `status` is `u128` (via `candid::Nat`).
- **Only read tools** — no identity, no signing. Write tools require a PEM key and live exclusively in the Node.js server.
- Build: `rustup target add wasm32-unknown-unknown && dfx deploy` (Rust must be installed)

### ckToken tools (`src/tools/cktokens.ts`)
- Uses `IcrcLedgerCanister` from `@icp-sdk/canisters/ledger/icrc`
- Uses `Principal` from `@icp-sdk/core/principal`
- `cktoken_transfer` persists intent to `~/.chain-fusion/pending.jsonl` before ICP call
- Transfer amounts are `z.string()` → `BigInt(amount)` to avoid JS precision loss

### Error handling (`src/errors.ts`)
- `toMcpError(err, context)` normalises all errors to `McpError`
- Check `instanceof McpError` BEFORE `isEvmRpcError()` — McpError satisfies the EVM shape
- `extractEvmResult()` handles 4 ic-evm-rpc error shapes (Shape 1–4)

### Write tool safety
- All write tools use `confirm: z.literal(true).optional()` — omit = preview, pass = execute
- Module-level `Set<string>` deduplicates broadcasts within a session

### Caching
- All read tools use `LRUCache<string, string>` with 10s TTL, 500-entry cap
- Cache keys via `makeCacheKey(toolName, args)` from `src/cache.ts`

---

## File structure

```
src/
  index.ts          — entry point, starts transport(s)
  server.ts         — creates McpServer, registers all tools
  config.ts         — Zod env var validation
  identity.ts       — PEM → HttpAgent (Ed25519 + secp256k1)
  cache.ts          — LRU cache helpers
  errors.ts         — toMcpError(), extractEvmResult()
  transfer-log.ts   — durable JSONL log for ckToken transfers
  withdrawal-log.ts — durable JSONL log for ckBTC withdrawals
  tools/
    bitcoin.ts      — 4 Bitcoin tools
    ethereum.ts     — 4 Ethereum tools
    cktokens.ts     — 2 ckToken tools
    ckbtc-minter.ts — 5 ckBTC minter tools

test/
  bitcoin.test.ts       — mocks BitcoinCanister (not fetch) for balance/UTXO tests
  cktokens.test.ts      — mocks IcrcLedgerCanister + transfer-log
  ckbtc-minter.test.ts  — mocks CkBtcMinterCanister + withdrawal-log
  ethereum.test.ts
  errors.test.ts
  config.test.ts
  transfer-log.test.ts

canister/             — ICP canister (Rust, icarus-cdk) — decentralized alternative
  Cargo.toml          — icarus = "1.0.0", ic-cdk = "0.18", candid = "0.10"
  src/lib.rs          — 3 read-only tools (bitcoin_get_balance, bitcoin_get_fee_rates, cktoken_get_balance)
  README.md           — deploy instructions
dfx.json              — DFX project config (references canister/ package)
```

---

## Known gaps (before production use)

See TODOS.md for full detail. No P0 gaps remain. Next priorities:
1. **ICRC-1 transfer recovery** (P1) — pending log not scanned at startup
2. **ckBTC withdrawal startup recovery** (P1) — withdrawals.jsonl not scanned at startup

## Roadmap (from TODOS.md)

```
P1  ICRC-1 transfer recovery (pending log scan at startup)
P1  ckBTC withdrawal startup recovery (scan withdrawals.jsonl at startup)
P1  ckBTC minter tools  ✓ done (5 tools: get_deposit_address, update_balance, get_withdrawal_account, withdraw, withdrawal_status)
P1  Ed25519/secp256k1 PEM unit tests  ✓ done
P2  Expand canister with ETH balance + ckBTC deposit address
P2  chain_fusion_status dashboard tool
P2  Generic ICP canister tool (query always; update requires ICP_CANISTER_UPDATE_ALLOWLIST)
P2  t-ECDSA DurableTransferLog
P3  Add t-ECDSA signing to canister (unlocks native BTC/ETH signing)
P3  ICP canister (icarus-cdk, read-only tools)  ✓ done (3 tools: bitcoin_get_balance, bitcoin_get_fee_rates, cktoken_get_balance)
```

---

## What's NOT in scope (yet)

- Direct transaction signing (requires chain-fusion-agent canister — P3)
- ckBTC minter deposit + withdrawal (planned P1 — not yet built)
- ICRC-2 approve + transfer flow
- Arbitrary ICP canister calls (planned P2 with allowlist)
- Certified query verification
- Hardware key (YubiKey / HSM) support

---

## Environment variables

```
ICP_IDENTITY_PEM=./identity.pem   # required — Ed25519 or secp256k1 PEM
ETH_RPC_URL=https://...           # required for eth_* tools
ICP_NETWORK=mainnet               # mainnet | testnet | local
MCP_TRANSPORT=stdio               # stdio | sse | both
ICP_NODE_URL=https://ic0.app      # optional override
BTC_API_URL=https://mempool.space/api  # optional override (fee rates + broadcast only)
CACHE_TTL_MS=10000                # optional, default 10s
MCP_SSE_PORT=3000                 # required for SSE transport
CYCLES_BUDGET_E8S=                # optional, per-session cycles cap (enforced since v0.3.0)
```
