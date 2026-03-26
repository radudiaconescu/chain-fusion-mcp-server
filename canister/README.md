# Chain Fusion MCP Canister

An ICP canister implementing the Chain Fusion MCP server as a decentralized, persistent
alternative to the Node.js process. Built with [icarus-cdk](https://github.com/galenoshea/icarus-cdk).

## Tools

| Tool | Description | Backend |
|------|-------------|---------|
| `bitcoin_get_balance` | Confirmed BTC balance for an address | ICP Bitcoin canister |
| `bitcoin_get_fee_rates` | Current sat/vB fee rates (slow/medium/fast) | Mempool.space HTTPS outcall |
| `cktoken_get_balance` | ckBTC / ckETH / ckUSDC balance for a principal | ICRC-1 ledger canister |

## Architecture

```
Claude Desktop
     │ MCP (stdio / SSE)
     ▼
icarus-cli bridge (local process)
     │ Candid over HTTPS
     ▼
chain-fusion-mcp-canister (ICP)
     │ inter-canister query    │ HTTPS outcall
     ▼                         ▼
ICP Bitcoin canister        Mempool.space
ICRC-1 ledger canisters
```

**Key difference from the Node.js server:** The canister is stateless and signing-free.
It only implements the read-only tools. Write tools (cktoken_transfer, ckbtc_withdraw)
require a user's private key and live exclusively in the Node.js server.

## Prerequisites

```bash
# Rust + wasm32 target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# DFX (Internet Computer SDK)
sh -ci "$(curl -fsSL https://internetcomputer.org/install.sh)"

# icarus-cli bridge
cargo install icarus-cli
# or from source:
# cargo install --git https://github.com/galenoshea/icarus-cdk icarus-cli
```

## Deploy locally

```bash
# From project root:
dfx start --background
dfx deploy

# Test a tool call:
dfx canister call chain-fusion-mcp mcp_list_tools
dfx canister call chain-fusion-mcp mcp_call_tool '(
  "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"tools/call\",\"params\":{\"name\":\"bitcoin_get_fee_rates\",\"arguments\":{\"network\":\"mainnet\"}}}"
)'
```

## Deploy to mainnet

```bash
dfx deploy --network ic
# Note your canister ID from the output
```

## Connect to Claude Desktop

After deploying, use the icarus-cli bridge to connect Claude Desktop:

```bash
# With canister ID from dfx deploy output:
icarus connect --canister <CANISTER_ID> --network ic
```

Follow the icarus-cli docs to add the bridge to your `claude_desktop_config.json`.

## Canister IDs (mainnet)

| Service | Canister ID |
|---------|-------------|
| ICP Bitcoin (mainnet) | `ghsi2-tqaaa-aaaan-aaaca-cai` |
| ICP Bitcoin (testnet) | `g4xu7-jiaaa-aaaan-aaaaq-cai` |
| ckBTC ledger | `mxzaz-hqaaa-aaaar-qaada-cai` |
| ckETH ledger | `ss2fx-dyaaa-aaaar-qacoq-cai` |
| ckUSDC ledger | `xevnm-gaaaa-aaaar-qafnq-cai` |

## Cycle costs

- `bitcoin_get_balance`: ~0 (inter-canister query call)
- `cktoken_get_balance`: ~0 (inter-canister query call)
- `bitcoin_get_fee_rates`: ~1–10M cycles per call (HTTPS outcall, charged by ICP)

Top up your canister with cycles via:
```bash
dfx canister deposit-cycles 1000000000000 chain-fusion-mcp --network ic
```

## Differences from Node.js server

| Feature | Node.js server | ICP canister |
|---------|---------------|--------------|
| `bitcoin_get_balance` | ✅ | ✅ |
| `bitcoin_get_fee_rates` | ✅ | ✅ |
| `bitcoin_broadcast_transaction` | ✅ | ❌ |
| `eth_get_balance` | ✅ | ❌ (planned) |
| `cktoken_get_balance` | ✅ | ✅ |
| `cktoken_transfer` | ✅ | ❌ (needs identity) |
| `ckbtc_get_deposit_address` | ✅ | ❌ (planned) |
| `ckbtc_withdraw` | ✅ | ❌ (needs identity) |
| Identity/signing | PEM key | t-ECDSA (future) |
| Persistence | JSONL logs | On-chain stable memory (future) |
| Cycles budget | CYCLES_BUDGET_E8S | Automatic (canister balance) |
