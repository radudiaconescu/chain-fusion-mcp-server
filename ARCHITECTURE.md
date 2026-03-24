# Architecture Decision Record

This document captures the key design decisions made during the initial planning and
engineering review of the Chain Fusion MCP server, with the rationale behind each choice
and the tradeoffs that were explicitly accepted.

---

## 1. Scope: greenfield expansion

**Decision:** Build a full multi-chain read + write MCP server from scratch rather than
wrapping an existing library or limiting scope to a single chain.

**Why:** This is a greenfield project with no legacy code to preserve. Limiting scope to
reads-only or a single chain would make the server useful only for demos. The core value
proposition — Claude as a first-class multi-chain participant without custodians — requires
at minimum Bitcoin, Ethereum, and ICP ckToken coverage to demonstrate the Chain Fusion
concept end-to-end. Write tools (broadcast) were included because Claude constructing
transactions and being unable to submit them is a dead end.

**Tradeoffs accepted:**
- Larger initial surface area means more things that can be wrong before production hardening
- Three distinct chain ecosystems (Bitcoin/Mempool, EVM/JSON-RPC, ICP/agent) increase
  dependency footprint and maintenance burden
- Deferred: key generation, transaction signing, ICRC-2 transfers, arbitrary canister calls

---

## 2. Stack: TypeScript / Node.js

**Decision:** TypeScript on Node.js using `@modelcontextprotocol/sdk` for MCP and
`@dfinity/agent` + `@dfinity/ledger-icrc` for ICP.

**Why:**
- The MCP SDK and all Dfinity JS packages are first-class TypeScript — no bindings layer,
  no generated stubs, types come from the source.
- Node.js `crypto` module handles PKCS8 PEM parsing natively (no native addons, no WASM).
- ESM-native: `"type": "module"` in `package.json` avoids the dual-module hazard and works
  cleanly with Vitest's ESM test runner.
- The alternative (Rust) would require writing an MCP server from scratch and either
  compiling `wabt`/`candid` from source or calling out to external processes. Significant
  added complexity for no functional benefit at this stage.

---

## 3. ICP identity: PEM file (not hardware key or keystore)

**Decision:** Identity is loaded from a PKCS8 Ed25519 PEM file at startup, as exported by
`dfx identity export`.

**Why:**
- dfx exports Ed25519 PKCS8 PEM by default since v0.14. Every ICP developer already has
  one. No new tooling required.
- The PEM is parsed entirely via Node.js `createPrivateKey()` + JWK export — no dependency
  on `@dfinity/identity-secp256k1` or native addons.
- Alternative (HSM / hardware key): adds a hardware dependency and removes the ability to
  run the server in CI or headless environments. Deferred.
- Alternative (browser-based `AuthClient` / Internet Identity): requires a browser and
  user interaction. Incompatible with a server process. Not applicable.
- secp256k1 keys (older dfx identities) are intentionally unsupported in v0.1 — the
  `@dfinity/identity-secp256k1` package is a separate install. The error message tells the
  user exactly how to migrate.

**Implementation:** `createPrivateKey(pem)` → `export({ format: 'jwk' })` → read `d` field
as base64url → `Ed25519KeyIdentity.fromSecretKey()`. See `src/identity.ts`.

---

## 4. Transport: both stdio and SSE

**Decision:** Support both `stdio` (Claude Desktop / `claude` CLI) and SSE (Express HTTP
server) via `MCP_TRANSPORT=stdio|sse|both`.

**Why:**
- `stdio` is the dominant transport for local Claude Desktop integrations — it is the
  path of least friction for developers trying the server.
- SSE is required for remote deployments (e.g., a server running on a VPS shared across
  multiple Claude sessions). Without it, the server cannot be hosted.
- The two transports are independent; running `both` simultaneously costs nothing but a
  few extra file descriptors.
- In `stdio` mode all log output goes to `stderr` (not `stdout`) so it does not corrupt
  the MCP binary stream.

**Session management (SSE):** Each `GET /sse` connection creates a new `SSEServerTransport`
keyed by `sessionId`. Messages are routed back via `POST /messages?sessionId=...`. This
matches the MCP SDK's expected SSE session model and supports concurrent clients.

---

## 5. Bitcoin reads via Mempool.space, not ICP management canister

**Decision:** Bitcoin balance, UTXO, and fee rate reads use the Mempool.space public REST
API rather than ICP's native `bitcoin_get_balance` / `bitcoin_get_utxos` management
canister methods.

**Why:** ICP's native Bitcoin methods are **update calls** — they go through full consensus
and require the caller to attach cycles. An `HttpAgent` running outside a canister cannot
attach cycles to a call. There is no mechanism for an external HTTP agent to fund an update
call. Mempool.space provides the same data via free, low-latency REST endpoints and covers
both mainnet and testnet. The `BTC_API_URL` override allows operators to point at a
self-hosted Mempool instance if they need greater trust guarantees.

**Tradeoff:** Mempool.space data is not threshold-signed by ICP. A compromised Mempool API
could return false balance or UTXO data. Acceptable for v0.1; production use should verify
against an independent source before signing transactions.

---

## 6. Ethereum reads via standard JSON-RPC

**Decision:** ETH tools call any operator-supplied `ETH_RPC_URL` directly (Infura, Alchemy,
local node) rather than routing through ICP's EVM RPC canister.

**Why:** The EVM RPC canister on ICP is useful when running *inside* a canister (where you
cannot make outbound HTTP calls directly). From an external Node.js process, adding an ICP
hop adds latency (ICP consensus round) and complexity (cycles, Candid encoding) with no
benefit — the result is the same JSON-RPC response. Direct RPC is simpler, faster, and
gives the operator full control over which node they trust.

**The EVM RPC canister is still relevant** for the embedded EVM error JSON detection:
`ic-evm-rpc` occasionally returns EVM errors as JSON strings inside Candid text fields
rather than in the standard `error` key. `extractEvmResult()` in `src/errors.ts` handles
this pattern for forward compatibility.

---

## 7. ckToken balances via ICRC-1 query (free, uncertified)

**Decision:** `cktoken_get_balance` uses `IcrcLedgerCanister.balance()` which issues an
ICRC-1 `icrc1_balance_of` **query call** — not an update call.

**Why:** Query calls on ICP run on a single replica, return in ~200ms, and cost no cycles
from the caller. For balance reads this is the right tradeoff: the user gets a fast,
cost-free result. The data is not certified by default (not signed by a threshold of
replicas), but ICRC-1 ledger canisters are on the NNS-managed fiduciary subnet, which
provides strong operational trust guarantees in practice.

**If certified reads are needed:** Fetch a certified response and verify the certificate
against the IC root key. This is out of scope for v0.1.

---

## 8. Single shared HttpAgent at startup (not per-request)

**Decision:** One `HttpAgent` instance is created at startup and shared across all tool
invocations for the lifetime of the process.

**Why:**
- `HttpAgent` creation involves PEM parsing, JWK extraction, and (for non-mainnet) a
  `fetchRootKey()` HTTP round-trip. Per-request agent creation would add 50–200ms to every
  ICP tool call.
- The agent holds no mutable request state between calls — it is safe to share across
  concurrent tool invocations.
- The agent's identity (the PEM-derived Ed25519 key) does not need to change during the
  session.

**Alternative considered:** Per-call agent factory that caches by identity hash. Rejected
as premature — there is only ever one identity in this server.

---

## 9. Express for SSE transport

**Decision:** The SSE transport uses Express rather than Node.js's built-in `http` module
or a framework like Fastify/Hono.

**Why:** Express is the de facto standard for simple Node.js HTTP servers. The SSE surface
is tiny (two routes: `GET /sse`, `POST /messages`) and does not benefit from Fastify's
schema-based optimisations or Hono's edge-runtime compatibility. Express adds minimal
overhead and is already a transitive dependency of several Dfinity packages. Using the
built-in `http` module was considered but would require manual request body parsing and
routing, adding boilerplate with no benefit.

---

## 10. Zod for config validation and input schemas

**Decision:** `zod` is used for both environment variable config validation (`src/config.ts`)
and tool input schema definitions.

**Why:**
- Zod produces clear, field-level error messages at startup when config is wrong (via
  `required_error` on `.string()`). `process.exit(1)` with a human-readable message is
  far better than a cryptic runtime failure 30 seconds into the first tool call.
- The MCP SDK accepts Zod schemas directly for tool input validation — no manual JSON
  Schema construction.
- `z.coerce.number()` handles the env-var-to-number conversion (`MCP_SSE_PORT`,
  `CACHE_TTL_MS`) transparently.
- Alternative (manual validation + JSON Schema objects): more verbose, no type inference,
  error messages require hand-writing.

---

## 11. Central error normalisation (`src/errors.ts`)

**Decision:** All tool handlers call `toMcpError(err, context)` which maps any thrown value
to a structured `McpError` with a consistent format.

**Why:** Three distinct error ecosystems converge in this server:
1. ICP `ReplicaRejectError` — has `reject_code` (3/4/5) and `reject_message`
2. EVM JSON-RPC errors — plain objects with `{ code: number, message: string }`
3. Network errors — `TypeError` from `fetch` with a message containing "fetch"

Without central normalisation, each tool handler would need to know about all three error
shapes. `toMcpError()` hides this complexity and ensures Claude always receives a structured
`McpError` rather than an unformatted stack trace.

**Critical ordering:** `instanceof McpError` must be checked *before* `isEvmRpcError()`
because `McpError` has both `code` (number) and `message` (string) fields that satisfy the
EVM error shape check. See `src/errors.ts:27`.

---

## 12. Confirmation guard via `confirm: true` schema field

**Decision:** Write tools (`bitcoin_broadcast_transaction`, `eth_send_raw_transaction`)
declare `confirm: z.literal(true).optional()` in their Zod schema. Omitting it returns a
preview; passing `confirm: true` executes the write.

**Why:**
- Claude calls tools speculatively during planning. Without a guard, a tool-calling loop
  could broadcast a transaction before the user has reviewed it.
- `z.literal(true).optional()` means Claude must explicitly pass the value `true` — it
  cannot satisfy the schema by passing `"true"`, `1`, or `false`.
- The preview response includes enough information (network, truncated hex, byte count) for
  the user to verify intent before approving.
- Alternative (separate `preview_*` and `execute_*` tools): doubles the tool count and
  creates confusion about which to call. Single tool with a confirmation gate is clearer.

---

## 13. In-session idempotency via module-level Set

**Decision:** A module-level `Set<string>` tracks raw transaction hex strings broadcast in
the current process lifetime. A duplicate submission returns a warning without calling the
network.

**Why:** Claude can call a tool multiple times in the same session if it loses track of
the result (e.g., after a timeout or a planning loop). Broadcasting the same signed
transaction twice would cause a "transaction already in mempool" error on the network side
and confuse Claude. The module-level Set catches this within a session at zero cost.

**Known limitation:** The Set is cleared on server restart. If Claude times out waiting for
a response and then re-connects to a fresh server instance, the duplicate check will not
fire. Durable idempotency (request ID persistence to disk) is a P0 TODO.

---

## 14. LRU read cache with 10s TTL

**Decision:** All read-only tool responses are cached in a `LRUCache<string, string>` with
a 10-second TTL and a 500-entry cap.

**Why:**
- During a transaction-building conversation, Claude will call `bitcoin_get_utxos` or
  `eth_get_balance` several times for the same address. Without a cache, each call makes a
  real network round-trip (Mempool.space or an ETH RPC node).
- 10 seconds is short enough to keep data fresh for user-facing decisions and long enough
  to absorb rapid repeated calls within a single Claude response.
- Cache values are serialised JSON strings (not parsed objects) to avoid the `lru-cache`
  value type constraint and make cache reads a simple string lookup.
- Write tools are never cached — cache keys are only set in read-only handlers.

**LRU over a plain Map:** The 500-entry cap prevents unbounded memory growth in long-running
SSE sessions with many distinct addresses.

---

## 15. Vitest for tests

**Decision:** Tests use Vitest rather than Jest.

**Why:**
- The project uses `"type": "module"` (ESM). Jest requires `--experimental-vm-modules` or
  a Babel transform to handle ESM. Vitest is ESM-native and works out of the box.
- Vitest's `vi.stubGlobal('fetch', mockFetch)` replaces the global `fetch` used by all
  tool handlers cleanly, without needing `jest.spyOn(global, 'fetch')` hacks.
- API is Jest-compatible (`describe`, `it`, `expect`, `beforeEach`) so there is no learning
  curve.
- Fast: 35 tests complete in ~400ms with zero configuration.

---

## 16. Eager `fetchRootKey()` for non-mainnet

**Decision:** When `ICP_NETWORK` is not `mainnet`, `fetchRootKey()` is called immediately
after agent creation, not lazily on the first tool call.

**Why:**
- On local dfx replicas and testnets the root key changes on every network restart.
  Fetching it lazily means the first tool call after a network restart pays the latency
  cost (200–500ms) and any connectivity failure surfaces as a confusing tool error rather
  than a clear startup error.
- Eager fetch surfaces connectivity problems at startup with a clear `process.exit(1)`
  message: "Failed to fetch ICP root key from {host}."
- On mainnet `fetchRootKey()` is never called — it is a security risk to trust a
  dynamically fetched root key on the production network where the key is baked into the
  SDK.

---

## 17. Identified critical gaps (P0 before production)

Three failure modes were identified during the engineering review that must be addressed
before the server is used with real funds:

**1. t-ECDSA timeout with no recovery path**
ICP threshold signing (for ckBTC withdrawal or future native BTC signing) can take up to
30 seconds. If the `HttpAgent` times out before receiving the response, Claude has no way
to know whether the transaction was submitted. The idempotency Set covers the
duplicate-broadcast case but not the timeout-before-response case. Fix: persist the ICP
request ID to disk before sending the signing request, then poll for the response on
recovery.

**2. EVM error JSON embedded in ic-evm-rpc responses**
The ic-evm-rpc canister sometimes returns EVM errors as JSON-encoded strings inside Candid
text fields rather than in the standard JSON-RPC `error` key. `extractEvmResult()` handles
the known pattern, but edge cases may leak raw JSON to Claude. Fix: expand the detection
logic and add test cases for each known error shape.

**3. No cycles budget cap**
There is no per-request or per-session spending limit on ICP cycles. A runaway Claude
session (e.g., a loop calling `cktoken_get_balance` on thousands of principals) could burn
an unchecked amount of cycles. Fix: add a `MAX_CYCLES_PER_SESSION` config variable and a
middleware counter that rejects tool calls once the budget is exhausted.
