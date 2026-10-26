import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRestClient, readConfig } from './client.js';
import { registerTools } from './tools.js';

// stdio MCP server for teachers (docs/mcp-teacher-api.md). stdout is the protocol: everything else goes to stderr.
// This file must not import src/config/env.ts (it needs Slack tokens and a database URL, and dotenv may print).
let config: ReturnType<typeof readConfig>;
try {
  config = readConfig(process.env);
} catch (err) {
  console.error(`retain-mcp: ${(err as Error).message}`);
  process.exit(1);
}

const api = createRestClient(config);
serveStdio(() => {
  const server = new McpServer({ name: 'retain', version: '0.1.0' });
  registerTools(server, api);
  return server;
});
console.error(`retain-mcp: ready, API at ${new URL(config.baseUrl).origin}`);
