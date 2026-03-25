import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when ICP_IDENTITY_PEM is missing', () => {
    delete process.env.ICP_IDENTITY_PEM;
    expect(() => loadConfig()).toThrow('ICP_IDENTITY_PEM');
  });

  it('returns defaults for optional fields', () => {
    process.env.ICP_IDENTITY_PEM = './identity.pem';
    const config = loadConfig();
    expect(config.icpNetwork).toBe('mainnet');
    expect(config.transport).toBe('stdio');
    expect(config.ssePort).toBe(3000);
    expect(config.cacheTtlMs).toBe(10_000);
    expect(config.ethRpcUrl).toBeUndefined();
    expect(config.btcApiUrl).toBeUndefined();
  });

  it('parses all fields from env vars', () => {
    process.env.ICP_IDENTITY_PEM = '/tmp/id.pem';
    process.env.ICP_NETWORK = 'testnet';
    process.env.MCP_TRANSPORT = 'sse';
    process.env.MCP_SSE_PORT = '4000';
    process.env.ETH_RPC_URL = 'https://eth.example.com';
    process.env.BTC_API_URL = 'https://btc.example.com';
    process.env.CACHE_TTL_MS = '5000';

    const config = loadConfig();
    expect(config.identityPemPath).toBe('/tmp/id.pem');
    expect(config.icpNetwork).toBe('testnet');
    expect(config.transport).toBe('sse');
    expect(config.ssePort).toBe(4000);
    expect(config.ethRpcUrl).toBe('https://eth.example.com');
    expect(config.btcApiUrl).toBe('https://btc.example.com');
    expect(config.cacheTtlMs).toBe(5000);
  });

  it('throws on invalid ICP_NETWORK value', () => {
    process.env.ICP_IDENTITY_PEM = './identity.pem';
    process.env.ICP_NETWORK = 'invalid';
    expect(() => loadConfig()).toThrow();
  });

  it('throws on invalid ETH_RPC_URL (not a URL)', () => {
    process.env.ICP_IDENTITY_PEM = './identity.pem';
    process.env.ETH_RPC_URL = 'not-a-url';
    expect(() => loadConfig()).toThrow();
  });

  it('cyclesBudgetE8s is undefined when CYCLES_BUDGET_E8S is not set', () => {
    process.env.ICP_IDENTITY_PEM = './identity.pem';
    delete process.env.CYCLES_BUDGET_E8S;
    const config = loadConfig();
    expect(config.cyclesBudgetE8s).toBeUndefined();
  });

  it('cyclesBudgetE8s is parsed from CYCLES_BUDGET_E8S', () => {
    process.env.ICP_IDENTITY_PEM = './identity.pem';
    process.env.CYCLES_BUDGET_E8S = '1000000000';
    const config = loadConfig();
    expect(config.cyclesBudgetE8s).toBe(1_000_000_000);
  });

  it('cyclesBudgetE8s is undefined when CYCLES_BUDGET_E8S is 0 (treat as unlimited)', () => {
    process.env.ICP_IDENTITY_PEM = './identity.pem';
    process.env.CYCLES_BUDGET_E8S = '0';
    const config = loadConfig();
    expect(config.cyclesBudgetE8s).toBeUndefined();
  });
});
