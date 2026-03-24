import { describe, it, expect } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { toMcpError, extractEvmResult } from '../src/errors.js';

describe('toMcpError', () => {
  it('handles ReplicaRejectError code 3 (CanisterReject)', () => {
    const err = { reject_code: 3, reject_message: 'insufficient funds' };
    const result = toMcpError(err, 'test');
    expect(result).toBeInstanceOf(McpError);
    expect(result.code).toBe(ErrorCode.InternalError);
    expect(result.message).toContain('Canister rejected');
    expect(result.message).toContain('insufficient funds');
  });

  it('handles ReplicaRejectError code 4 (DestinationInvalid)', () => {
    const err = { reject_code: 4, reject_message: 'canister not found' };
    const result = toMcpError(err);
    expect(result.code).toBe(ErrorCode.InvalidParams);
    expect(result.message).toContain('Canister not found');
  });

  it('handles ReplicaRejectError code 5 (CanisterError/trap)', () => {
    const err = { reject_code: 5, reject_message: 'Panicked at index out of bounds' };
    const result = toMcpError(err);
    expect(result.code).toBe(ErrorCode.InternalError);
    expect(result.message).toContain('Canister trapped');
  });

  it('handles EVM JSON-RPC error object', () => {
    const err = { code: -32603, message: 'execution reverted: ERC20: insufficient allowance' };
    const result = toMcpError(err);
    expect(result).toBeInstanceOf(McpError);
    expect(result.message).toContain('EVM error');
    expect(result.message).toContain('insufficient allowance');
  });

  it('passes through existing McpError unchanged', () => {
    const original = new McpError(ErrorCode.InvalidParams, 'bad params');
    expect(toMcpError(original)).toBe(original);
  });

  it('wraps a standard Error', () => {
    const err = new Error('something went wrong');
    const result = toMcpError(err, 'context');
    expect(result.message).toContain('[context]');
    expect(result.message).toContain('something went wrong');
  });

  it('handles unknown thrown values', () => {
    const result = toMcpError('raw string error');
    expect(result).toBeInstanceOf(McpError);
    expect(result.message).toContain('raw string error');
  });

  it('prefixes message with context when provided', () => {
    const err = new Error('fail');
    const result = toMcpError(err, 'bitcoin_get_balance');
    expect(result.message).toMatch(/\[bitcoin_get_balance\]/);
  });
});

describe('extractEvmResult', () => {
  it('returns parsed result from { result: ... } shape', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' });
    expect(extractEvmResult<string>(raw)).toBe('0x1');
  });

  it('throws when response contains an error field', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'reverted' },
    });
    expect(() => extractEvmResult(raw)).toThrow();
  });

  it('returns non-JSON strings as-is', () => {
    expect(extractEvmResult<string>('plain text')).toBe('plain text');
  });

  it('returns plain JSON values that are not error/result wrappers', () => {
    const raw = JSON.stringify({ foo: 'bar' });
    expect(extractEvmResult<{ foo: string }>(raw)).toEqual({ foo: 'bar' });
  });
});
