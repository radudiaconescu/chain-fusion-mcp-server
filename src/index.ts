#!/usr/bin/env node

/**
 * Chain Fusion MCP Server
 *
 * Startup flow:
 *
 *   loadConfig()         ← env vars → validated Config object (fails fast)
 *       │
 *       ▼
 *   createAgent()        ← PEM file → Ed25519KeyIdentity → HttpAgent
 *       │                  fetchRootKey() for non-mainnet (eager, not lazy)
 *       ▼
 *   initCache()          ← LRU cache for read-only tool responses (10s TTL)
 *       │
 *       ▼
 *   createServer()       ← McpServer + register all tools
 *       │
 *       ├─ transport=stdio  → StdioServerTransport (Claude Desktop / CLI)
 *       ├─ transport=sse    → Express + SSEServerTransport (remote clients)
 *       └─ transport=both   → both transports simultaneously
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { loadConfig } from './config.js';
import { createAgent } from './identity.js';
import { initCache } from './cache.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  // ── 1. Config ──────────────────────────────────────────────────────────────
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // ── 2. ICP Agent ───────────────────────────────────────────────────────────
  let agent;
  try {
    agent = await createAgent(config);
  } catch (err) {
    console.error(`Startup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // ── 3. Cache ───────────────────────────────────────────────────────────────
  initCache(config.cacheTtlMs);

  // ── 4. MCP Server ──────────────────────────────────────────────────────────
  const server = createServer(config, agent);

  // ── 5. Transport ───────────────────────────────────────────────────────────
  if (config.transport === 'stdio' || config.transport === 'both') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stdio mode: process.stderr for logs so they don't pollute the MCP stream
    console.error('Chain Fusion MCP server running on stdio');
  }

  if (config.transport === 'sse' || config.transport === 'both') {
    await startSseServer(server, config.ssePort);
  }
}

async function startSseServer(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<void> {
  const app = express();
  app.use(express.json());

  // Active SSE transports keyed by session ID
  const transports: Record<string, SSEServerTransport> = {};

  app.get('/sse', (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;

    res.on('close', () => {
      delete transports[transport.sessionId];
    });

    // Each SSE connection gets its own server connection
    server.connect(transport).catch((err: unknown) => {
      console.error(`SSE connection error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query['sessionId'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({ error: 'Unknown sessionId' });
      return;
    }
    await transports[sessionId].handlePostMessage(req, res);
  });

  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.error(`Chain Fusion MCP server (SSE) listening on http://localhost:${port}`);
      resolve();
    });
  });
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
