import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/**
 * Converts any thrown value into a structured McpError.
 *
 * Error normalization hierarchy:
 *
 *   thrown value
 *       │
 *       ├─ ReplicaRejectError (ICP) ──► reject_code → specific message
 *       │       code 3: CanisterReject
 *       │       code 4: DestinationInvalid (canister not found)
 *       │       code 5: CanisterError (trap)
 *       │
 *       ├─ EVM JSON-RPC error object ─► code + message
 *       │
 *       ├─ fetch/network TypeError ──► network error message
 *       │
 *       ├─ Error instance ───────────► err.message
 *       │
 *       └─ unknown ──────────────────► String(err)
 */
export function toMcpError(err: unknown, context?: string): McpError {
  const prefix = context ? `[${context}] ` : '';

  // Must check McpError before isEvmRpcError — McpError has both code and message fields
  if (err instanceof McpError) {
    return err;
  }

  if (isReplicaRejectError(err)) {
    const msg = err.reject_message ?? String(err);
    switch (err.reject_code) {
      case 3:
        return new McpError(ErrorCode.InternalError, `${prefix}Canister rejected: ${msg}`);
      case 4:
        return new McpError(ErrorCode.InvalidParams, `${prefix}Canister not found: ${msg}`);
      case 5:
        return new McpError(ErrorCode.InternalError, `${prefix}Canister trapped: ${msg}`);
      default:
        return new McpError(ErrorCode.InternalError, `${prefix}ICP error (code ${err.reject_code}): ${msg}`);
    }
  }

  if (isEvmRpcError(err)) {
    return new McpError(ErrorCode.InternalError, `${prefix}EVM error (${err.code}): ${err.message}`);
  }

  if (err instanceof TypeError && err.message.toLowerCase().includes('fetch')) {
    return new McpError(ErrorCode.InternalError, `${prefix}Network error: ${err.message}`);
  }

  if (err instanceof Error) {
    return new McpError(ErrorCode.InternalError, `${prefix}${err.message}`);
  }

  return new McpError(ErrorCode.InternalError, `${prefix}Unknown error: ${String(err)}`);
}

function isReplicaRejectError(
  err: unknown,
): err is { reject_code: number; reject_message?: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'reject_code' in err &&
    typeof (err as Record<string, unknown>).reject_code === 'number'
  );
}

function isEvmRpcError(err: unknown): err is { code: number; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'message' in err &&
    typeof (err as Record<string, unknown>).code === 'number' &&
    typeof (err as Record<string, unknown>).message === 'string'
  );
}

/**
 * Parses an Ethereum JSON-RPC response body, throwing if it contains an error field.
 *
 * The ic-evm-rpc canister embeds EVM errors in several shapes:
 *
 *   Shape 1 — standard JSON-RPC error object:
 *     { "error": { "code": -32000, "message": "..." } }
 *
 *   Shape 2 — error embedded as a JSON string (canister Candid → string wrapping):
 *     "{ \"error\": { \"code\": -32000, \"message\": \"...\" } }"
 *
 *   Shape 3 — plain text error string (no JSON):
 *     "execution reverted"
 *
 *   Shape 4 — error message string directly (not wrapped in object):
 *     "{ \"code\": -32000, \"message\": \"...\" }"
 */
export function extractEvmResult<T>(responseBody: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    // Shape 3: plain text — not JSON at all, return as-is
    return responseBody as T;
  }

  // Shape 2: the parsed value is itself a string — unwrap one level of JSON encoding
  if (typeof parsed === 'string') {
    return extractEvmResult<T>(parsed);
  }

  if (parsed && typeof parsed === 'object') {
    // Shape 1: standard { error: ... } wrapper
    if ('error' in parsed) {
      throw (parsed as { error: unknown }).error;
    }

    // Shape 4: bare error object { code, message } without wrapper
    if ('code' in parsed && 'message' in parsed) {
      throw parsed;
    }

    if ('result' in parsed) {
      return (parsed as { result: T }).result;
    }
  }

  return parsed as T;
}
