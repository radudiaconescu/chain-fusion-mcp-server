# TODOS

## Chain Fusion

**Add ckBTC/ckETH transfer tools (PR 2)**
- **Priority:** P1
- **What:** `ckbtc_transfer`, `cketh_transfer` using `@dfinity/ledger-icrc` ICRC-1 approve+transfer flow.
- **Why:** Completes the cross-chain bridging value prop — Claude can move value between chains without custodians.
- **Context:** ckBTC minter on mainnet: `mqygn-kiaaa-aaaar-qaadq-cai`. Use ICRC-2 approve before transfer to avoid double-spend. Needs simulate-first guard and idempotency hash.
- **Depends on:** PR 1 merged

**Fix 3 critical gaps before enabling writes in production**
- **Priority:** P0
- **What:** (1) t-ECDSA request ID persistence to disk before signing so Claude can recover after timeout. (2) EVM error detection for ic-evm-rpc canister embedded JSON errors. (3) Cycles budget config to prevent runaway API spend.
- **Why:** Without these, a 30s ICP signing timeout leaves Claude with no recovery path and no info on whether the tx was submitted.
- **Context:** Identified in eng review failure modes analysis. The idempotency hash in this PR covers the duplicate-broadcast case but not the timeout-before-response case.
- **Depends on:** Nothing — can be done in parallel

**Add generic ICP canister tool**
- **Priority:** P2
- **What:** `icp_canister_query(canisterId, method, argsJson)` and `icp_canister_update(...)` using Candid runtime encoding.
- **Why:** Makes the server a universal ICP interface — Claude can interact with any deployed canister, not just hardcoded ones.
- **Context:** Requires Candid runtime arg encoding (didc WASM or `@dfinity/candid` programmatic API). Fetch the canister's .did interface first, then encode args. The main challenge is surfacing encoding errors helpfully to Claude.
- **Depends on:** PR 1 merged

**Add unit tests for cktokens.ts**
- **Priority:** P2
- **What:** Mock `IcrcLedgerCanister.create()` and test `cktoken_get_balance` handler — balance formatting, subaccount hex parsing, invalid principal error path.
- **Why:** The ckToken balance formatting (decimals for ckBTC=8, ckETH=18, ckUSDC=6) is currently untested in unit form.
- **Depends on:** Nothing

**Add Ed25519 PEM parsing unit tests**
- **Priority:** P2
- **What:** Test `identityFromPem()` with a fixture PEM, invalid PEM, and secp256k1 PEM (should throw with helpful message).
- **Why:** Identity loading is the most critical startup path — a failure here breaks every tool.
- **Depends on:** Nothing

## Completed