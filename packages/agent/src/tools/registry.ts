export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
  handler: (input: any) => Promise<any> | any;
}

/**
 * Tool Registry inspired by DeepSeek Harness (dsh).
 * Decouples tool definition and execution from the agent loop.
 */
export class ToolRegistry {
  private tools = new Map<string, AgentToolDefinition>();

  public registerTool(tool: AgentToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  public getTool(name: string): AgentToolDefinition | undefined {
    return this.tools.get(name);
  }

  public getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  public getToolsSummary(): string {
    const lines: string[] = [];
    for (const tool of this.tools.values()) {
      lines.push(`- ${tool.name}: ${tool.description}`);
    }
    return lines.join('\n');
  }

  public async executeTool(name: string, input: any): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return JSON.stringify({ error: `Tool "${name}" not found in registry.` });
    }

    try {
      const result = await tool.handler(input);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err: any) {
      return JSON.stringify({ error: `Execution error in tool "${name}": ${err.message || err}` });
    }
  }
}
