//! # Chain Fusion MCP Canister
//!
//! An ICP canister implementing 3 Chain Fusion read-only tools via the MCP JSON-RPC protocol.
//! Uses `ic-cdk` directly — icarus-cdk was not used because its `linkme::distributed_slice`
//! tool-registration mechanism is incompatible with `wasm32-unknown-unknown`.
//!
//! ## MCP endpoints (Candid)
//!
//! ```text
//! mcp_server_info()            -> text   [query]   — server metadata
//! mcp_list_tools()             -> text   [query]   — JSON tool list
//! mcp_call_tool(request: text) -> text   [update]  — JSON-RPC dispatch
//! ```
//!
//! ## Tools
//!
//! | Tool | Description | Backend |
//! |------|-------------|---------|
//! | `bitcoin_get_balance` | Confirmed BTC balance for an address | ICP Bitcoin canister |
//! | `bitcoin_get_fee_rates` | Current sat/vB fee rates | Mempool.space HTTPS outcall |
//! | `cktoken_get_balance` | ckBTC / ckETH / ckUSDC balance | ICRC-1 ledger canister |
//!
//! ## Architecture
//!
//! ```text
//! Claude Desktop
//!      │ MCP (JSON-RPC over stdio/SSE — bridge TBD)
//!      ▼
//! chain-fusion-mcp-canister (ICP)
//!      │ inter-canister call        │ HTTPS outcall
//!      ▼                            ▼
//! ICP Bitcoin canister         Mempool.space
//! ICRC-1 ledger canisters
//! ```

use candid::{CandidType, Nat, Principal};
use ic_cdk::management_canister::{HttpHeader, HttpMethod, HttpRequestArgs, http_request};
use serde::Deserialize;

// ─────────────────────────────────────────────
// Canister IDs
// ─────────────────────────────────────────────

const BTC_CANISTER_MAINNET: &str = "ghsi2-tqaaa-aaaan-aaaca-cai";
const BTC_CANISTER_TESTNET: &str = "g4xu7-jiaaa-aaaan-aaaaq-cai";

fn cktoken_canister_id(token: &str) -> Result<&'static str, String> {
    match token.to_lowercase().as_str() {
        "ckbtc" => Ok("mxzaz-hqaaa-aaaar-qaada-cai"),
        "cketh" => Ok("ss2fx-dyaaa-aaaar-qacoq-cai"),
        "ckusdc" => Ok("xevnm-gaaaa-aaaar-qafnq-cai"),
        other => Err(format!("Unknown token '{other}'. Supported: ckBTC, ckETH, ckUSDC")),
    }
}

fn token_decimals(token: &str) -> (u32, &'static str) {
    match token.to_lowercase().as_str() {
        "ckbtc" => (8, "ckBTC"),
        "cketh" => (18, "ckETH"),
        "ckusdc" => (6, "ckUSDC"),
        _ => (8, "unknown"),
    }
}

// ─────────────────────────────────────────────
// ICP Bitcoin canister Candid types
//
// IDL: @icp-sdk/canisters/declarations/ckbtc/bitcoin.idl.js
//   type network = variant { mainnet; testnet; regtest };  ← LOWERCASE
//   type get_balance_request = record { network; address; min_confirmations };
//
// IMPORTANT: Candid variant names hash by string. "mainnet" ≠ "Mainnet".
// #[serde(rename)] ensures the Rust enum encodes to the correct lowercase hash.
// ─────────────────────────────────────────────

#[derive(CandidType, Deserialize, Clone)]
enum BitcoinNetwork {
    #[serde(rename = "mainnet")]
    Mainnet,
    #[serde(rename = "testnet")]
    Testnet,
    #[serde(rename = "regtest")]
    Regtest,
}

#[derive(CandidType, Deserialize)]
struct GetBalanceRequest {
    address: String,
    network: BitcoinNetwork,
    min_confirmations: Option<u32>,
}

// ─────────────────────────────────────────────
// ICRC-1 types
//   type Account = record { owner : principal; subaccount : opt blob };
// ─────────────────────────────────────────────

#[derive(CandidType, Deserialize)]
struct Icrc1Account {
    owner: Principal,
    subaccount: Option<Vec<u8>>,
}

// ─────────────────────────────────────────────
// Tool argument structs (JSON-deserialized from mcp_call_tool request)
// ─────────────────────────────────────────────

#[derive(Deserialize)]
struct BitcoinGetBalanceArgs {
    address: String,
    network: String,
}

#[derive(Deserialize)]
struct BitcoinGetFeeRatesArgs {
    network: String,
}

#[derive(Deserialize)]
struct CktokenGetBalanceArgs {
    token: String,
    principal: String,
    subaccount: Option<String>,
}

// ─────────────────────────────────────────────
// MCP JSON-RPC request/response types
// ─────────────────────────────────────────────

#[derive(Deserialize)]
struct McpRequest {
    #[serde(default)]
    id: serde_json::Value,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

fn mcp_success(id: &serde_json::Value, result: serde_json::Value) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
    .to_string()
}

fn mcp_error(id: &serde_json::Value, code: i32, message: String) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
    .to_string()
}

// ─────────────────────────────────────────────
// Tool: bitcoin_get_balance
// ─────────────────────────────────────────────

async fn tool_bitcoin_get_balance(args_json: &serde_json::Value) -> Result<String, String> {
    let args: BitcoinGetBalanceArgs =
        serde_json::from_value(args_json.clone()).map_err(|e| format!("Bad args: {e}"))?;

    let (btc_network, canister_id) = match args.network.to_lowercase().as_str() {
        "mainnet" => (BitcoinNetwork::Mainnet, BTC_CANISTER_MAINNET),
        "testnet" => (BitcoinNetwork::Testnet, BTC_CANISTER_TESTNET),
        other => return Err(format!("Unknown network '{other}'. Use: mainnet or testnet")),
    };

    let request = GetBalanceRequest {
        address: args.address.clone(),
        network: btc_network,
        min_confirmations: None,
    };

    // ic_cdk::call is deprecated in 0.18; upgrade path: ic_cdk::call::Call::unbounded_wait()
    #[allow(deprecated)]
    let (balance,): (u64,) = ic_cdk::call(
        Principal::from_text(canister_id).map_err(|e| e.to_string())?,
        "bitcoin_get_balance",
        (request,),
    )
    .await
    .map_err(|(code, msg)| format!("ICP call failed ({code:?}): {msg}"))?;

    Ok(serde_json::json!({
        "address": args.address,
        "network": args.network,
        "balance_satoshi": balance,
        "balance_btc": format!("{:.8}", balance as f64 / 100_000_000.0),
    })
    .to_string())
}

// ─────────────────────────────────────────────
// Tool: bitcoin_get_fee_rates
// ─────────────────────────────────────────────

async fn tool_bitcoin_get_fee_rates(args_json: &serde_json::Value) -> Result<String, String> {
    let args: BitcoinGetFeeRatesArgs =
        serde_json::from_value(args_json.clone()).map_err(|e| format!("Bad args: {e}"))?;

    let base_url = match args.network.to_lowercase().as_str() {
        "mainnet" => "https://mempool.space/api",
        "testnet" => "https://mempool.space/testnet/api",
        other => return Err(format!("Unknown network '{other}'. Use: mainnet or testnet")),
    };

    let request = HttpRequestArgs {
        url: format!("{base_url}/v1/fees/recommended"),
        method: HttpMethod::GET,
        headers: vec![HttpHeader {
            name: "Accept".to_string(),
            value: "application/json".to_string(),
        }],
        body: None,
        max_response_bytes: Some(512),
        transform: None,
    };

    let response = http_request(&request)
        .await
        .map_err(|e| format!("HTTPS outcall failed: {e}"))?;

    if response.status != 200u128 {
        return Err(format!("Mempool.space returned HTTP {}", response.status));
    }

    String::from_utf8(response.body).map_err(|e| format!("Non-UTF-8 response: {e}"))
}

// ─────────────────────────────────────────────
// Tool: cktoken_get_balance
// ─────────────────────────────────────────────

async fn tool_cktoken_get_balance(args_json: &serde_json::Value) -> Result<String, String> {
    let args: CktokenGetBalanceArgs =
        serde_json::from_value(args_json.clone()).map_err(|e| format!("Bad args: {e}"))?;

    let canister_id = cktoken_canister_id(&args.token)?;
    let (decimals, symbol) = token_decimals(&args.token);

    let owner = Principal::from_text(&args.principal)
        .map_err(|e| format!("Invalid principal '{}': {e}", args.principal))?;

    let subaccount_bytes: Option<Vec<u8>> = match args.subaccount.as_deref() {
        None | Some("") => None,
        Some(hex) => {
            if hex.len() != 64 {
                return Err("subaccount must be exactly 64 hex characters (32 bytes)".to_string());
            }
            (0..32)
                .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16))
                .collect::<Result<Vec<u8>, _>>()
                .map(Some)
                .map_err(|e| format!("Invalid hex in subaccount: {e}"))?
        }
    };

    let account = Icrc1Account {
        owner,
        subaccount: subaccount_bytes,
    };

    // ic_cdk::call is deprecated in 0.18; upgrade path: ic_cdk::call::Call::unbounded_wait()
    #[allow(deprecated)]
    let (balance,): (Nat,) = ic_cdk::call(
        Principal::from_text(canister_id).map_err(|e| e.to_string())?,
        "icrc1_balance_of",
        (account,),
    )
    .await
    .map_err(|(code, msg)| format!("ICP call failed ({code:?}): {msg}"))?;

    Ok(serde_json::json!({
        "token": symbol,
        "principal": args.principal,
        "balance_raw": balance.0.to_string(),
        "decimals": decimals,
        "note": format!("Divide balance_raw by 10^{decimals} for the human-readable {symbol} amount."),
    })
    .to_string())
}

// ─────────────────────────────────────────────
// Tool registry — static list used by mcp_list_tools
// ─────────────────────────────────────────────

fn tool_list_json() -> serde_json::Value {
    serde_json::json!({
        "tools": [
            {
                "name": "bitcoin_get_balance",
                "description": "Get confirmed Bitcoin balance for an address in satoshis and BTC",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "address": { "type": "string", "description": "Bitcoin address" },
                        "network": { "type": "string", "enum": ["mainnet", "testnet"], "description": "Bitcoin network" }
                    },
                    "required": ["address", "network"]
                }
            },
            {
                "name": "bitcoin_get_fee_rates",
                "description": "Get Bitcoin fee rates (sat/vB) for various confirmation speeds from Mempool.space",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "network": { "type": "string", "enum": ["mainnet", "testnet"], "description": "Bitcoin network" }
                    },
                    "required": ["network"]
                }
            },
            {
                "name": "cktoken_get_balance",
                "description": "Get ckBTC / ckETH / ckUSDC token balance for an ICP principal",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "token": { "type": "string", "enum": ["ckBTC", "ckETH", "ckUSDC"], "description": "Token name" },
                        "principal": { "type": "string", "description": "ICP principal in textual format" },
                        "subaccount": { "type": "string", "description": "Optional 64 hex chars (32-byte subaccount)" }
                    },
                    "required": ["token", "principal"]
                }
            }
        ]
    })
}

// ─────────────────────────────────────────────
// MCP Candid endpoints
// ─────────────────────────────────────────────

/// Returns server metadata (MCP protocol).
#[ic_cdk::query]
fn mcp_server_info() -> String {
    serde_json::json!({
        "name": "chain-fusion-mcp-canister",
        "description": "Chain Fusion read-only tools: BTC balance, fee rates, ckToken balances",
        "version": "0.1.0",
        "protocol_version": "2024-11-05",
        "capabilities": { "tools": {} }
    })
    .to_string()
}

/// Returns the list of available MCP tools.
#[ic_cdk::query]
fn mcp_list_tools() -> String {
    tool_list_json().to_string()
}

/// Executes an MCP tool call (JSON-RPC 2.0 request → response).
///
/// Request format:
/// ```json
/// { "jsonrpc": "2.0", "id": "1", "method": "tools/call",
///   "params": { "name": "bitcoin_get_balance", "arguments": { "address": "...", "network": "mainnet" } } }
/// ```
#[ic_cdk::update]
async fn mcp_call_tool(request_json: String) -> String {
    let req: McpRequest = match serde_json::from_str(&request_json) {
        Ok(r) => r,
        Err(e) => {
            return mcp_error(
                &serde_json::Value::Null,
                -32700,
                format!("Parse error: {e}"),
            )
        }
    };

    let id = &req.id;

    // Support both "tools/call" (MCP spec) and direct tool name for convenience
    if req.method != "tools/call" && req.method != "call_tool" {
        return mcp_error(
            id,
            -32601,
            format!("Unknown method '{}'. Use 'tools/call'.", req.method),
        );
    }

    let tool_name = req
        .params
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let args = req
        .params
        .get("arguments")
        .cloned()
        .unwrap_or(serde_json::Value::Object(Default::default()));

    let result = match tool_name {
        "bitcoin_get_balance" => tool_bitcoin_get_balance(&args).await,
        "bitcoin_get_fee_rates" => tool_bitcoin_get_fee_rates(&args).await,
        "cktoken_get_balance" => tool_cktoken_get_balance(&args).await,
        other => Err(format!("Unknown tool '{other}'")),
    };

    match result {
        Ok(text) => mcp_success(
            id,
            serde_json::json!({ "content": [{ "type": "text", "text": text }] }),
        ),
        Err(msg) => mcp_error(id, -32603, msg),
    }
}

// Export Candid interface
candid::export_service!();

#[ic_cdk::query(name = "__get_candid_interface_tmp_hack")]
fn export_candid() -> String {
    __export_service()
}

// ─────────────────────────────────────────────
// Unit tests (synchronous helpers only)
// ─────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cktoken_canister_id() {
        assert!(cktoken_canister_id("ckBTC").is_ok());
        assert!(cktoken_canister_id("ckbtc").is_ok());
        assert!(cktoken_canister_id("ckETH").is_ok());
        assert!(cktoken_canister_id("ckUSDC").is_ok());
        assert!(cktoken_canister_id("ckSOL").is_err());
    }

    #[test]
    fn test_token_decimals() {
        assert_eq!(token_decimals("ckbtc").0, 8);
        assert_eq!(token_decimals("cketh").0, 18);
        assert_eq!(token_decimals("ckusdc").0, 6);
    }

    #[test]
    fn test_tool_list_has_three_tools() {
        let list = tool_list_json();
        let tools = list["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 3);
        let names: Vec<&str> = tools
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"bitcoin_get_balance"));
        assert!(names.contains(&"bitcoin_get_fee_rates"));
        assert!(names.contains(&"cktoken_get_balance"));
    }

    #[test]
    fn test_mcp_success_format() {
        let id = serde_json::json!("1");
        let result = mcp_success(&id, serde_json::json!({"foo": "bar"}));
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["id"], "1");
        assert_eq!(parsed["result"]["foo"], "bar");
    }

    #[test]
    fn test_mcp_error_format() {
        let id = serde_json::json!(42);
        let result = mcp_error(&id, -32603, "something failed".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["error"]["code"], -32603);
        assert_eq!(parsed["error"]["message"], "something failed");
    }

    #[test]
    fn test_subaccount_hex_parse() {
        let valid = "0".repeat(64);
        let bytes: Vec<u8> = (0..32)
            .map(|i| u8::from_str_radix(&valid[i * 2..i * 2 + 2], 16).unwrap())
            .collect();
        assert_eq!(bytes.len(), 32);
        assert!(bytes.iter().all(|&b| b == 0));
    }
}
