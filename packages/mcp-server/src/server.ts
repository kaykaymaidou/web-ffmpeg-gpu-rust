import type { JsonRpcRequest, JsonRpcResponse, McpToolDefinition, McpToolResult } from './types';
import { probeToolDefinition, handleProbeMedia } from './tools/probe';
import { salvageToolDefinition, handleSalvageMp4 } from './tools/salvage';
import { transcodeToolDefinition, handleTranscodeVideo } from './tools/transcode';
import { jitterToolDefinition, handleDiagnoseJitter } from './tools/jitter';
import { rtpToolDefinition, handleDiagnoseRtpStream } from './tools/rtp';

export class McpServer {
  private tools: Map<string, { definition: McpToolDefinition; handler: (args: any) => Promise<McpToolResult> }> = new Map();

  constructor() {
    this.registerTool(probeToolDefinition, handleProbeMedia);
    this.registerTool(salvageToolDefinition, handleSalvageMp4);
    this.registerTool(transcodeToolDefinition, handleTranscodeVideo);
    this.registerTool(jitterToolDefinition, handleDiagnoseJitter);
    this.registerTool(rtpToolDefinition, handleDiagnoseRtpStream);
  }

  public registerTool(
    definition: McpToolDefinition,
    handler: (args: any) => Promise<McpToolResult>
  ): void {
    this.tools.set(definition.name, { definition, handler });
  }

  public async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const { id, method, params } = req;

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: {
              name: 'web-ffmpeg-gpu-mcp',
              version: '0.1.0',
            },
            capabilities: {
              tools: {},
            },
          },
        };

      case 'notifications/initialized':
        // Client acknowledgment notification, no response required
        return null;

      case 'ping':
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {},
        };

      case 'tools/list':
        const toolsList: McpToolDefinition[] = Array.from(this.tools.values()).map((t) => t.definition);
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            tools: toolsList,
          },
        };

      case 'tools/call':
        if (!params || !params.name) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: {
              code: -32602,
              message: 'Invalid params: tool name is required.',
            },
          };
        }

        const tool = this.tools.get(params.name);
        if (!tool) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: {
              code: -32601,
              message: `Unknown tool: ${params.name}`,
            },
          };
        }

        try {
          const result = await tool.handler(params.arguments || {});
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result,
          };
        } catch (err: any) {
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Tool execution failed: ${err.message || err}`,
                },
              ],
            },
          };
        }

      default:
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
    }
  }
}
