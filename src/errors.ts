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
 * The ic-evm-rpc canister sometimes embeds EVM errors as JSON strings inside Candid —
 * this handles both the direct object case and the stringified case.
 */
export function extractEvmResult<T>(responseBody: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return responseBody as T;
  }

  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    throw (parsed as { error: unknown }).error;
  }

  if (parsed && typeof parsed === 'object' && 'result' in parsed) {
    return (parsed as { result: T }).result;
  }

  return parsed as T;
}
