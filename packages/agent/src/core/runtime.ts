import type { ModelProvider, ChatMessage } from '../providers/types';
import type { ToolRegistry } from '../tools/registry';
import type { SessionTrajectory } from './trajectory';
import type { AutopilotDirective, StreamAlert } from './types';

export interface HarnessLoopOptions {
  maxIterations?: number;
}

export class HarnessRuntime {
  private provider: ModelProvider;
  private tools: ToolRegistry;
  private maxIterations: number;

  constructor(provider: ModelProvider, tools: ToolRegistry, options: HarnessLoopOptions = {}) {
    this.provider = provider;
    this.tools = tools;
    this.maxIterations = options.maxIterations || 5;
  }

  public setProvider(provider: ModelProvider): void {
    this.provider = provider;
  }

  public async runReActLoop(alert: StreamAlert, trajectory: SessionTrajectory): Promise<boolean> {
    const toolsSummary = this.tools.getToolsSummary();

    const userPrompt = `A media pipeline alert has occurred:
Alert Type: ${alert.type}
Severity: ${alert.severity}
Source: ${alert.source}
Metrics: ${JSON.stringify(alert.metrics)}
Timestamp: ${alert.timestamp}

Please diagnose the issue and execute necessary tools to resolve it.`;

    const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }];

    let iteration = 1;
    let resolved = false;

    while (iteration <= this.maxIterations && !resolved) {
      const completion = await this.provider.generateThoughtAndAction(messages, toolsSummary, iteration);

      // Record thought and action
      trajectory.recordThought(iteration, completion.thought, completion.action);

      if (completion.action) {
        // Record action
        trajectory.recordAction(iteration, completion.action.tool, completion.action.input);

        // Execute tool via registry
        const observation = await this.tools.executeTool(completion.action.tool, completion.action.input);
        trajectory.recordObservation(iteration, observation);

        // Map actions to directives
        const directive = this.mapActionToDirective(completion.action.tool, completion.action.input, observation);
        if (directive) {
          trajectory.recordDirective(directive);
        }

        // Append to chat context for next iteration
        messages.push({
          role: 'assistant',
          content: `Thought: ${completion.thought}\nAction: ${completion.action.tool}\nAction Input: ${JSON.stringify(completion.action.input)}`,
        });
        messages.push({
          role: 'user',
          content: `Observation: ${observation}`,
        });
      }

      if (completion.finalAnswer) {
        resolved = true;
        break;
      }

      iteration++;
    }

    return resolved;
  }

  private mapActionToDirective(tool: string, input: any, observationStr: string): AutopilotDirective | null {
    let obs: any = {};
    try {
      obs = JSON.parse(observationStr);
    } catch {}

    if (tool === 'trigger_keyframe_pli') {
      return {
        type: 'TRIGGER_PLI',
        reason: obs.directive?.reason || input.reason || 'Agent requested keyframe',
        payload: obs.directive?.payload || input,
        timestamp: Date.now(),
      };
    }

    if (tool === 'tune_stream_bitrate') {
      return {
        type: 'ADJUST_BITRATE',
        reason: obs.directive?.reason || 'Agent adjusted bitrate to alleviate congestion',
        payload: obs.directive?.payload || input,
        timestamp: Date.now(),
      };
    }

    if (tool === 'remedy_lipsync') {
      return {
        type: 'REMEDY_LIPSYNC',
        reason: obs.remedyStrategy || 'Agent prescribed lip-sync catchup',
        payload: obs,
        timestamp: Date.now(),
      };
    }

    if (tool === 'salvage_corrupted_mp4') {
      return {
        type: 'SALVAGE_TRANSCODE',
        reason: 'Agent salvaged truncated MP4 from raw mdat chunk',
        payload: obs,
        timestamp: Date.now(),
      };
    }

    return null;
  }
}
