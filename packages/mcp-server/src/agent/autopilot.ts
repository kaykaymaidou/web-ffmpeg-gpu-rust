import { McpServer } from '../server';
import type {
  AgentEngineMode,
  StreamAlert,
  AutopilotReport,
  MediaAutopilotOptions,
  LlmConfig,
} from './types';
import { RulesExpertEngine } from './rules-engine';
import { DeepSeekLlmAgent } from './llm-provider';

export class MediaAutopilotAgent {
  private mcpServer: McpServer;
  private engineMode: AgentEngineMode = 'rules-engine';
  private rulesEngine: RulesExpertEngine;
  private llmAgent: DeepSeekLlmAgent;
  private options: MediaAutopilotOptions;
  private reportHistory: AutopilotReport[] = [];
  private lastAlertTimestamp: number = 0;
  private alertCooldownMs: number = 1000; // Prevent alert flooding

  constructor(options: MediaAutopilotOptions = {}) {
    this.options = options;
    this.mcpServer = new McpServer();
    this.engineMode = options.engineMode || 'rules-engine';
    this.rulesEngine = new RulesExpertEngine(this.mcpServer);
    this.llmAgent = new DeepSeekLlmAgent(this.mcpServer, options.llmConfig || {});
  }

  public setEngineMode(mode: AgentEngineMode): void {
    this.engineMode = mode;
  }

  public getEngineMode(): AgentEngineMode {
    return this.engineMode;
  }

  public setLlmConfig(config: LlmConfig): void {
    this.llmAgent = new DeepSeekLlmAgent(this.mcpServer, config);
  }

  public getMcpServer(): McpServer {
    return this.mcpServer;
  }

  public getHistory(): AutopilotReport[] {
    return [...this.reportHistory];
  }

  /**
   * Directly evaluate an explicit stream alert through the active engine.
   */
  public async diagnoseAlert(alert: StreamAlert): Promise<AutopilotReport> {
    let report: AutopilotReport;

    if (this.engineMode === 'rules-engine') {
      report = await this.rulesEngine.evaluate(alert);
    } else {
      report = await this.llmAgent.evaluate(alert);
    }

    // Fire callbacks
    for (const step of report.steps) {
      this.options.onThought?.(step);
    }
    for (const directive of report.directives) {
      this.options.onDirective?.(directive);
    }
    this.options.onReport?.(report);

    this.reportHistory.push(report);
    return report;
  }

  /**
   * Continuously feed telemetry metrics from P2P session or transcoder.
   * Automatically triggers an alert and remediation if metrics cross safety thresholds.
   */
  public async feedTelemetry(
    source: StreamAlert['source'],
    metrics: StreamAlert['metrics']
  ): Promise<AutopilotReport | null> {
    const now = Date.now();
    if (now - this.lastAlertTimestamp < this.alertCooldownMs) {
      return null;
    }

    let alert: StreamAlert | null = null;

    if ((metrics.packetLossRate ?? 0) >= 8 || metrics.failCode === 'FAIL-09') {
      alert = {
        type: 'PACKET_LOSS',
        severity: (metrics.packetLossRate ?? 0) >= 20 ? 'critical' : 'warning',
        source,
        metrics,
        timestamp: now,
      };
    } else if (metrics.avDriftMs !== undefined && Math.abs(metrics.avDriftMs) > 40) {
      alert = {
        type: 'LIP_SYNC_DESYNC',
        severity: Math.abs(metrics.avDriftMs) > 150 ? 'critical' : 'warning',
        source,
        metrics,
        timestamp: now,
      };
    } else if (metrics.failCode) {
      alert = {
        type: 'CORRUPTED_NAL',
        severity: 'critical',
        source,
        metrics,
        timestamp: now,
      };
    }

    if (alert) {
      this.lastAlertTimestamp = now;
      return await this.diagnoseAlert(alert);
    }

    return null;
  }
}
