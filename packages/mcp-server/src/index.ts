import { McpServer } from './server';
import type { JsonRpcRequest } from './types';

export * from './types';
export * from './server';
export * from './tools/probe';
export * from './tools/salvage';
export * from './tools/transcode';
export * from './tools/jitter';
export * from './tools/rtp';
export * from './tools/tune';

/**
 * Run standard JSON-RPC 2.0 stdio server loop when executed directly via CLI.
 */
export async function startStdioServer(): Promise<void> {
  if (typeof process === 'undefined') return;
  const readline = await import('node:readline');
  const server = new McpServer();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const request: JsonRpcRequest = JSON.parse(trimmed);
      const response = await server.handleRequest(request);

      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (err: any) {
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${err.message || err}`,
        },
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  });

  process.stderr.write('[web-ffmpeg-gpu-mcp] Server listening on stdio (JSON-RPC 2.0)\n');
}

// Auto-start if executed directly via Node CLI
if (
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    process.argv[1].endsWith('index.js'))
) {
  startStdioServer().catch((err) => {
    console.error('Failed to start MCP Stdio Server:', err);
  });
}
