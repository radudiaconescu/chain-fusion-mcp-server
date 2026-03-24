# Chain Fusion MCP Server

> **EXPERIMENTAL — NOT FOR PRODUCTION USE**
>
> This server has not been audited, has not been tested against live networks with real funds,
> and has known gaps documented in [TODOS.md](./TODOS.md). It is published to share the
> approach and invite feedback. **Do not use it with wallets or keys that hold value you
> cannot afford to lose.**

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes ICP
[Chain Fusion](https://internetcomputer.org/chainfusion) capabilities as tools for Claude.
Claude can read balances and UTXOs across Bitcoin, Ethereum, and ICP's cross-chain token
layer (ckBTC, ckETH, ckUSDC), and broadcast pre-signed transactions — all without any
centralised custodian.

---

## What is Chain Fusion?

The Internet Computer Protocol (ICP) has native integrations with other blockchains:

- **Bitcoin integration** — ICP nodes hold a threshold-ECDSA key that can sign Bitcoin
  transactions. Canisters can read the Bitcoin UTXO set and issue signed BTC transactions
  without bridges or wrapped tokens.
- **EVM RPC canister** — a canister on ICP that forwards JSON-RPC calls to Ethereum nodes,
  making EVM chains accessible from within ICP smart contracts.
- **Chain Fusion tokens (ckTokens)** — ICP-native ICRC-1 tokens that are backed 1:1 by
  assets locked on their native chains. ckBTC, ckETH, and ckUSDC can be sent on ICP in
  milliseconds with sub-cent fees, then redeemed for the underlying asset.

This MCP server gives Claude direct access to that infrastructure.

---

## Tools

### Bitcoin

| Tool | Description |
|------|-------------|
| `bitcoin_get_balance` | Confirmed + unconfirmed balance for any address (P2PKH, P2SH, P2WPKH, P2TR, P2WSH) |
| `bitcoin_get_utxos` | Full UTXO set with confirmation status and block heights |
| `bitcoin_get_fee_rates` | Fastest / half-hour / hour / economy / minimum sat/vByte estimates |
| `bitcoin_broadcast_transaction` | Broadcast a pre-signed transaction (confirmation guard required) |

### Ethereum

| Tool | Description |
|------|-------------|
| `eth_get_balance` | ETH balance in wei and ETH at any block tag |
| `eth_call` | Read-only smart contract call with ABI-encoded calldata |
| `eth_get_transaction` | Transaction details + receipt by hash |
| `eth_send_raw_transaction` | Broadcast a pre-signed transaction (confirmation guard required) |

### Chain Fusion ckTokens

| Tool | Description |
|------|-------------|
| `cktoken_get_balance` | Balance of ckBTC, ckETH, or ckUSDC for any ICP principal — a real on-chain ICP query call |

---

## Scope and design intent

The goal is for Claude to be a first-class participant in multi-chain workflows — not just
reading chain state, but eventually constructing and submitting transactions — without
custody of private keys.

**What this server handles today:**
- Reading chain state (balances, UTXOs, transactions, fee rates) across Bitcoin and Ethereum
- Reading ckToken balances on ICP via ICRC-1 query calls
- Broadcasting pre-signed transactions that Claude has constructed or been given

**What this server deliberately does not handle (yet):**
- Signing transactions — Claude cannot currently sign with a Bitcoin or Ethereum key
- ckBTC/ckETH transfer on ICP (ICRC-2 approve + transfer flow — tracked in TODOS.md)
- Arbitrary ICP canister calls (tracked in TODOS.md)

---

## Engineering tradeoffs

### Bitcoin reads via Mempool.space, not ICP management canister

ICP's native Bitcoin integration is powerful, but its query methods (`bitcoin_get_balance`,
`bitcoin_get_utxos`) are **update calls** — they go through consensus and cost cycles. An
HTTP agent running outside a canister cannot attach cycles to calls. For read-only use from
an MCP server, Mempool.space's public REST API is a pragmatic substitute: no key required,
low latency, covers mainnet and testnet. The tradeoff is trust in Mempool.space's data over
ICP's threshold-signed UTXO set.

### ckToken balances via ICRC-1 query (free, no cycles)

ICRC-1 `icrc1_balance_of` is a **query call** — it runs on a single replica, is not
certified by default, and costs no cycles. For balance reads this is fine in practice.
Anyone needing certified balance reads should fetch a certified response and verify the
certificate against the ICP root key.

### Ethereum reads via external JSON-RPC

The EVM RPC canister on ICP can forward Ethereum RPC calls, but using it from an external
agent would still require an intermediate ICP HTTP call. For simplicity, the server speaks
directly to any standard JSON-RPC endpoint (Infura, Alchemy, a local node). `ETH_RPC_URL`
is operator-supplied and optional — ETH tools throw a clear error if it is not set.

### Confirmation guard on all write tools

Write tools (`bitcoin_broadcast_transaction`, `eth_send_raw_transaction`) require
`confirm: true` to be passed explicitly. Calling them without it returns a preview of what
would be sent. This prevents Claude from broadcasting accidentally during planning or
tool-calling loops.

### In-session idempotency, not durable

A module-level `Set<string>` tracks raw transactions broadcast in the current session.
Submitting the same raw hex twice returns a warning instead of broadcasting again. This
protects against duplicate calls within a single Claude session, but the set is cleared on
server restart. Durability across restarts (e.g. for t-ECDSA timeout recovery) is a known
gap — see TODOS.md.

### ICP identity: Ed25519 PEM only

dfx generates Ed25519 PKCS8 PEM files by default. The server parses these using Node.js
`crypto.createPrivateKey()` + JWK export to extract the 32-byte secret for
`Ed25519KeyIdentity.fromSecretKey()`. Legacy secp256k1 keys (older dfx versions) are not
supported — the server throws a descriptive error explaining the mismatch and how to export
an Ed25519 key.

### LRU read cache

All read-only tools cache results for 10 seconds (configurable via `CACHE_TTL_MS`) in an
in-memory LRU cache (500-entry cap). Repeated identical calls within the TTL return the
cached result without a network round-trip. This matters most for tools like
`bitcoin_get_utxos` that may be called several times during a transaction-building
conversation.

### Dual transport

The server supports `stdio` (for Claude Desktop / `claude` CLI) and `SSE` (for remote
clients over HTTP) simultaneously or independently via `MCP_TRANSPORT=stdio|sse|both`. SSE
sessions are keyed by a random session ID so multiple clients can connect concurrently.

---

## Known gaps (before production use)

See [TODOS.md](./TODOS.md) for the full list. The three blocking gaps are:

1. **t-ECDSA timeout recovery** — ICP threshold signing takes up to 30 seconds. If the
   agent times out before receiving the response, there is no way to know whether the
   transaction was submitted. Request ID persistence to disk before signing would allow
   recovery.

2. **EVM error detection** — the `ic-evm-rpc` canister embeds JSON error objects inside
   string fields rather than in the standard JSON-RPC `error` key. The current error
   normalisation handles the common case but may miss edge cases.

3. **Cycles budget** — there is no per-request or per-session cycles spending cap. Runaway
   Claude sessions could burn an unchecked amount of cycles on ICP calls.

---

## Setup

### Prerequisites

- Node.js 20+
- A dfx identity PEM file: `dfx identity export <name> > identity.pem`
- (Optional) An Ethereum JSON-RPC URL if you want ETH tools

### Install and build

```bash
npm install
npm run build
```

### Configure

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

```
ICP_IDENTITY_PEM=./identity.pem   # required
ETH_RPC_URL=https://...           # required for eth_* tools
ICP_NETWORK=mainnet
MCP_TRANSPORT=stdio
```

### Claude Desktop (stdio)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chain-fusion": {
      "command": "node",
      "args": ["/path/to/chain-fusion-mcp-server/dist/index.js"],
      "env": {
        "ICP_IDENTITY_PEM": "/path/to/identity.pem",
        "ETH_RPC_URL": "https://mainnet.infura.io/v3/YOUR_KEY"
      }
    }
  }
}
```

### Claude CLI (stdio)

```bash
ICP_IDENTITY_PEM=./identity.pem ETH_RPC_URL=https://... node dist/index.js
```

### Remote (SSE)

```bash
MCP_TRANSPORT=sse MCP_SSE_PORT=3000 \
ICP_IDENTITY_PEM=./identity.pem \
ETH_RPC_URL=https://... \
node dist/index.js
```

The SSE endpoint will be available at `http://localhost:3000/sse`.

---

## Running tests

```bash
npm test
```

35 unit tests covering config validation, error normalisation, Bitcoin tools, and Ethereum
tools. The ckTokens tool is not yet unit-tested (tracked in TODOS.md).

---

## License

MIT
