# Architecture Decision Record

This document captures every significant design decision made during the planning and
engineering review of the Chain Fusion MCP server. For each decision the full option space
that was considered is documented alongside the reasoning for the chosen approach and the
tradeoffs that were explicitly accepted.

---

## 1. Scope: greenfield multi-chain expansion

**Decision:** Build a full multi-chain read + write MCP server from scratch, covering
Bitcoin, Ethereum, and ICP ckTokens, including transaction broadcast tools.

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — Reads only | Balance and UTXO reads, no write tools | Rejected |
| B — Single chain (BTC only) | Start narrow, expand later | Rejected |
| **C — Multi-chain reads + broadcast** | **Bitcoin + ETH + ckTokens, broadcast pre-signed txs** | **Chosen** |
| D — Full signing | Includes key generation and transaction construction | Deferred |

**Why C:** The core value proposition is Claude as a multi-chain participant without
custodians. A reads-only server is useful only as a demo — Claude can read balances but
cannot act on them. A single-chain server fails to demonstrate Chain Fusion, which is
specifically ICP's cross-chain story. Broadcasting pre-signed transactions was included
because the alternative (Claude constructs a transaction then can't submit it) is a dead
end that forces a copy-paste step outside the AI workflow.

**Why not D:** Transaction signing requires key management (generating, storing, and
protecting private keys) inside the MCP server. That is a substantial security engineering
problem that deserves its own design pass. ICP's t-ECDSA integration (threshold signing
without a private key on any single machine) is the right long-term answer, but it has
open failure modes (the 30s timeout gap) that aren't safe to ship yet. Signing is tracked
as a P1 follow-up.

**Tradeoffs accepted:**
- Three distinct chain ecosystems increase the dependency footprint and ongoing maintenance
  surface relative to a single-chain server
- More things can go wrong before production hardening is complete
- Deferred: transaction construction, key generation, ICRC-2 transfers, arbitrary canister calls

---

## 2. Stack: TypeScript / Node.js

**Decision:** TypeScript on Node.js, `"type": "module"` (ESM), using
`@modelcontextprotocol/sdk`, `@icp-sdk/core`, and `@icp-sdk/canisters`.

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — Rust | Native binary, strong types, no GC | Rejected |
| B — Python | Widely known, easy prototyping | Rejected |
| C — Go | Fast startup, small binary | Rejected |
| **D — TypeScript / Node.js (ESM)** | **First-class SDK support, native PEM parsing, ESM-native testing** | **Chosen** |

**Why D:**

- **SDK first-class support.** `@modelcontextprotocol/sdk`, `@icp-sdk/core` (agent,
  identity, principal, candid), and `@icp-sdk/canisters` (ICRC-1 ledger, Bitcoin canister)
  are all TypeScript-first packages. Using any other language would require either REST
  shims, generated Candid bindings, or calling out to a JS subprocess — adding a translation
  layer with no functional benefit.

- **PEM parsing with no native addons.** Node.js's built-in `crypto.createPrivateKey()`
  parses PKCS8 Ed25519 PEMs and exports JWK natively. No C extension, no WASM, no
  `openssl` subprocess.

- **ESM-native.** Setting `"type": "module"` in `package.json` and using `.js` extensions
  in imports avoids the CommonJS/ESM dual-module hazard that plagues many Node.js packages.
  It also allows Vitest to run tests without a Babel or `ts-jest` transform step.

**Why not Rust:** The Rust MCP SDK is immature and the Dfinity Rust agent (`ic-agent`) has
a significantly different API surface from the JS agent. Candid encoding for ICP calls
would require writing or generating type-safe Rust bindings. The development cost is 3–4x
higher for no user-visible benefit at this stage.

**Why not Python:** The MCP Python SDK exists but the Dfinity Python bindings are
unofficial and incomplete. Python also has no native PKCS8 PEM-to-raw-key extraction
without `cryptography` or `openssl` subprocess calls.

**Why not Go:** No official Dfinity Go SDK. Would require either a REST proxy to a JS
process or hand-writing Candid encoding. Significantly higher implementation cost.

---

## 3. ICP identity: PEM file (Ed25519 + secp256k1)

**Decision:** Identity is loaded from a PEM file at startup. Both PKCS8 Ed25519 (dfx
default) and SEC1/PKCS8 secp256k1 (icp-cli default, older dfx) are supported. The key is
parsed via Node.js `crypto` into an `Ed25519KeyIdentity` or `Secp256k1KeyIdentity` at
process start.

### Identity tooling

| Tool | Command | PEM format |
|------|---------|------------|
| `dfx` (v0.14+) | `dfx identity export <name> > identity.pem` | PKCS8 Ed25519 |
| `icp-cli` | `icp-cli new-identity <name>` | SEC1 secp256k1 (stored at `~/.config/dfx/identity/<name>/identity.pem`) |
| `dfx` (legacy, pre-v0.14) | `dfx identity export <name> > identity.pem` | SEC1 secp256k1 |

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — Internet Identity / AuthClient | Browser-based wallet, no key file | Rejected |
| B — Hardware key (YubiKey / HSM) | Maximum security, hardware-bound key | Deferred |
| C — Encrypted keystore (password-protected) | Key stored on disk, encrypted at rest | Rejected |
| D — Environment variable (raw hex secret) | Simple, no file required | Rejected |
| **E — PKCS8 Ed25519 PEM (dfx default)** | **Matches dfx output, parseable natively** | **Chosen** |
| **F — secp256k1 PEM (icp-cli / older dfx)** | **Supported via `Secp256k1KeyIdentity.fromPem()`** | **Also chosen** |

**Why E + F:**

- Both formats are PEM files on disk — the same security properties apply (`chmod 600`,
  out of shell history, inspectable with `openssl`).
- `createPrivateKey(pem).export({ format: 'jwk' })` identifies the curve (kty=OKP/Ed25519
  vs kty=EC/secp256k1). Ed25519 keys are loaded via `Ed25519KeyIdentity.fromSecretKey()`;
  secp256k1 keys use `Secp256k1KeyIdentity.fromPem()` from `@icp-sdk/core/identity/secp256k1`.
- Supporting both eliminates the "migrate your identity" friction when onboarding users of
  icp-cli or older dfx installations.

**Why not A (Internet Identity):** `@icp-sdk/auth` (AuthClient) requires a browser window
and user interaction. An MCP server is a headless process that cannot open a browser or
await human input mid-session. Not applicable.

**Why not B (hardware key):** Hardware keys cannot run in CI, containers, or headless
servers. Tracked as a future security hardening step.

**Why not C (encrypted keystore):** Password-protected keystores require either an
interactive password prompt (incompatible with headless startup) or a second secret to
unlock the first. Adds complexity without changing the fundamental trust model.

**Why not D (env var):** Raw hex secrets are one `printenv` or misconfigured log away from
leaking. PEM files on disk are the established ICP convention.

**Implementation:** `createPrivateKey(pem)` → `export({ format: 'jwk' })` → branch on
kty/crv → `Ed25519KeyIdentity.fromSecretKey(Uint8Array)` or `Secp256k1KeyIdentity.fromPem(pem)`.
See `src/identity.ts`.

---

## 4. Transport: stdio + SSE (both selectable)

**Decision:** Support `stdio`, `sse`, and `both` via `MCP_TRANSPORT`. Default is `stdio`.
SSE uses Express on a configurable port. The two transports are independently startable and
can run simultaneously.

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — stdio only | Simple, no HTTP server | Rejected |
| B — SSE only | Remote-capable, no stdin/stdout pipes | Rejected |
| **C — Both, selectable at runtime** | **stdio for local, SSE for remote, `both` for testing** | **Chosen** |
| D — WebSocket | Bidirectional, lower overhead than SSE | Rejected |
| E — HTTP streaming (chunked transfer) | No EventSource client required | Rejected |

**Why C:**

- `stdio` is the path of least friction for Claude Desktop and the `claude` CLI. It
  requires zero network configuration — the Claude process simply spawns the MCP server as
  a child process and communicates over stdin/stdout.
- SSE is required for any deployment where the server is not on the same machine as Claude
  (VPS, Docker container, shared team server). Without it, the server cannot scale beyond
  a single developer's laptop.
- Running `both` simultaneously is useful during development (SSE for debugging with curl,
  stdio for the actual Claude integration) and costs only a few extra file descriptors.
- In `stdio` mode, all `console.error()` output goes to `stderr`, which is not part of the
  MCP stream. `console.log()` is never used for logs to avoid corrupting the binary-framed
  stdout.

**Why not D (WebSocket):** The MCP SDK v1.x ships `SSEServerTransport` as the reference
HTTP transport. WebSocket would require either a custom transport implementation or waiting
for the SDK to add one. Unnecessary complexity for two routes.

**Why not E (chunked HTTP):** SSE is better supported by the MCP SDK and has broader
EventSource client compatibility (browser-native). Chunked transfer would require a custom
client implementation.

**SSE session model:** Each `GET /sse` creates a new `SSEServerTransport` keyed by
`transport.sessionId`. Subsequent `POST /messages?sessionId=...` messages are routed to
the correct transport. Concurrent clients are supported.

---

## 5. Bitcoin reads: ICP Bitcoin canister (balance/UTXOs) + Mempool.space (fee rates/broadcast)

**Decision:** Bitcoin balance and UTXO reads use the dedicated ICP Bitcoin canister
(`ghsi2-tqaaa-aaaan-aaaca-cai` mainnet) via query calls. Fee rates and transaction
broadcast still use the Mempool.space REST API.

### Background: management canister deprecation

ICP's original `bitcoin_get_balance` and `bitcoin_get_utxos` were methods on the
**management canister**. These have been deprecated and removed. Bitcoin functionality
now lives in a dedicated **Bitcoin canister** with the same methods but a separate
canister ID. The Bitcoin canister exposes both update variants (canister-to-canister,
consume cycles) and `_query` variants (externally callable, no cycles, not certified).

### Options considered

| Operation | Source | Rationale |
|-----------|--------|-----------|
| `bitcoin_get_balance` | Bitcoin canister `getBalanceQuery()` | Query call, no cycles, direct ICP data |
| `bitcoin_get_utxos` | Bitcoin canister `getUtxosQuery()` | Query call, no cycles, direct ICP data |
| `bitcoin_get_fee_rates` | Mempool.space REST | Bitcoin canister fee percentiles are update-only (canister-to-canister) |
| `bitcoin_broadcast_transaction` | Mempool.space REST | Bitcoin canister `send_transaction` is update-only (canister-to-canister) |

### Why Bitcoin canister for balance/UTXOs

The dedicated Bitcoin canister's `getBalanceQuery()` and `getUtxosQuery()` are genuine ICP
query calls: they execute on a single replica, cost no cycles for external callers, and
return in ~200ms. This directly exercises ICP's Bitcoin integration rather than routing
through a third-party API.

**Tradeoff:** Balance is **confirmed only** (default: 6+ confirmations). There is no
mempool/unconfirmed balance available from the query path. Tools that previously reported
`unconfirmed_satoshis` no longer include that field — only `confirmed_satoshis` is returned.

UTXO data from the Bitcoin canister includes `height` (block height; 0 = depth within
confirmation window) but not the full Mempool.space metadata (address type, mempool flags).
The `txid` field is a raw `Uint8Array` — converted to hex in the tool response.

**Why not the update variants:** Update calls (`bitcoin_get_balance`, `bitcoin_get_utxos`)
go through BFT consensus and require the caller to attach cycles. External `HttpAgent`
clients cannot attach cycles — that is a canister-level resource. Only the `_query`
variants are accessible from external JS clients.

### Why Mempool.space for fee rates and broadcast

The Bitcoin canister's `bitcoin_get_current_fee_percentiles` and `bitcoin_send_transaction`
are update calls, canister-to-canister only. No external equivalent exists in the Bitcoin
canister API. Mempool.space remains the pragmatic choice for these operations.

The `BTC_API_URL` override allows operators to substitute any Mempool.space-compatible
endpoint (Mempool.space is open source) for fee rate and broadcast operations.

**Canister IDs:**
- Mainnet: `ghsi2-tqaaa-aaaan-aaaca-cai`
- Testnet: `g4xu7-jiaaa-aaaan-aaaaq-cai`

---

## 6. Ethereum reads: direct JSON-RPC

**Decision:** ETH tools call any operator-supplied `ETH_RPC_URL` directly (Infura, Alchemy,
local node, Anvil). The ICP EVM RPC canister is not used as an intermediary.

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — ICP EVM RPC canister | Routes calls through ICP consensus, canister-verifiable | Rejected |
| **B — Direct JSON-RPC to operator-supplied endpoint** | **Simpler, faster, operator controls trust** | **Chosen** |
| C — ethers.js / viem provider abstraction | Higher-level library, hides raw RPC | Rejected |
| D — Infura/Alchemy SDK | Vendor-specific, not portable | Rejected |

**Why B:**

The EVM RPC canister is designed for use *inside* ICP canisters — environments where
outbound HTTP calls are impossible without going through ICP's HTTPS outcalls mechanism.
From an external Node.js process that can make outbound HTTP calls directly, routing through
the EVM RPC canister adds:
- One full ICP consensus round (200–2000ms additional latency)
- Candid encoding and decoding of the request and response
- Cycles cost per call (the canister charges for outbound HTTPS calls)
- An additional trust assumption (the EVM RPC canister's operator nodes)

...for zero additional correctness. The JSON-RPC response from the Ethereum node is
identical whether it arrives directly or relayed through ICP.

**Why not C (ethers.js / viem):** Both are excellent for application-level Ethereum
development but are heavyweight (ethers.js is 300+ KB). The server only needs four
methods: `eth_getBalance`, `eth_call`, `eth_getTransactionByHash`, and
`eth_sendRawTransaction`. A thin `ethRpc()` wrapper over `fetch` is 15 lines and adds no
dependency. Adding ethers.js or viem would bring in ABI encoding, wallet management, and
contract abstractions that are not used here.

**Why not D (vendor SDK):** Ties the server to a specific provider. The generic JSON-RPC
approach works with any EVM-compatible node (Infura, Alchemy, QuickNode, local Anvil/Hardhat,
the ICP EVM RPC canister itself if desired).

**Note on EVM RPC canister error format:** Despite not routing calls through it, the server
still handles the EVM RPC canister's error format in `extractEvmResult()`. This canister
sometimes returns EVM errors as JSON-encoded strings inside Candid text fields rather than
in the JSON-RPC `error` key. The detection code is present for forward compatibility in
case the server is later configured to route through the canister.

---

## 7. ckToken balances: ICRC-1 query call (not update, not HTTP)

**Decision:** `cktoken_get_balance` uses `IcrcLedgerCanister.balance()` which issues an
ICRC-1 `icrc1_balance_of` query call to the ICP ledger canister. Not an update call, not
an HTTP REST endpoint.

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — ICRC-1 update call (`icrc1_balance_of` as update) | Certified result, costs cycles | Rejected |
| **B — ICRC-1 query call (default)** | **Free, fast, uncertified** | **Chosen** |
| C — ICP dashboard REST API | HTTP wrapper around ICP data, centralised | Rejected |
| D — Certified query + certificate verification | Certified result, cryptographically verifiable | Deferred |

**Why B:**

ICRC-1's `icrc1_balance_of` is intentionally defined as a query call in the standard. Query
calls on ICP execute on a single replica, return in ~200ms, and cost the caller zero cycles.
For a tool whose purpose is to tell Claude what a user's balance is, this is the right
tradeoff. The ckToken ledger canisters (ckBTC, ckETH, ckUSDC) are all on the NNS-governed
fiduciary subnet, which provides strong operational trust in practice — a malicious response
from a single replica would be an extraordinary event.

This is also the first tool in the server that makes a genuine ICP canister call. Unlike
Ethereum (direct RPC), `cktoken_get_balance` actually exercises the `@icp-sdk/core` agent
and `@icp-sdk/canisters/ledger/icrc` stack end-to-end. This is the Chain Fusion
demonstration — a real on-chain ICP query call, no HTTP middleman.

**Why not A (update call):** Update calls cost cycles, go through consensus, and take
500ms–2s. For a balance read, this is unnecessary overhead. The ICRC-1 standard uses query
calls for `icrc1_balance_of` precisely because balance reads don't need consensus.

**Why not C (HTTP REST):** Using an HTTP wrapper (ICP dashboard API, ic.house API) would
make `cktoken_get_balance` functionally identical to the Bitcoin and Ethereum tools — an
HTTP call to a centralised endpoint. The entire point of this tool is to demonstrate a
genuine ICP canister interaction. Using REST would undermine the Chain Fusion narrative.

**Why not D (certified query):** Certificate verification requires fetching the canister's
certified data, verifying the IC root key signature, and traversing the Merkle tree. This
is non-trivial and would add ~100 lines of verification code. For v0.1 where the server is
already experimental, the operational trust of the NNS-governed subnet is sufficient.
Certified balance reads are tracked as a future hardening step.

---

## 8. HttpAgent lifecycle: single shared instance at startup

**Decision:** One `HttpAgent` is created at startup and passed to all tool handlers as a
shared dependency for the process lifetime.

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — New agent per tool call | Maximum isolation, always fresh root key | Rejected |
| B — Agent pool (e.g., 4 agents) | Concurrency headroom, some reuse | Rejected |
| **C — Single shared agent** | **Created once at startup, zero per-call overhead** | **Chosen** |
| D — Lazy singleton (created on first ICP call) | Deferred startup cost | Rejected |

**Why C:**

`HttpAgent` creation is not cheap: it involves PEM file I/O, `createPrivateKey()`, JWK
export, `Ed25519KeyIdentity.fromSecretKey()`, and (for non-mainnet) a `fetchRootKey()`
network round-trip. On a non-mainnet setup, creating a per-call agent would add 200–500ms
of latency to every ICP tool invocation. The agent holds no mutable per-request state — its
identity, host, and root key are all fixed at creation time. Sharing it across concurrent
calls is safe.

**Why not A (per-call):** 200–500ms per call overhead for the root key fetch, plus the
unnecessary CPU cost of key derivation on each call. No correctness benefit.

**Why not B (pool):** There is only one identity and one ICP endpoint in this server.
Pooling multiple agents of the same identity/host provides no concurrency benefit —
`HttpAgent` is already thread-safe for concurrent calls since it uses stateless request
signing.

**Why not D (lazy singleton):** A lazy singleton would cause the first ICP tool call to
be significantly slower than subsequent ones and would surface connectivity errors as a
tool error rather than a startup error. Eager creation catches misconfigurations early.

---

## 9. SSE HTTP framework: Express

**Decision:** The SSE transport uses Express. Two routes: `GET /sse` and `POST /messages`.

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — Node.js built-in `http` module | Zero dependencies | Rejected |
| **B — Express** | **Minimal, battle-tested, already a transitive dep** | **Chosen** |
| C — Fastify | Schema-based, faster JSON serialisation | Rejected |
| D — Hono | Edge-runtime compatible, modern API | Rejected |
| E — Koa | Middleware composition, lighter than Express | Rejected |

**Why B:**

The SSE server is two routes. There is no JSON serialisation on the hot path (the MCP SDK
handles all serialisation), no complex middleware chain, and no performance requirement that
requires Fastify's schema-based approach. Express handles this workload with essentially
zero observable overhead. More importantly, Express is already present in the dependency
tree as a transitive dependency of several Dfinity packages, so it adds no net new
dependency weight.

**Why not A (built-in `http`):** Would require manual URL routing (`if (req.url ===
'/sse')`), manual query string parsing (`req.url.split('?')[1]`), and manual JSON body
parsing. Approximately 40 lines of boilerplate to replace what Express provides in two
`app.get()` / `app.post()` calls. The built-in module is the right choice for zero-dep
libraries; for an application server, Express is strictly better ergonomics.

**Why not C (Fastify):** Fastify's main benefit is schema-based request/response
serialisation. The SSE endpoints don't serialise application JSON — the MCP SDK writes
directly to the `res` stream. Fastify's schema validation on the `POST /messages` route
would add complexity without benefit. It is also not a transitive dep, adding ~200KB to the
install.

**Why not D (Hono):** Hono's edge-runtime and multi-runtime compatibility is its selling
point. This server runs on Node.js only. Hono is not a transitive dep and would add ~50KB
for a feature (runtime portability) that is not needed.

---

## 10. Config validation: Zod

**Decision:** Zod is used for both environment variable config validation (`src/config.ts`)
and tool input schema definitions. Schemas are declared once and serve both runtime
validation and TypeScript type inference.

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — Manual validation + JSON Schema objects | Maximum control, no library | Rejected |
| B — `joi` | Mature, expressive, JS-only types | Rejected |
| C — `yup` | Similar to Zod, weaker TS inference | Rejected |
| D — `typebox` | JSON Schema–first, excellent TS types | Rejected |
| **E — Zod** | **TypeScript-first, `required_error`, MCP SDK integration, `z.coerce`** | **Chosen** |
| F — `envalid` for config, Zod for tools | Two libraries, clearer separation | Rejected |

**Why E:**

- **MCP SDK integration.** `McpServer.tool()` accepts Zod schemas directly for input
  validation. No conversion step, no duplicate schema definitions. The same Zod object
  that describes the tool's inputs at runtime also provides the TypeScript type for the
  handler function's argument.
- **`required_error` for env vars.** `z.string({ required_error: 'ICP_IDENTITY_PEM is
  required' })` produces a message that names the missing variable directly. Without this,
  Zod's default is `"Required"` — unhelpful for a startup config error.
- **`z.coerce.number()` for env vars.** Environment variables are always strings.
  `z.coerce.number()` converts `"3000"` to `3000` transparently. Manual coercion in each
  handler is boilerplate.
- **Single source of truth.** `z.infer<typeof ConfigSchema>` gives the `Config` type for
  free. Adding a new config field means updating the Zod schema; TypeScript enforces that
  all consumers handle the new field.

**Why not A (manual + JSON Schema):** More verbose, no type inference from schema
definition, error messages require hand-writing, validation logic is duplicated between
config and tool inputs.

**Why not B (joi):** joi's TypeScript types are a separate `@hapi/hoek` dependency and the
inference is weaker than Zod's. joi is also CommonJS-first, which requires additional
configuration in an ESM project.

**Why not D (typebox):** typebox is excellent and produces JSON Schema compatible with more
tools, but the MCP SDK's native Zod integration means typebox would require a conversion
step (typebox → JSON Schema → MCP). Adds a step with no benefit here.

**Why not F (envalid for config):** Using two libraries for closely related concerns (config
validation vs. tool input validation) is unnecessary complexity. Zod handles both cleanly.

---

## 11. Error handling: central `toMcpError()` in `src/errors.ts`

**Decision:** All tool handler `catch` blocks call `toMcpError(err, context)` which
normalises any thrown value into a structured `McpError`. Tool handlers never construct
`McpError` directly except for known precondition checks (e.g., `ETH_RPC_URL` not
configured).

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — Each handler catches and maps its own errors | Maximum locality, no shared code | Rejected |
| B — Middleware wrapper that catches and re-throws | Handlers stay clean, errors centralised | Rejected |
| **C — `toMcpError()` utility called in each `catch`** | **Explicit, testable, no magic wrapping** | **Chosen** |
| D — Global `process.on('uncaughtException')` handler | Catches everything, including unrelated errors | Rejected |

**Why C:**

Three distinct error shapes converge in this server: ICP `ReplicaRejectError` (with
`reject_code` 3/4/5), EVM JSON-RPC errors (plain objects with `{ code, message }`), and
network `TypeError`s from `fetch`. Without a shared normalisation function, every handler
would need to import and test all three shapes. `toMcpError()` is a pure function, easily
unit-tested, and explicit — the handler decides when to call it.

**Critical ordering in `toMcpError()`:** `instanceof McpError` must be checked before
`isEvmRpcError()`. `McpError` has both a numeric `code` field and a string `message` field,
which satisfies the EVM error shape guard. Without the `instanceof` check first, a
`McpError` thrown by `requireRpcUrl()` would be re-wrapped into a new `McpError` with
different code and message, losing the original error type. See `src/errors.ts:27`.

**Why not A (per-handler):** Each handler would need to `import { isReplicaRejectError,
isEvmRpcError }` and implement its own mapping logic. Any new error shape (e.g., a new
Dfinity error class) would require updating every handler. This is the classic case where
central normalisation eliminates cross-cutting repetition.

**Why not B (middleware wrapper):** A wrapping function like `withErrorNormalisation(handler)`
would obscure the error handling in stack traces and make it harder to see where an error
was first caught. Explicit `catch (err) { throw toMcpError(err) }` blocks are visible at
the call site.

**Why not D (global uncaughtException):** This would catch errors from the MCP SDK
internals, Express, and other unrelated code paths. Tool-level errors would lose their
`context` argument. Blunt instrument.

---

## 12. Write tool safety: `confirm: true` schema guard

**Decision:** Write tools declare `confirm: z.literal(true).optional()` in their Zod
schema. Calling without `confirm` returns a preview; calling with `confirm: true` executes
the write.

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — No guard (execute immediately) | Simplest API | Rejected |
| B — Separate `preview_bitcoin_broadcast` and `bitcoin_broadcast` tools | Clear separation | Rejected |
| **C — Single tool, `confirm: true` flag** | **Single tool, preview by default, opt-in execution** | **Chosen** |
| D — Two-phase: tool returns a token, second call redeems token | Cryptographic confirmation | Rejected |
| E — User-level confirmation prompt (out-of-band) | Platform handles confirmation | Rejected |

**Why C:**

Claude calls tools speculatively during planning and reasoning. It will often call a tool
to "see what happens" before committing to an action. Without a guard, a planning loop
could broadcast a transaction before the user has reviewed the details. The `confirm: true`
pattern is established in the MCP ecosystem for exactly this reason.

`z.literal(true).optional()` is deliberate: the only value that satisfies the schema is the
boolean `true`. Passing `"true"` (string), `1` (number), or `false` (wrong boolean) all
fail Zod validation. Claude cannot accidentally trigger execution by passing a truthy value.

**Why not A:** Acceptable for read tools (the worst case is a wasted network round-trip),
unacceptable for broadcast tools where the action is irreversible.

**Why not B (separate tools):** Doubles the tool count (9 tools → 11+ tools). Claude would
need to know to call `preview_bitcoin_broadcast` first then `bitcoin_broadcast` second,
which is non-obvious from tool descriptions alone. A single tool with a guard is more
self-explanatory in its schema.

**Why not D (token-based):** Adds a session state machine (issue token → validate token →
execute). Significantly more complex to implement correctly (token expiry, replay
protection). The `confirm: true` pattern achieves the same safety goal with far less
machinery.

**Why not E (out-of-band prompt):** MCP does not currently have a standardised out-of-band
user confirmation mechanism. The tool itself must handle it.

---

## 13. Idempotency: module-level `Set<string>`

**Decision:** A module-level `Set<string>` tracks the raw hex of every transaction
broadcast in the current process lifetime. A second broadcast attempt with the same hex
returns a warning instead of a network call.

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — No idempotency guard | Simple, rely on network's "already in mempool" error | Rejected |
| **B — Module-level `Set<string>` (in-process, not durable)** | **Zero cost, covers same-session duplicates** | **Chosen** |
| C — File-based persistence (append to `~/.chain-fusion/submitted.log`) | Survives restart, durable | Deferred |
| D — SQLite / LevelDB local database | Durable, queryable, heavier | Rejected |
| E — Hash of tx hex (not full hex) as Set key | Smaller memory footprint | Rejected |

**Why B:**

The primary failure mode is Claude calling `bitcoin_broadcast_transaction` twice within a
single session because it lost track of the result (e.g., a tool timeout caused it to
retry). This is entirely in-process and does not require durability. A `Set<string>` is
zero-cost, requires no I/O, and catches the duplicate on the first check.

**Why not A:** The Mempool.space API returns a 400 error for "transaction already in
mempool." Without the guard, this error propagates to Claude as a tool failure, which
would likely cause Claude to retry the broadcast, creating a confused error loop.

**Why not C/D (durable):** Durable idempotency is a P0 TODO, not rejected. It is the
correct solution for the timeout-before-response failure mode (Claude times out, server
restarts, Claude retries — the Set is empty). However, durable storage requires defining
a storage format, a cleanup strategy, and handling I/O errors. For v0.1, the in-process
Set is the right scope.

**Why not E (hash):** The raw tx hex is used as the key because it is already in memory,
hashing adds a CPU step with no practical benefit (Set lookups on strings are O(1) based on
hash), and the full hex provides a better human-readable audit log if one is added later.

---

## 14. Read cache: LRU with 10s TTL

**Decision:** All read-only tool responses are cached in a `LRUCache<string, string>` with
a 10-second TTL and a 500-entry cap. Cache values are serialised JSON strings.

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — No cache | Maximum freshness, simpler code | Rejected |
| B — Plain `Map<string, string>` with manual TTL | Simple, no dependency | Rejected |
| **C — `lru-cache` with TTL and entry cap** | **Bounded memory, TTL built-in, well-tested** | **Chosen** |
| D — Redis | External cache, persistent, shared across instances | Rejected |
| E — Per-tool custom caching logic | Maximum control per tool | Rejected |

**Why C:**

During a transaction-building conversation, Claude will call `bitcoin_get_utxos` or
`eth_get_balance` multiple times for the same address within seconds. Without a cache, each
call is a real network round-trip. The `lru-cache` package handles TTL expiry, LRU eviction,
and bounded memory automatically. It is a single transitive dep that is already widely used.

**TTL of 10 seconds:** Short enough that stale data does not mislead a user making a
decision (UTXO sets and balances are unlikely to change in 10 seconds during a single
conversation), long enough to absorb the repeated rapid calls Claude makes within one
response generation.

**500-entry cap:** In a long-running SSE session with many distinct addresses, a plain `Map`
would grow without bound. 500 entries × ~1 KB average JSON per entry = ~500 KB maximum
memory. The LRU eviction means the most recently used entries are retained.

**String values, not parsed objects:** `lru-cache` v11 requires value type `{}` (non-null
object). Storing parsed JavaScript objects would violate this constraint for primitive
values like numbers. Storing serialised JSON strings avoids the type constraint entirely
and makes cache reads a single string lookup — the caller JSON-parses if needed, or more
commonly the cached string is returned directly as the tool response text.

**Why not A (no cache):** Every repeated call within a conversation would make a real
network request. For Mempool.space this is a free REST call, so the cost is latency only,
but the pattern of calling the same tool multiple times in quick succession is common enough
to warrant caching.

**Why not B (plain Map):** A plain `Map` has no TTL mechanism and no eviction policy.
Implementing both correctly is more code than using `lru-cache`. The Map also grows
without bound in a long-running server.

**Why not D (Redis):** Redis is an external service with a connection, serialisation
overhead, and operational complexity. For a single-process MCP server, an in-memory cache
is always faster and requires no infrastructure. Redis would be appropriate for a
horizontally scaled deployment; that is not the v0.1 scenario.

---

## 15. Test framework: Vitest

**Decision:** Tests use Vitest. The test runner, assertion library, and mocking system are
all from Vitest. No Jest, Mocha, or native Node.js test runner.

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — Jest | Most popular, excellent ecosystem | Rejected |
| **B — Vitest** | **ESM-native, Jest-compatible API, fast, `vi.stubGlobal`** | **Chosen** |
| C — Node.js built-in test runner (`node:test`) | Zero dependencies | Rejected |
| D — Mocha + Chai + Sinon | Modular, proven | Rejected |
| E — `tap` | TAP output, minimal API | Rejected |

**Why B:**

The project uses `"type": "module"` (ESM). Jest's ESM support requires either
`--experimental-vm-modules` (Node.js flag, unstable API surface) or a `babel-jest`
transform that strips types and converts ESM to CommonJS. Both approaches add config
overhead and obscure the actual source being tested.

Vitest is ESM-native: no transform required, `.ts` files are imported directly via
`tsx`/`esbuild`, and `import.meta` works in tests. The test suite requires a single
`vitest.config.ts` with four lines.

`vi.stubGlobal('fetch', mockFetch)` replaces the global `fetch` function used by all tool
handlers cleanly, without any `jest.spyOn(global, 'fetch')` footgun (Jest's global stubbing
has well-documented pitfalls with ESM).

**Why not A (Jest):** The ESM + TypeScript setup would require `babel.config.json` or
`jest.config.ts` with `transform`, `extensionsToTreatAsEsm`, and `moduleNameMapper`
entries. This is a known painful configuration that Vitest was explicitly designed to
eliminate.

**Why not C (built-in `node:test`):** The Node.js built-in test runner has no built-in
mocking system. `vi.stubGlobal` would need to be replaced with manual monkey-patching of
the global `fetch`. The assertion API is not Jest-compatible, requiring a learning step.
Also lacks `beforeEach` with automatic cleanup.

**Why not D (Mocha + Chai + Sinon):** Three packages to configure instead of one. Mocha's
ESM support via `--loader` is functional but requires separate setup. The split between
runner (Mocha), assertions (Chai), and mocks (Sinon) adds boilerplate compared to Vitest's
unified API.

---

## 16. Root key fetch: eager at startup for non-mainnet

**Decision:** When `ICP_NETWORK !== 'mainnet'`, `agent.fetchRootKey()` is called
immediately after agent creation. If it fails, the server exits with a clear error before
accepting any tool calls.

### Options considered

| Option | Description | Verdict |
|--------|-------------|---------|
| A — Lazy (fetch on first ICP tool call) | Defers startup cost, no cost if ICP tools unused | Rejected |
| **B — Eager (fetch at startup, exit on failure)** | **Fast first tool call, errors surface early** | **Chosen** |
| C — Background fetch (start server, fetch root key async) | No startup delay, possible race condition | Rejected |
| D — Cache root key to disk, refresh periodically | Survives restarts, complex invalidation | Rejected |

**Why B:**

On local dfx replicas and IC testnets, the root key changes every time the network is
restarted (dfx stop / dfx start). This means a stale cached root key will cause every ICP
call to fail with a signature verification error. Fetching eagerly at startup guarantees
the key is current and surfaces connectivity problems before the server starts accepting
tool calls — Claude gets a clear startup error rather than a confusing tool error 30 seconds
into a conversation.

The latency cost (one HTTP round-trip to the ICP node, ~100–200ms) is paid once. Every
subsequent tool call within the session uses the cached key with zero overhead.

**Mainnet is never called.** On mainnet, `fetchRootKey()` would be a security risk:
the IC root key is a trust anchor hardcoded in the Dfinity SDK. A server that dynamically
fetches and trusts a root key over HTTPS could be MITM'd. The SDK intentionally logs a
warning if `fetchRootKey()` is called on mainnet. The server skips it entirely for mainnet.

**Why not A (lazy):** The first ICP tool call (typically `cktoken_get_balance`) would pay
the root key fetch latency. More importantly, if the dfx replica is not running, the error
would manifest as a tool failure ("Canister query failed") with no indication that the
underlying problem is a missing root key. Startup errors are much more diagnosable.

**Why not C (background):** Creates a race condition where the first ICP tool call might
arrive before `fetchRootKey()` completes. Handling this requires a lock or a promise that
tool handlers must await — additional complexity with no benefit over eager startup.

**Why not D (disk cache):** Adds file I/O at startup, a cache invalidation strategy (how
does the server know the local dfx network was restarted?), and error handling for corrupt
cache files. The root key fetch is fast enough that caching provides no meaningful benefit.

---

## 17. Critical gaps identified (P0 before production use)

These are not deferred features — they are known failure modes with no current mitigation
that could cause fund loss or silent incorrect behaviour with real assets.

### Gap 1: t-ECDSA timeout leaves request state unknown

**Problem:** ICP threshold signing operations (used for ckBTC withdrawals and future native
Bitcoin signing) can take up to 30 seconds. If the `HttpAgent`'s HTTP request times out
before the signing response arrives, the server has no way to determine whether the
transaction was submitted to the Bitcoin network or not. The in-session idempotency Set
records only *successful* broadcasts — a timed-out request leaves the Set empty and the
transaction state unknown.

**Failure scenario:** Claude calls `ckbtc_transfer` (future tool). The t-ECDSA signing
takes 28 seconds. The HTTP request times out at 25 seconds. Claude retries the call. The
ICP subnet is still processing the first request. Depending on timing, zero, one, or two
transactions may be submitted. There is no way for the server to tell.

**Options for fix:**
- Persist the ICP request ID to disk before sending the signing request, then poll
  `agent.fetchCertifiedResponse(requestId)` on recovery. This is the correct solution.
- Use a nonce-based approach: include a unique nonce in the transfer memo and check the
  on-chain transaction history before retrying. Requires an additional canister query.

### Gap 2: EVM error JSON embedded in ic-evm-rpc responses *(resolved in v0.2.0)*

**Problem:** The ic-evm-rpc canister sometimes returns EVM JSON-RPC errors as
JSON-encoded strings inside Candid text fields rather than in the standard JSON-RPC `error`
key. The `extractEvmResult()` function handles the known pattern, but the canister's error
format has not been exhaustively catalogued. Edge cases could cause raw JSON error strings
to reach Claude as tool output rather than being converted to a structured `McpError`.

**Resolution (v0.2.0):** All known EVM RPC canister error shapes have been enumerated and
tested. `extractEvmResult()` now handles the full set of observed patterns. Test cases
cover the common revert case, nested JSON strings, and unknown formats (which are safely
re-raised as `McpError` with the raw content preserved for inspection).

### Gap 3: No cycles budget cap

**Problem:** ICP query calls cost no cycles, but any update calls (ckToken transfers, future
t-ECDSA signing) do cost cycles. There is no per-request or per-session cycles spending
limit. A runaway Claude session — for example, a loop that repeatedly calls a write tool
due to a planning error — could exhaust the ICP identity's cycles balance entirely.

**Failure scenario:** A Claude session enters a tool-calling loop due to a malformed
instruction. It calls `ckbtc_transfer` 200 times before the user notices. Each call costs
cycles. The identity's cycles balance is drained.

**Fix:** Add a `MAX_CYCLES_PER_SESSION` config variable (default: a conservative small
amount). Track cycles spent per session in a counter. Reject write tool calls once the
session budget is exhausted, returning a clear error to Claude.
