export type AgentEngineMode = 'rules-engine' | 'llm-react';

export type StreamAlertType =
  | 'PACKET_LOSS'
  | 'LIP_SYNC_DESYNC'
  | 'STREAM_STALL'
  | 'CORRUPTED_NAL'
  | 'BITRATE_CONGESTION';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface StreamAlert {
  type: StreamAlertType;
  severity: AlertSeverity;
  source: 'p2p-receiver' | 'p2p-sender' | 'loopback' | 'file-transcode';
  metrics: {
    packetLossRate?: number;
    avDriftMs?: number;
    fps?: number;
    bitrateKbps?: number;
    rttMs?: number;
    failCode?: string;
    details?: string;
  };
  timestamp: number;
}

export interface AgentThoughtStep {
  iteration: number;
  thought: string;
  action?: {
    tool: string;
    input: Record<string, any>;
  };
  observation?: string;
}

export type AutopilotDirectiveType =
  | 'ADJUST_BITRATE'
  | 'TRIGGER_PLI'
  | 'REMEDY_LIPSYNC'
  | 'RESCUE_MEDIA'
  | 'NOOP';

export interface AutopilotDirective {
  type: AutopilotDirectiveType;
  targetBitrateKbps?: number;
  playbackRate?: number;
  delayMs?: number;
  reason: string;
  payload?: any;
}

export interface AutopilotReport {
  alert: StreamAlert;
  engineMode: AgentEngineMode;
  steps: AgentThoughtStep[];
  directives: AutopilotDirective[];
  resolved: boolean;
  summary: string;
  latencyMs: number;
}

export interface LlmConfig {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  isSimulated?: boolean;
}

export interface MediaAutopilotOptions {
  engineMode?: AgentEngineMode;
  llmConfig?: LlmConfig;
  onThought?: (step: AgentThoughtStep) => void;
  onDirective?: (directive: AutopilotDirective) => void;
  onReport?: (report: AutopilotReport) => void;
}
