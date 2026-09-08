export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelCompletionResult {
  thought: string;
  action?: {
    tool: string;
    input: Record<string, any>;
  };
  finalAnswer?: string;
}

export interface ModelProvider {
  name: string;
  generateThoughtAndAction(
    messages: ChatMessage[],
    toolsSummary: string,
    iteration: number
  ): Promise<ModelCompletionResult>;
}
