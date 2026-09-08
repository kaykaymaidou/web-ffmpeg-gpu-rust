import { ToolRegistry } from '../tools/registry';
import { SessionTrajectory } from '../core/trajectory';
import { HarnessRuntime } from '../core/runtime';
import { RulesExpertEngine } from '../rules/rules-engine';
import { SimulationProvider } from '../providers/simulation';
import { DeepSeekProvider } from '../providers/deepseek';
import type { ModelProvider } from '../providers/types';
import type {
  AgentEngineMode,
  AutopilotReport,
  MediaAutopilotOptions,
  StreamAlert,
} from '../core/types';
import {
  handleProbeMedia,
  handleSalvageMp4,
  handleTranscodeVideo,
  handleDiagnoseJitter,
  handleDiagnoseRtpStream,
  handleTuneBitrate,
  handleTriggerPli,
  handleRemedyLipsync,
} from '@web-ffmpeg-gpu/mcp-server';

export class MediaAutopilotAgent {
  private toolRegistry: ToolRegistry;
  private trajectory: SessionTrajectory;
  private runtime: HarnessRuntime;
  private rulesEngine: RulesExpertEngine;
  private provider: ModelProvider;
  private engineMode: AgentEngineMode = 'rules-engine';
  private options: MediaAutopilotOptions;
  private lastAlertTimestamp: number = 0;
  private alertCooldownMs: number = 1000;

  constructor(options: MediaAutopilotOptions = {}) {
    this.options = options;
    this.engineMode = options.engineMode || 'rules-engine';
    this.toolRegistry = new ToolRegistry();
    this.trajectory = new SessionTrajectory();
    this.rulesEngine = new RulesExpertEngine();

    // Setup default provider
    if (options.llmConfig?.apiKey) {
      this.provider = new DeepSeekProvider(options.llmConfig);
    } else {
      this.provider = new SimulationProvider();
    }

    this.runtime = new HarnessRuntime(this.provider, this.toolRegistry, {
      maxIterations: options.llmConfig?.maxIterations || 5,
    });

    // Wire trajectory events to options callbacks
    this.trajectory.subscribe((event) => {
      if (event.type === 'thought' && this.options.onThought) {
        this.options.onThought(event.data);
      } else if (event.type === 'directive' && this.options.onDirective) {
        this.options.onDirective(event.data);
      } else if (event.type === 'report_finish' && this.options.onReport) {
        this.options.onReport(event.data);
      }
    });

    this.registerBuiltinTools();
  }

  private registerBuiltinTools(): void {
    this.toolRegistry.registerTool({
      name: 'probe_media',
      description: 'Inspect media container metadata, track codecs, and flag structural corruption.',
      handler: handleProbeMedia,
    });

    this.toolRegistry.registerTool({
      name: 'salvage_corrupted_mp4',
      description: 'Rescue raw video samples from headless MP4 files missing the moov atom (FAIL-05).',
      handler: handleSalvageMp4,
    });

    this.toolRegistry.registerTool({
      name: 'transcode_video',
      description: 'Re-encode and package media with faststart streaming layout.',
      handler: handleTranscodeVideo,
    });

    this.toolRegistry.registerTool({
      name: 'diagnose_jitter_stream',
      description: 'Evaluate live jitter buffer queue depth and A/V drift.',
      handler: handleDiagnoseJitter,
    });

    this.toolRegistry.registerTool({
      name: 'diagnose_rtp_stream',
      description: 'Inspect RTP sequence unrolling, FU-A fragment drops, and NAL integrity.',
      handler: handleDiagnoseRtpStream,
    });

    this.toolRegistry.registerTool({
      name: 'tune_stream_bitrate',
      description: 'AIMD adaptive bitrate calculation for network congestion relief.',
      handler: handleTuneBitrate,
    });

    this.toolRegistry.registerTool({
      name: 'trigger_keyframe_pli',
      description: 'RFC 4585 PLI keyframe directive generation with backoff cooldown.',
      handler: handleTriggerPli,
    });

    this.toolRegistry.registerTool({
      name: 'remedy_lipsync',
      description: 'Prescribe pitch-safe 1.05x catchup or presentation delay hold for A/V drift.',
      handler: handleRemedyLipsync,
    });
  }

  public setEngineMode(mode: AgentEngineMode): void {
    this.engineMode = mode;
  }

  public getEngineMode(): AgentEngineMode {
    return this.engineMode;
  }

  public setProvider(provider: ModelProvider): void {
    this.provider = provider;
    this.runtime.setProvider(provider);
  }

  public getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  public getTrajectory(): SessionTrajectory {
    return this.trajectory;
  }

  /**
   * Continuous telemetry ingestion interface.
   * Automatically evaluates whether metrics warrant self-healing intervention.
   */
  public async feedTelemetry(
    source: string,
    metrics: {
      packetLossRate?: number;
      avDriftMs?: number;
      fps?: number;
      rttMs?: number;
      failCode?: string;
    }
  ): Promise<AutopilotReport | null> {
    const now = Date.now();
    if (now - this.lastAlertTimestamp < this.alertCooldownMs) {
      return null;
    }

    if (metrics.packetLossRate !== undefined && metrics.packetLossRate >= 8) {
      return this.diagnoseAlert({
        type: 'PACKET_LOSS',
        severity: metrics.packetLossRate >= 20 ? 'critical' : 'warning',
        source,
        metrics,
        timestamp: now,
      });
    }

    if (metrics.avDriftMs !== undefined && Math.abs(metrics.avDriftMs) > 40) {
      return this.diagnoseAlert({
        type: 'LIP_SYNC_DESYNC',
        severity: Math.abs(metrics.avDriftMs) > 200 ? 'critical' : 'warning',
        source,
        metrics,
        timestamp: now,
      });
    }

    if (metrics.failCode) {
      return this.diagnoseAlert({
        type: 'BITSTREAM_ERROR',
        severity: 'critical',
        source,
        metrics,
        timestamp: now,
      });
    }

    return null;
  }

  /**
   * Diagnose a structured alert and execute self-healing remediation.
   */
  public async diagnoseAlert(alert: StreamAlert): Promise<AutopilotReport> {
    this.lastAlertTimestamp = Date.now();
    this.trajectory.clear();

    if (this.engineMode === 'rules-engine') {
      const report = this.rulesEngine.evaluate(alert);
      for (const step of report.steps) {
        this.trajectory.recordThought(step.iteration, step.thought, step.action);
        if (step.action) {
          this.trajectory.recordAction(step.iteration, step.action.tool, step.action.input);
        }
      }
      for (const d of report.directives) {
        this.trajectory.recordDirective(d);
      }
      return this.trajectory.buildReport(alert, 'rules-engine', report.resolved);
    } else {
      const resolved = await this.runtime.runReActLoop(alert, this.trajectory);
      return this.trajectory.buildReport(alert, 'llm-react', resolved);
    }
  }
}
