import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpAgent } from '@dfinity/agent';
import type { Config } from './config.js';
import { registerBitcoinTools } from './tools/bitcoin.js';
import { registerEthereumTools } from './tools/ethereum.js';
import { registerCkTokenTools } from './tools/cktokens.js';

export function createServer(config: Config, agent: HttpAgent): McpServer {
  const server = new McpServer({
    name: 'chain-fusion-mcp-server',
    version: '0.1.0',
  });

  registerBitcoinTools(server, { btcApiUrl: config.btcApiUrl });
  registerEthereumTools(server, { ethRpcUrl: config.ethRpcUrl });
  registerCkTokenTools(server, agent);

  return server;
}
