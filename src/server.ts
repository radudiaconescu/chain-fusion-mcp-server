import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpAgent } from '@icp-sdk/core/agent';
import type { Config } from './config.js';
import { CyclesBudget } from './cycles-budget.js';
import { registerBitcoinTools } from './tools/bitcoin.js';
import { registerEthereumTools } from './tools/ethereum.js';
import { registerCkTokenTools } from './tools/cktokens.js';
import { registerCkBtcMinterTools } from './tools/ckbtc-minter.js';

export function createServer(config: Config, agent: HttpAgent): McpServer {
  const server = new McpServer({
    name: 'chain-fusion-mcp-server',
    version: '0.1.0',
  });

  const budget = new CyclesBudget(config.cyclesBudgetE8s);

  registerBitcoinTools(server, { agent, btcApiUrl: config.btcApiUrl });
  registerEthereumTools(server, { ethRpcUrl: config.ethRpcUrl });
  registerCkTokenTools(server, agent, { budget });
  registerCkBtcMinterTools(server, agent, { budget });

  return server;
}
