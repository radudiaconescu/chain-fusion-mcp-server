import { z } from 'zod';

const ConfigSchema = z.object({
  identityPemPath: z.string({ required_error: 'ICP_IDENTITY_PEM is required' }).min(1, 'ICP_IDENTITY_PEM must not be empty'),
  icpNetwork: z.enum(['mainnet', 'testnet']).default('mainnet'),
  transport: z.enum(['stdio', 'sse', 'both']).default('stdio'),
  ssePort: z.coerce.number().int().positive().default(3000),
  icpNodeUrl: z.string().url().optional(),
  btcApiUrl: z.string().url().optional(),
  ethRpcUrl: z.string().url().optional(),
  cacheTtlMs: z.coerce.number().int().positive().default(10_000),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse({
    identityPemPath: process.env.ICP_IDENTITY_PEM,
    icpNetwork: process.env.ICP_NETWORK,
    transport: process.env.MCP_TRANSPORT,
    ssePort: process.env.MCP_SSE_PORT,
    icpNodeUrl: process.env.ICP_NODE_URL,
    btcApiUrl: process.env.BTC_API_URL,
    ethRpcUrl: process.env.ETH_RPC_URL,
    cacheTtlMs: process.env.CACHE_TTL_MS,
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration error:\n${issues}`);
  }

  return result.data;
}
