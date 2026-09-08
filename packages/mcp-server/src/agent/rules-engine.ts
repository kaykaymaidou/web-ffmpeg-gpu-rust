import type { McpServer } from '../server';
import type { StreamAlert, AutopilotReport, AgentThoughtStep, AutopilotDirective } from './types';

export class RulesExpertEngine {
  private mcpServer: McpServer;

  constructor(mcpServer: McpServer) {
    this.mcpServer = mcpServer;
  }

  public async evaluate(alert: StreamAlert): Promise<AutopilotReport> {
    const t0 = performance.now();
    const steps: AgentThoughtStep[] = [];
    const directives: AutopilotDirective[] = [];

    switch (alert.type) {
      case 'PACKET_LOSS':
      case 'CORRUPTED_NAL': {
        const loss = alert.metrics.packetLossRate ?? 15;
        const rtt = alert.metrics.rttMs ?? 50;
        const currentBitrate = alert.metrics.bitrateKbps ?? 800;

        // Step 1: Diagnose bitstream
        steps.push({
          iteration: 1,
          thought: `Packet loss alert triggered (${loss}% loss, FAIL-09 threat detected). Inspecting RTP fragmentation integrity and stream health.`,
          action: {
            tool: 'diagnose_rtp_stream',
            input: { packetCount: 100, simulateLossRate: loss },
          },
        });

        const rtpDiag = await this.mcpServer.handleRequest({
          jsonrpc: '2.0',
          id: 101,
          method: 'tools/call',
          params: {
            name: 'diagnose_rtp_stream',
            arguments: { packetCount: 100, simulateLossRate: loss },
          },
        });
        steps[0].observation = rtpDiag?.result?.content?.[0]?.text || 'RTP bitstream diagnostic completed.';

        // Step 2: Trigger PLI
        steps.push({
          iteration: 2,
          thought: `Fragment loss detected in active stream. Requesting immediate IDR keyframe to re-sync decoder state without freeze.`,
          action: {
            tool: 'trigger_keyframe_pli',
            input: { reason: `Autopilot self-healing: ${loss}% packet loss observed`, urgency: 'immediate' },
          },
        });

        const pliRes = await this.mcpServer.handleRequest({
          jsonrpc: '2.0',
          id: 102,
          method: 'tools/call',
          params: {
            name: 'trigger_keyframe_pli',
            arguments: { reason: `Autopilot self-healing: ${loss}% packet loss observed`, urgency: 'immediate' },
          },
        });
        steps[1].observation = pliRes?.result?.content?.[0]?.text || 'PLI dispatched.';

        directives.push({
          type: 'TRIGGER_PLI',
          reason: `Auto-dispatched PLI: recovering from ${loss}% packet loss`,
        });

        // Step 3: If severe loss, adapt bitrate
        if (loss >= 10) {
          steps.push({
            iteration: 3,
            thought: `Loss rate exceeds 10% threshold. Calculating adaptive bitrate down-regulation (ABR) to alleviate uplink buffer bloat.`,
            action: {
              tool: 'tune_stream_bitrate',
              input: { currentBitrateKbps: currentBitrate, packetLossRate: loss, networkRttMs: rtt },
            },
          });

          const tuneRes = await this.mcpServer.handleRequest({
            jsonrpc: '2.0',
            id: 103,
            method: 'tools/call',
            params: {
              name: 'tune_stream_bitrate',
              arguments: { currentBitrateKbps: currentBitrate, packetLossRate: loss, networkRttMs: rtt },
            },
          });

          const tuneData = JSON.parse(tuneRes?.result?.content?.[0]?.text || '{}');
          steps[2].observation = `Recommended bitrate: ${tuneData.recommendedBitrateKbps} kbps (${tuneData.reason})`;

          directives.push({
            type: 'ADJUST_BITRATE',
            targetBitrateKbps: tuneData.recommendedBitrateKbps,
            reason: tuneData.reason,
          });
        }
        break;
      }

      case 'LIP_SYNC_DESYNC': {
        const drift = alert.metrics.avDriftMs ?? 95;

        // Step 1: Diagnose Lip-Sync Drift
        steps.push({
          iteration: 1,
          thought: `A/V presentation drift alert (${drift.toFixed(1)}ms). Evaluating tight ±40ms threshold against Master Audio Clock.`,
          action: {
            tool: 'remedy_lipsync',
            input: { avDriftMs: drift, tightThresholdMs: 40 },
          },
        });

        const remedyRes = await this.mcpServer.handleRequest({
          jsonrpc: '2.0',
          id: 201,
          method: 'tools/call',
          params: {
            name: 'remedy_lipsync',
            arguments: { avDriftMs: drift, tightThresholdMs: 40 },
          },
        });

        const remedyData = JSON.parse(remedyRes?.result?.content?.[0]?.text || '{}');
        steps[0].observation = `Action prescribed: ${remedyData.recommendedAction} (rate: ${remedyData.playbackRate}x, delay: ${remedyData.delayMs}ms)`;

        directives.push({
          type: 'REMEDY_LIPSYNC',
          playbackRate: remedyData.playbackRate,
          delayMs: remedyData.delayMs,
          reason: remedyData.description,
        });
        break;
      }

      case 'BITRATE_CONGESTION': {
        const currentB = alert.metrics.bitrateKbps ?? 1200;
        const loss = alert.metrics.packetLossRate ?? 5;
        const rtt = alert.metrics.rttMs ?? 150;

        steps.push({
          iteration: 1,
          thought: `Congestion warning detected. Adjusting encoder target bitrate.`,
          action: {
            tool: 'tune_stream_bitrate',
            input: { currentBitrateKbps: currentB, packetLossRate: loss, networkRttMs: rtt },
          },
        });

        const tuneRes = await this.mcpServer.handleRequest({
          jsonrpc: '2.0',
          id: 301,
          method: 'tools/call',
          params: {
            name: 'tune_stream_bitrate',
            arguments: { currentBitrateKbps: currentB, packetLossRate: loss, networkRttMs: rtt },
          },
        });

        const tuneData = JSON.parse(tuneRes?.result?.content?.[0]?.text || '{}');
        steps[0].observation = `Adjusted to ${tuneData.recommendedBitrateKbps} kbps.`;

        directives.push({
          type: 'ADJUST_BITRATE',
          targetBitrateKbps: tuneData.recommendedBitrateKbps,
          reason: tuneData.reason,
        });
        break;
      }

      case 'STREAM_STALL': {
        steps.push({
          iteration: 1,
          thought: `Stream presentation stall detected. Dispatching immediate PLI pulse to revive video track.`,
          action: {
            tool: 'trigger_keyframe_pli',
            input: { reason: 'Stream stall detected', urgency: 'immediate' },
          },
        });

        await this.mcpServer.handleRequest({
          jsonrpc: '2.0',
          id: 401,
          method: 'tools/call',
          params: {
            name: 'trigger_keyframe_pli',
            arguments: { reason: 'Stream stall detected', urgency: 'immediate' },
          },
        });

        directives.push({
          type: 'TRIGGER_PLI',
          reason: 'Emergency PLI dispatched for stalled stream',
        });
        break;
      }
    }

    const t1 = performance.now();
    return {
      alert,
      engineMode: 'rules-engine',
      steps,
      directives,
      resolved: directives.length > 0,
      summary: `RulesExpertEngine generated ${directives.length} self-healing directives across ${steps.length} MCP reasoning steps.`,
      latencyMs: Math.round(t1 - t0),
    };
  }
}
