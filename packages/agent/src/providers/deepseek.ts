import type { ChatMessage, ModelCompletionResult, ModelProvider } from './types';
import type { LlmConfig } from '../core/types';

export class DeepSeekProvider implements ModelProvider {
  public name = 'deepseek-r1';
  private apiKey: string;
  private baseURL: string;
  private model: string;
  private temperature: number;

  constructor(config: LlmConfig = {}) {
    this.apiKey = config.apiKey || '';
    this.baseURL = config.baseURL || 'https://api.deepseek.com/v1';
    this.model = config.model || 'deepseek-reasoner';
    this.temperature = config.temperature ?? 0.2;
  }

  public async generateThoughtAndAction(
    messages: ChatMessage[],
    toolsSummary: string,
    _iteration: number
  ): Promise<ModelCompletionResult> {
    if (!this.apiKey) {
      throw new Error('DeepSeek API Key is required for live LLM mode. Please supply apiKey in LlmConfig.');
    }

    const systemPrompt: ChatMessage = {
      role: 'system',
      content: `You are the Web-FFmpeg-GPU Autopilot Decision Brain running on DeepSeek Harness (dsh).
Your goal is to inspect audio/video streaming telemetry and orchestrate self-healing remediations.
Available Tools:
${toolsSummary}

Always format your response using standard ReAct:
Thought: <your Chain-of-Thought reasoning>
Action: <tool_name>
Action Input: <JSON formatted parameters>
Final Answer: <resolution summary when no more actions needed>`,
    };

    const payload = {
      model: this.model,
      temperature: this.temperature,
      messages: [systemPrompt, ...messages],
    };

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`DeepSeek API request failed [${response.status}]: ${errText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const reasoningContent = data.choices?.[0]?.message?.reasoning_content || '';

    // Parse Thought, Action, Action Input
    const thought = reasoningContent
      ? `[DeepSeek-R1 CoT] ${reasoningContent}`
      : (content.match(/Thought:\s*(.*?)(?=\nAction|\nFinal Answer|$)/s)?.[1]?.trim() || content);

    const actionTool = content.match(/Action:\s*([a-zA-Z0-9_-]+)/)?.[1]?.trim();
    const actionInputStr = content.match(/Action Input:\s*(\{.*?\})/s)?.[1]?.trim();

    let actionInput: Record<string, any> = {};
    if (actionInputStr) {
      try {
        actionInput = JSON.parse(actionInputStr);
      } catch {}
    }

    const finalAnswer = content.match(/Final Answer:\s*(.*)/s)?.[1]?.trim();

    return {
      thought,
      action: actionTool ? { tool: actionTool, input: actionInput } : undefined,
      finalAnswer,
    };
  }
}
