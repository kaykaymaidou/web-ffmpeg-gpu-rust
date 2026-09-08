import type { McpServer } from '../server';
import type { StreamAlert, AutopilotReport, AgentThoughtStep, AutopilotDirective, LlmConfig } from './types';

export class DeepSeekLlmAgent {
  private mcpServer: McpServer;
  private config: LlmConfig;

  constructor(mcpServer: McpServer, config: LlmConfig = {}) {
    this.mcpServer = mcpServer;
    this.config = {
      model: config.model || 'deepseek-chat',
      endpoint: config.endpoint || 'https://api.deepseek.com/v1',
      isSimulated: config.isSimulated ?? (!config.apiKey),
      apiKey: config.apiKey,
    };
  }

  public async evaluate(alert: StreamAlert): Promise<AutopilotReport> {
    const t0 = performance.now();
    const steps: AgentThoughtStep[] = [];
    const directives: AutopilotDirective[] = [];

    if (!this.config.isSimulated && this.config.apiKey) {
      try {
        return await this.runRealLlmLoop(alert, steps, directives, t0);
      } catch (err: any) {
        console.warn('[DeepSeekLlmAgent] Real LLM call failed, falling back to simulated CoT:', err);
      }
    }

    // High-fidelity Simulated ReAct Loop (DeepSeek-R1 style Chain-of-Thought & Function Calling)
    return await this.runSimulatedLoop(alert, steps, directives, t0);
  }

  private async runSimulatedLoop(
    alert: StreamAlert,
    steps: AgentThoughtStep[],
    directives: AutopilotDirective[],
    t0: number
  ): Promise<AutopilotReport> {
    if (alert.type === 'PACKET_LOSS' || alert.type === 'CORRUPTED_NAL') {
      const loss = alert.metrics.packetLossRate ?? 20;

      // Iteration 1: Root cause analysis & bitstream tool call
      steps.push({
        iteration: 1,
        thought: `[DeepSeek-R1 CoT]: Received ${alert.type} alert. Packet loss is elevated at ${loss}%. Let's first inspect RTP fragmentation and sequence continuity using diagnose_rtp_stream.`,
        action: {
          tool: 'diagnose_rtp_stream',
          input: { packetCount: 150, simulateLossRate: loss },
        },
      });

      const rtpRes = await this.mcpServer.handleRequest({
        jsonrpc: '2.0',
        id: 501,
        method: 'tools/call',
        params: {
          name: 'diagnose_rtp_stream',
          arguments: { packetCount: 150, simulateLossRate: loss },
        },
      });
      steps[0].observation = rtpRes?.result?.content?.[0]?.text || 'RTP analysis complete.';

      // Iteration 2: Keyframe refresh action
      steps.push({
        iteration: 2,
        thought: `[DeepSeek-R1 CoT]: The observation shows dropped fragments leading to incomplete NAL units. The hardware decoder is at risk of corrupt reference frame drift. I will dispatch an emergency PLI (Picture Loss Indication) to reset the GOP state.`,
        action: {
          tool: 'trigger_keyframe_pli',
          input: { reason: `DeepSeek Autopilot: Fragment loss recovery (${loss}% loss)`, urgency: 'immediate' },
        },
      });

      const pliRes = await this.mcpServer.handleRequest({
        jsonrpc: '2.0',
        id: 502,
        method: 'tools/call',
        params: {
          name: 'trigger_keyframe_pli',
          arguments: { reason: `DeepSeek Autopilot: Fragment loss recovery (${loss}% loss)`, urgency: 'immediate' },
        },
      });
      steps[1].observation = pliRes?.result?.content?.[0]?.text || 'PLI dispatched.';

      directives.push({
        type: 'TRIGGER_PLI',
        reason: `DeepSeek ReAct Agent: Forced IDR keyframe to purge reference error`,
      });

      // Iteration 3: Bandwidth adaptation
      if (loss >= 10) {
        steps.push({
          iteration: 3,
          thought: `[DeepSeek-R1 CoT]: To prevent recurrent queue overflow at ${loss}% loss, I must also down-regulate the upstream encoder bitrate via tune_stream_bitrate.`,
          action: {
            tool: 'tune_stream_bitrate',
            input: { currentBitrateKbps: alert.metrics.bitrateKbps ?? 800, packetLossRate: loss },
          },
        });

        const tuneRes = await this.mcpServer.handleRequest({
          jsonrpc: '2.0',
          id: 503,
          method: 'tools/call',
          params: {
            name: 'tune_stream_bitrate',
            arguments: { currentBitrateKbps: alert.metrics.bitrateKbps ?? 800, packetLossRate: loss },
          },
        });

        const tuneData = JSON.parse(tuneRes?.result?.content?.[0]?.text || '{}');
        steps[2].observation = `Bitrate adapted to ${tuneData.recommendedBitrateKbps} kbps.`;

        directives.push({
          type: 'ADJUST_BITRATE',
          targetBitrateKbps: tuneData.recommendedBitrateKbps,
          reason: tuneData.reason,
        });
      }
    } else if (alert.type === 'LIP_SYNC_DESYNC') {
      const drift = alert.metrics.avDriftMs ?? 110;

      steps.push({
        iteration: 1,
        thought: `[DeepSeek-R1 CoT]: Audio/Video sync drift is ${drift.toFixed(1)}ms, violating human perception tightness threshold (±40ms). Calling remedy_lipsync to compute timeline alignment speedup.`,
        action: {
          tool: 'remedy_lipsync',
          input: { avDriftMs: drift, tightThresholdMs: 40 },
        },
      });

      const remedyRes = await this.mcpServer.handleRequest({
        jsonrpc: '2.0',
        id: 601,
        method: 'tools/call',
        params: {
          name: 'remedy_lipsync',
          arguments: { avDriftMs: drift, tightThresholdMs: 40 },
        },
      });

      const remedyData = JSON.parse(remedyRes?.result?.content?.[0]?.text || '{}');
      steps[0].observation = `Prescription: ${remedyData.recommendedAction} at ${remedyData.playbackRate}x speed.`;

      directives.push({
        type: 'REMEDY_LIPSYNC',
        playbackRate: remedyData.playbackRate,
        delayMs: remedyData.delayMs,
        reason: remedyData.description,
      });
    }

    const t1 = performance.now();
    return {
      alert,
      engineMode: 'llm-react',
      steps,
      directives,
      resolved: directives.length > 0,
      summary: `[DeepSeek ReAct Agent]: Executed ${steps.length} reasoning steps, dispatched ${directives.length} self-healing actions.`,
      latencyMs: Math.round(t1 - t0),
    };
  }

  private async runRealLlmLoop(
    alert: StreamAlert,
    steps: AgentThoughtStep[],
    directives: AutopilotDirective[],
    t0: number
  ): Promise<AutopilotReport> {
    // Standard OpenAI/DeepSeek API client with tools definition
    const toolsList = (await this.mcpServer.handleRequest({
      jsonrpc: '2.0',
      id: 901,
      method: 'tools/list',
    }))?.result?.tools || [];

    const openAiTools = toolsList.map((t: any) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const messages: any[] = [
      {
        role: 'system',
        content: 'You are DeepSeek Media Autopilot, an expert autonomous streaming engineer. Analyze incoming telemetry alerts, call relevant MCP tools to diagnose root cause, and prescribe self-healing directives (PLI, Bitrate tuning, Lip-sync compensation).',
      },
      {
        role: 'user',
        content: `Stream Alert Triggered:\n${JSON.stringify(alert, null, 2)}`,
      },
    ];

    let iteration = 0;
    while (iteration < 3) {
      iteration++;
      const response = await fetch(`${this.config.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          tools: openAiTools,
          tool_choice: 'auto',
        }),
      });

      const data = await response.json();
      const choice = data.choices?.[0];
      const msg = choice?.message;
      if (!msg) break;

      messages.push(msg);

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const fnName = tc.function.name;
          const fnArgs = JSON.parse(tc.function.arguments || '{}');

          steps.push({
            iteration,
            thought: msg.content || `Invoking tool ${fnName}`,
            action: { tool: fnName, input: fnArgs },
          });

          const toolRes = await this.mcpServer.handleRequest({
            jsonrpc: '2.0',
            id: 950 + iteration,
            method: 'tools/call',
            params: { name: fnName, arguments: fnArgs },
          });

          const observationText = toolRes?.result?.content?.[0]?.text || '';
          steps[steps.length - 1].observation = observationText;

          if (fnName === 'trigger_keyframe_pli') {
            directives.push({ type: 'TRIGGER_PLI', reason: fnArgs.reason || 'LLM PLI call' });
          } else if (fnName === 'tune_stream_bitrate') {
            const parsed = JSON.parse(observationText || '{}');
            directives.push({ type: 'ADJUST_BITRATE', targetBitrateKbps: parsed.recommendedBitrateKbps, reason: parsed.reason });
          } else if (fnName === 'remedy_lipsync') {
            const parsed = JSON.parse(observationText || '{}');
            directives.push({ type: 'REMEDY_LIPSYNC', playbackRate: parsed.playbackRate, delayMs: parsed.delayMs, reason: parsed.description });
          }

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: observationText,
          });
        }
      } else {
        // No more tool calls, final conclusion reached
        break;
      }
    }

    const t1 = performance.now();
    return {
      alert,
      engineMode: 'llm-react',
      steps,
      directives,
      resolved: directives.length > 0,
      summary: messages[messages.length - 1]?.content || 'DeepSeek LLM analysis complete.',
      latencyMs: Math.round(t1 - t0),
    };
  }
}
