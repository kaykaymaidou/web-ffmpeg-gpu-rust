export type AgentEngineMode = 'rules-engine' | 'llm-react';

export type AlertType =
  | 'PACKET_LOSS'
  | 'LIP_SYNC_DESYNC'
  | 'BITSTREAM_ERROR'
  | 'VRAM_SPIKE';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface StreamAlert {
  type: AlertType;
  severity: AlertSeverity;
  source: string;
  metrics: {
    packetLossRate?: number;
    rttMs?: number;
    avDriftMs?: number;
    fps?: number;
    bitrateKbps?: number;
    failCode?: string;
    [key: string]: any;
  };
  timestamp: number;
}

export interface AgentAction {
  tool: string;
  input: Record<string, any>;
}

export interface AgentThoughtStep {
  iteration: number;
  thought: string;
  action?: AgentAction;
  observation?: string;
}

export type DirectiveType =
  | 'TRIGGER_PLI'
  | 'ADJUST_BITRATE'
  | 'REMEDY_LIPSYNC'
  | 'SALVAGE_TRANSCODE'
  | 'DROP_NON_IDR'
  | 'NONE';

export interface AutopilotDirective {
  type: DirectiveType;
  reason: string;
  payload: Record<string, any>;
  playbackRate?: number;
  delayMs?: number;
  targetBitrateKbps?: number;
  timestamp: number;
}

export interface AutopilotReport {
  alert: StreamAlert;
  resolved: boolean;
  engineMode: AgentEngineMode;
  steps: AgentThoughtStep[];
  directives: AutopilotDirective[];
  durationMs: number;
}

export type AgentEventType =
  | 'step_start'
  | 'thought'
  | 'action'
  | 'observation'
  | 'directive'
  | 'report_finish';

export interface AgentEvent {
  type: AgentEventType;
  data: any;
  timestamp: number;
}

export type AgentEventListener = (event: AgentEvent) => void;

export interface LlmConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxIterations?: number;
}

export interface MediaAutopilotOptions {
  engineMode?: AgentEngineMode;
  llmConfig?: LlmConfig;
  onThought?: (step: AgentThoughtStep) => void;
  onDirective?: (directive: AutopilotDirective) => void;
  onReport?: (report: AutopilotReport) => void;
}
